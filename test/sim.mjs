/**
 * Offline simulation for dsh-approval-memory (no harness needed).
 *
 * Run: node test/sim.mjs
 */
import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const plugin = await import(new URL('../index.js', import.meta.url).href)
const assert = (condition, message) => {
  if (!condition) throw new Error(`assertion failed: ${message}`)
  console.log(`  ok — ${message}`)
}

function makeCtx({ cwd }) {
  const listeners = new Map()
  const commands = []
  const sessions = {
    get(id) {
      return String(id) === 's1' ? { id: 's1', header: { cwd } } : undefined
    },
  }
  return {
    sessions,
    workingDirectory: { get: () => cwd },
    commands: {
      register(definition) {
        commands.push(definition)
        return () => {
          const index = commands.indexOf(definition)
          if (index >= 0) commands.splice(index, 1)
        }
      },
    },
    commandsOf() {
      return commands
    },
    on(event, fn, options) {
      const list = listeners.get(event) ?? []
      list.push({ fn, options })
      listeners.set(event, list)
      return () => {
        const current = listeners.get(event) ?? []
        const index = current.indexOf(list.at(-1))
        if (index >= 0) current.splice(index, 1)
      }
    },
    effect(fn) {
      fn()
    },
    listenersOf(event) {
      return (listeners.get(event) ?? []).map((entry) => entry.fn)
    },
  }
}

/** Invoke the plugin's approval listener the way the approval waterfall would. */
async function ask(ctx, { callId, toolName, answer }) {
  const handler = ctx.listenersOf('approval/request')[0]
  assert(typeof handler === 'function', 'approval/request listener registered')
  let delegated = 0
  const next = async () => {
    delegated += 1
    return answer
  }
  const outcome = await handler({ agent: { id: 's1' }, toolName, callId, reason: 'escalate sandbox to danger-full-access: need it' }, next)
  return { outcome, delegated }
}

async function recordCall(ctx, { callId, toolName, args }) {
  const handler = ctx.listenersOf('tools/pre-execute')[0]
  await handler({ callId, name: toolName, arguments: args, agent: { id: 's1' } }, async () => ({ kind: 'allow' }))
}

const escalationArgs = (command) => ({
  command,
  sandbox_permissions: 'danger-full-access',
  justification: 'need it for this task',
})

const cwd = process.cwd()

console.log('tier 1 — session memory (default config)')
{
  const ctx = makeCtx({ cwd })
  plugin.apply(ctx, {})
  const first = escalationArgs('npm test')
  await recordCall(ctx, { callId: 'c1', toolName: 'pwsh', args: first })
  let result = await ask(ctx, { callId: 'c1', toolName: 'pwsh', answer: 'allowed-once' })
  assert(result.delegated === 1 && result.outcome === 'allowed-once', 'first approval delegates to the native prompt')

  await recordCall(ctx, { callId: 'c2', toolName: 'pwsh', args: escalationArgs('npm test') })
  result = await ask(ctx, { callId: 'c2', toolName: 'pwsh', answer: 'allowed-once' })
  assert(result.delegated === 0 && result.outcome === 'allowed-once', 'identical second call is remembered (no prompt)')

  await recordCall(ctx, { callId: 'c3', toolName: 'pwsh', args: escalationArgs('npm run build') })
  result = await ask(ctx, { callId: 'c3', toolName: 'pwsh', answer: 'allowed-once' })
  assert(result.delegated === 1 && result.outcome === 'allowed-once', 'a different command still asks')

  await recordCall(ctx, { callId: 'c4', toolName: 'pwsh', args: escalationArgs('npm test') })
  result = await ask(ctx, { callId: 'c4', toolName: 'pwsh', answer: 'rejected' })
  assert(result.delegated === 0 && result.outcome === 'allowed-once', 'an allow rule survives until cleared')
}

console.log('tier 1 — rejection is remembered too')
{
  const ctx = makeCtx({ cwd })
  plugin.apply(ctx, {})
  await recordCall(ctx, { callId: 'd1', toolName: 'pwsh', args: escalationArgs('npm publish') })
  let result = await ask(ctx, { callId: 'd1', toolName: 'pwsh', answer: 'rejected' })
  assert(result.delegated === 1 && result.outcome === 'rejected', 'first rejection delegates')

  await recordCall(ctx, { callId: 'd2', toolName: 'pwsh', args: escalationArgs('npm publish') })
  result = await ask(ctx, { callId: 'd2', toolName: 'pwsh', answer: 'allowed-once' })
  assert(result.delegated === 0 && result.outcome === 'rejected', 'repeated rejected call is denied without asking')
}

