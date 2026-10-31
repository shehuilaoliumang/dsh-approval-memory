/**
 * dsh-approval-memory — Host half.
 *
 * Remembers approvals the user already gave for a sandbox escalation, so the
 * exact same operation on the same workspace does not ask again.
 *
 * Two tiers, chosen by the `rememberAcrossSessions` config switch:
 *   - off (default): memory lives for one session only (RAM, dropped when the
 *     session is disposed or the app restarts).
 *   - on: memory is persisted per workspace under the profile directory; every
 *     workspace keeps its own file and never sees another workspace's rules.
 *
 * The plugin never widens the sandbox: it only answers approval requests that
 * were already routed through `ctx.approval` for a sandbox escalation
 * (`sandbox_permissions` + `justification` on the retried tool call). Identical
 * operation = same tool, same escalation target, same command / target path.
 */
import { createHash } from 'node:crypto'
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import path from 'node:path'

export const name = 'dsh-approval-memory'

const RULE_LIMIT = 200
const PENDING_LIMIT = 256
const STORAGE_VERSION = 1

/* ------------------------------------------------------------------ config */

const SCHEMA = {
  uid: 1,
  refs: {
    1: {
      type: 'boolean',
      meta: {
        default: false,
        description: '跨会话记住审批：按工作区保存已批准/已拒绝的同类操作，下次打开同一工作区时沿用（默认关闭，只在当前会话记住）。',
      },
    },
    2: {
      type: 'string',
      meta: {
        default: '',
        description: '审批记忆的存储目录；留空则使用当前 profile 目录下的 approval-memory。',
      },
    },
  },
}

const FIELDS = {
  rememberAcrossSessions: {
    type: 'boolean',
    meta: {
      default: false,
      description: '跨会话记住审批：按工作区保存已批准/已拒绝的同类操作，下次打开同一工作区时沿用（默认关闭，只在当前会话记住）。',
    },
  },
  storageDir: {
    type: 'string',
    meta: {
      default: '',
      description: '审批记忆的存储目录；留空则使用当前 profile 目录下的 approval-memory。',
    },
  },
}

export const Config = {
  ...SCHEMA,
  type: 'object',
  dict: FIELDS,
  meta: { default: {} },
  toJSON() {
    return SCHEMA
  },
  '~standard': {
    version: 1,
    vendor: 'dsh-approval-memory',
    validate(value) {
      // Validation must never throw: a rejected config would fail the startup
      // entry and take the whole app down at boot.
      return { value: settingsOf(value) }
    },
  },
}

export const inject = ['sessions', 'workingDirectory', 'commands']

function settingsOf(value) {
  const source = isRecord(value) ? value : {}
  return {
    rememberAcrossSessions: source.rememberAcrossSessions === true,
    storageDir: typeof source.storageDir === 'string' ? source.storageDir.trim() : '',
  }
}

/* ----------------------------------------------------------------- helpers */

function isRecord(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function sha256(text) {
  return createHash('sha256').update(text, 'utf8').digest('hex')
}

function normalizeCommand(text) {
  return text.trim().replace(/\s+/gu, ' ')
}

function normalizePath(target, baseDir) {
  const resolved = path.resolve(baseDir || process.cwd(), target)
  return process.platform === 'win32' ? resolved.toLowerCase() : resolved
}

function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`
  if (isRecord(value)) {
    const keys = Object.keys(value).sort()
    return `{${keys.map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`).join(',')}}`
  }
  const serialized = JSON.stringify(value)
  return serialized === undefined ? 'null' : serialized
}

/**
 * The identity of one remembered operation: same tool, same escalation target,
 * same actual action. Returns null when the call is not a sandbox escalation.
 */
function operationRule(toolName, args, workspaceDir) {
  if (!isRecord(args)) return null
  if (typeof args.sandbox_permissions !== 'string' || args.sandbox_permissions === '') return null
  if (typeof args.justification !== 'string' || args.justification.trim() === '') return null

  let signature = ''
  if (typeof args.command === 'string' && args.command.trim() !== '') {
    signature = `cmd:${normalizeCommand(args.command)}`
  } else if (typeof args.file_path === 'string' && args.file_path.trim() !== '') {
    signature = `path:${normalizePath(args.file_path, workspaceDir)}`
  } else if (typeof args.path === 'string' && args.path.trim() !== '') {
    signature = `path:${normalizePath(args.path, workspaceDir)}`
  } else if (typeof args.code === 'string' && args.code !== '') {
    signature = `code:${sha256(args.code)}`
  } else {
    const rest = {}
    for (const [key, value] of Object.entries(args)) {
      if (key === 'sandbox_permissions' || key === 'justification') continue
      rest[key] = value
    }
    signature = `json:${sha256(canonical(rest))}`
  }
  return {
    key: `${toolName}|${args.sandbox_permissions}|${signature}`,
    tool: toolName,
    mode: args.sandbox_permissions,
  }
}

function enforceLimit(rules) {
  while (rules.size > RULE_LIMIT) {
    const oldest = rules.keys().next().value
    if (oldest === undefined) break
    rules.delete(oldest)
  }
}

/**
 * Whether one call touches the memory store itself. Such calls are never
 * remembered: otherwise an agent could seed the store with pre-approved rules
 * and have this plugin widen its own trust later.
 */
function touchesStore(args, storageDir) {
  if (!isRecord(args) || storageDir === '') return false
  const needle = process.platform === 'win32' ? storageDir.toLowerCase() : storageDir
  for (const key of ['command', 'file_path', 'path', 'code']) {
    const value = args[key]
    if (typeof value !== 'string' || value === '') continue
    const haystack = process.platform === 'win32' ? value.toLowerCase() : value
    if (haystack.includes(needle)) return true
  }
  return false
}

/* ------------------------------------------------------------------- apply */

export function apply(ctx, config) {
  const settings = settingsOf(config)
  const defaultTier = settings.rememberAcrossSessions ? 'workspace' : 'session'
  let tier = defaultTier
  const storageDir = storageBase(settings)
  const sessionRules = new Map() // sessionId -> Map<ruleKey, 'allow' | 'reject'>
  const workspaceLoads = new Map() // hash -> Promise<Map<ruleKey, 'allow' | 'reject'>>
  const writeChains = new Map() // absolute file -> Promise<void>
  const pendingCalls = new Map() // callId -> { toolName, arguments, sessionId }

  if (tier === 'workspace') {
    console.log(`[dsh-approval-memory] workspace memory enabled, storage: ${storageDir}`)
  } else {
    console.log('[dsh-approval-memory] session memory only (rememberAcrossSessions is off)')
  }

  const note = (error) => {
    try {
      console.warn(`[dsh-approval-memory] ${error instanceof Error ? error.message : String(error)}`)
    } catch {
      /* logging must never fail the caller */
    }
  }

  const sessionOf = (agent) => {
    try {
      const id = agent && agent.id
      if (id === undefined || id === null) return undefined
      return typeof ctx.sessions?.get === 'function' ? ctx.sessions.get(id) : undefined
    } catch {
      return undefined
    }
  }

  const workspaceDirOf = (session) => {
    try {
      const cwd = session && session.header ? session.header.cwd : undefined
      if (typeof cwd === 'string' && cwd !== '') return path.resolve(cwd)
      if (session && typeof ctx.workingDirectory?.get === 'function') {
        const dir = ctx.workingDirectory.get(session)
        if (typeof dir === 'string' && dir !== '') return path.resolve(dir)
      }
    } catch {
      /* fall through */
    }
    return ''
  }

  const sessionMap = (sessionKey) => {
    let rules = sessionRules.get(sessionKey)
    if (!rules) {
      rules = new Map()
      sessionRules.set(sessionKey, rules)
    }
    return rules
  }

  const loadWorkspace = (hash) => {
    let loading = workspaceLoads.get(hash)
    if (!loading) {
      loading = (async () => {
        const file = path.join(storageDir, `${hash}.json`)
        try {
          const text = await readFile(file, 'utf8')
          const parsed = JSON.parse(text)
          const source = isRecord(parsed) && isRecord(parsed.rules) ? parsed.rules : {}
          const rules = new Map()
          for (const [key, value] of Object.entries(source)) {
            if (value === 'allow' || value === 'reject') rules.set(key, value)
          }
          enforceLimit(rules)
          return rules
        } catch (error) {
          if (!error || error.code !== 'ENOENT') note(error)
          return new Map()
        }
      })()
      workspaceLoads.set(hash, loading)
    }
    return loading
  }

  const saveWorkspace = async (hash, workspaceKey, rules) => {
    const file = path.join(storageDir, `${hash}.json`)
    const payload = `${JSON.stringify(
      {
        version: STORAGE_VERSION,
        workspace: workspaceKey,
        updatedAt: new Date().toISOString(),
        rules: Object.fromEntries(rules),
      },
      null,
      2,
    )}\n`
    const previous = writeChains.get(file) || Promise.resolve()
    const next = previous
      .then(async () => {
        await mkdir(storageDir, { recursive: true })
        const temporary = `${file}.tmp`
        await writeFile(temporary, payload, 'utf8')
        await rename(temporary, file)
      })
      .catch(note)
    writeChains.set(file, next)
    await next
  }

  /**
   * Resolve the rule store for one approval: the session map by default, or the
   * workspace file when cross-session memory is enabled.
   */
  const storeFor = async (sessionKey, workspaceDir) => {
    if (tier === 'workspace' && workspaceDir) {
      const workspaceKey = normalizePath(workspaceDir, workspaceDir)
      const hash = sha256(workspaceKey).slice(0, 16)
      const rules = await loadWorkspace(hash)
      return {
        kind: 'workspace',
        rules,
        save: () => saveWorkspace(hash, workspaceKey, rules),
      }
    }
    return { kind: 'session', rules: sessionMap(sessionKey), save: null }
  }

  /* ---------------------------------------------------- record tool calls */

  // Record the arguments of a call that carries a sandbox escalation, keyed by
  // callId. The approval request for the retried call carries the same callId.
  const recordCall = async (exec, next) => {
    try {
      if (exec && isRecord(exec.arguments)) {
        const args = exec.arguments
        const callId = exec.callId === undefined || exec.callId === null ? '' : String(exec.callId)
        if (
          callId !== '' &&
          typeof args.sandbox_permissions === 'string' &&
          args.sandbox_permissions !== '' &&
          typeof args.justification === 'string' &&
          args.justification.trim() !== ''
        ) {
          pendingCalls.set(callId, {
            toolName: String(exec.name),
            arguments: args,
            sessionId: exec.agent && exec.agent.id !== undefined && exec.agent.id !== null ? String(exec.agent.id) : '',
          })
          while (pendingCalls.size > PENDING_LIMIT) {
            const oldest = pendingCalls.keys().next().value
            if (oldest === undefined) break
            pendingCalls.delete(oldest)
          }
        }
      }
    } catch (error) {
      note(error)
    }
    return next()
  }

  const forgetCall = (exec) => {
    try {
      if (exec && exec.callId !== undefined && exec.callId !== null) pendingCalls.delete(String(exec.callId))
    } catch {
      /* ignore */
    }
  }

  /* -------------------------------------------------- answer approvals */

  const inspectRequest = async (request) => {
    const callId = request && request.callId !== undefined && request.callId !== null ? String(request.callId) : ''
    const pending = callId === '' ? undefined : pendingCalls.get(callId)
    if (!pending) return { kind: 'pass' }
    if (pending.toolName !== request.toolName) return { kind: 'pass' }
    const session = sessionOf(request.agent)
    const workspaceDir = workspaceDirOf(session)
    const rule = operationRule(request.toolName, pending.arguments, workspaceDir)
    if (!rule) return { kind: 'pass' }
    if (touchesStore(pending.arguments, storageDir)) return { kind: 'pass' }
    const sessionKey = session && session.id !== undefined && session.id !== null ? String(session.id) : ''
    if (sessionKey === '' && tier !== 'workspace') return { kind: 'pass' }
    const store = await storeFor(sessionKey, workspaceDir)
    const remembered = store.rules.get(rule.key)
    if (remembered === 'allow' || remembered === 'reject') {
      return { kind: 'reuse', allow: remembered === 'allow' }
    }
    return { kind: 'ask', rule, store, sessionKey }
  }

  const remember = async (inspected, decision) => {
    const { rule, store } = inspected
    if (!store) return
    store.rules.set(rule.key, decision)
    enforceLimit(store.rules)
    if (store.save) await store.save()
  }

  const onApproval = async (request, next) => {
    let inspected = { kind: 'pass' }
    try {
      inspected = await inspectRequest(request)
    } catch (error) {
      note(error)
    }
    if (inspected.kind === 'reuse') {
      return inspected.allow ? 'allowed-once' : 'rejected'
    }
    const outcome = await next()
    if (inspected.kind === 'ask' && (outcome === 'allowed-once' || outcome === 'rejected')) {
      try {
        await remember(inspected, outcome === 'allowed-once' ? 'allow' : 'reject')
      } catch (error) {
        note(error)
      }
    }
    return outcome
  }

  const onSessionDisposed = (session) => {
    try {
      const id = session && session.id !== undefined && session.id !== null ? String(session.id) : ''
      if (id === '') return
      sessionRules.delete(id)
      for (const [callId, pending] of pendingCalls) {
        if (pending.sessionId === id) pendingCalls.delete(callId)
      }
    } catch (error) {
      note(error)
    }
  }

  /* -------------------------------------------------- human command */

  const workspaceMemoryFile = (workspaceDir) => {
    const workspaceKey = normalizePath(workspaceDir, workspaceDir)
    const hash = sha256(workspaceKey).slice(0, 16)
    return { hash, file: path.join(storageDir, `${hash}.json`) }
  }

  const describeStatus = async (agent) => {
    const session = sessionOf(agent)
    const sessionKey = agent && agent.id !== undefined && agent.id !== null ? String(agent.id) : ''
    const sessionCount = sessionKey === '' ? 0 : sessionRules.get(sessionKey)?.size ?? 0
    const workspaceDir = workspaceDirOf(session)
    const lines = [
      `审批记忆档位：${tier === 'workspace' ? '跨会话档（按工作区持久）' : '会话档（仅本会话，不落盘）'}`,
      `当前会话已记规则：${sessionCount} 条`,
    ]
    if (workspaceDir !== '') {
      const { hash, file } = workspaceMemoryFile(workspaceDir)
      let workspaceCount = 0
      try {
        workspaceCount = (await loadWorkspace(hash)).size
      } catch (error) {
        note(error)
      }
      lines.push(
        `当前工作区已记规则：${workspaceCount} 条`,
        `工作区记忆文件：${file}`,
        `工作区路径：${workspaceDir}`,
      )
    }
    lines.push(
      '',
      '档位由设置里的「跨会话记住审批」决定；/approval-memory workspace 与 /approval-memory session 可临时切换（仅本次运行）。',
      '/approval-memory clear 清空当前会话与当前工作区的记忆。',
    )
    return { kind: 'success', text: lines.join('\n') }
  }

  const clearMemory = async (agent) => {
    const session = sessionOf(agent)
    const sessionKey = agent && agent.id !== undefined && agent.id !== null ? String(agent.id) : ''
    if (sessionKey !== '') sessionRules.delete(sessionKey)
    const workspaceDir = workspaceDirOf(session)
    if (workspaceDir === '') {
      return { kind: 'success', text: '已清空当前会话的审批记忆（该会话没有关联工作区，没有持久记忆需要清理）。' }
    }
    const { hash, file } = workspaceMemoryFile(workspaceDir)
    workspaceLoads.delete(hash)
    try {
      await rm(file, { force: true })
    } catch (error) {
      note(error)
    }
    return { kind: 'success', text: `已清空当前会话与当前工作区的审批记忆。\n工作区记忆文件：${file}` }
  }

  const onCommand = async (invocation) => {
    try {
      const raw = invocation && typeof invocation.rawInput === 'string' ? invocation.rawInput.trim() : ''
      const action = raw === '' ? 'status' : raw.split(/\s+/u)[0]
      if (action === 'status') return await describeStatus(invocation && invocation.agent)
      if (action === 'clear') return await clearMemory(invocation && invocation.agent)
      if (action === 'workspace') {
        tier = 'workspace'
        return {
          kind: 'success',
          text: '已切到跨会话档（仅本次运行有效）。要持久生效，请在 设置 → 插件 → 审批记忆 里打开「跨会话记住审批」。',
        }
      }
      if (action === 'session') {
        tier = 'session'
        return {
          kind: 'success',
          text: '已切到会话档（仅本次运行有效）。要持久生效，请在 设置 → 插件 → 审批记忆 里关闭「跨会话记住审批」。',
        }
      }
      return { kind: 'error', text: '用法：/approval-memory [status|clear|workspace|session]' }
    } catch (error) {
      return { kind: 'error', text: `审批记忆命令执行失败：${error instanceof Error ? error.message : String(error)}` }
    }
  }

  ctx.effect(() => {
    const disposers = [
      ctx.on('tools/pre-execute', recordCall, { prepend: true }),
      ctx.on('tools/result', forgetCall),
      ctx.on('approval/request', onApproval, { prepend: true }),
      ctx.on('session/disposed', onSessionDisposed),
      ctx.commands.register({
        name: 'approval-memory',
        description: '查看或清空审批记忆；workspace / session 可临时切换档位。',
        input: { hint: '[status|clear|workspace|session]' },
        handler: onCommand,
      }),
    ]
    return () => {
      for (const dispose of disposers) {
        try {
          if (typeof dispose === 'function') dispose()
        } catch {
          /* ignore */
        }
      }
    }
  })
}

function storageBase(settings) {
  if (settings.storageDir !== '') return path.resolve(settings.storageDir)
  const profileDir = process.env.DSH_PROFILE_DIR
  if (typeof profileDir === 'string' && profileDir.trim() !== '') {
    return path.join(profileDir.trim(), 'approval-memory')
  }
  return path.join(homedir(), '.dsh', 'approval-memory')
}