console.log('non-escalation approvals are untouched')
{
  const ctx = makeCtx({ cwd })
  plugin.apply(ctx, {})
  const handler = ctx.listenersOf('approval/request')[0]
  let delegated = 0
  const outcome = await handler({ agent: { id: 's1' }, toolName: 'plugin_manager', callId: 'x1', reason: 'install a bundle' }, async () => {
    delegated += 1
    return 'allowed-once'
  })
  assert(delegated === 1 && outcome === 'allowed-once', 'ordinary approval always delegates')
}

console.log('the memory store cannot be pre-seeded')
{
  const dir = await mkdtemp(path.join(tmpdir(), 'approval-memory-store-'))
  process.env.DSH_PROFILE_DIR = dir
  try {
    const ctx = makeCtx({ cwd })
    plugin.apply(ctx, { rememberAcrossSessions: true })
    const seeded = escalationArgs(`pwsh -Command Set-Content '${path.join(dir, 'approval-memory', 'seeded.json')}' '{}'`)
    await recordCall(ctx, { callId: 's1', toolName: 'pwsh', args: seeded })
    let result = await ask(ctx, { callId: 's1', toolName: 'pwsh', answer: 'allowed-once' })
    assert(result.delegated === 1, 'touching the store still asks the first time')
    await recordCall(ctx, { callId: 's2', toolName: 'pwsh', args: seeded })
    result = await ask(ctx, { callId: 's2', toolName: 'pwsh', answer: 'allowed-once' })
    assert(result.delegated === 1, 'touching the store is never remembered')
  } finally {
    delete process.env.DSH_PROFILE_DIR
    await rm(dir, { recursive: true, force: true })
  }
}

console.log('tier 2 — workspace memory persists across restarts')
{
  const dir = await mkdtemp(path.join(tmpdir(), 'approval-memory-test-'))
  process.env.DSH_PROFILE_DIR = dir
  const config = { rememberAcrossSessions: true }
  try {
    {
      const ctx = makeCtx({ cwd })
      plugin.apply(ctx, config)
      await recordCall(ctx, { callId: 'w1', toolName: 'pwsh', args: escalationArgs('git push origin main') })
      const result = await ask(ctx, { callId: 'w1', toolName: 'pwsh', answer: 'allowed-once' })
      assert(result.delegated === 1 && result.outcome === 'allowed-once', 'workspace tier still asks the first time')
    }
    const storeDir = path.join(dir, 'approval-memory')
    const names = await readdir(storeDir)
    const text = await readFile(path.join(storeDir, names[0]), 'utf8')
    assert(text.includes('git push origin main'), 'workspace rule file was written')
    {
      const ctx = makeCtx({ cwd })
      plugin.apply(ctx, config)
      await recordCall(ctx, { callId: 'w2', toolName: 'pwsh', args: escalationArgs('git push origin main') })
      const result = await ask(ctx, { callId: 'w2', toolName: 'pwsh', answer: 'rejected' })
      assert(result.delegated === 0 && result.outcome === 'allowed-once', 'a fresh instance reuses the saved rule')
    }
  } finally {
    delete process.env.DSH_PROFILE_DIR
    await rm(dir, { recursive: true, force: true })
  }
}

console.log('slash command')
{
  const ctx = makeCtx({ cwd })
  plugin.apply(ctx, {})
  const command = ctx.commandsOf()[0]
  assert(command && command.name === 'approval-memory', 'command is registered')
  let result = await command.handler({ rawInput: '', agent: { id: 's1' } })
  assert(result.kind === 'success' && result.text.includes('会话档'), 'status reports the session tier')
  result = await command.handler({ rawInput: 'workspace', agent: { id: 's1' } })
  assert(result.kind === 'success' && result.text.includes('跨会话档'), 'runtime switch to workspace tier works')
  result = await command.handler({ rawInput: 'clear', agent: { id: 's1' } })
  assert(result.kind === 'success', 'clear succeeds')
}

console.log('\nall simulation checks passed')
void here
