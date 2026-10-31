# dsh-approval-memory

A [DeepSeek Harness](https://github.com/deepseek-ai) host plugin that remembers the sandbox-escalation approvals you already gave, so the same operation asks only once per session (default) or per workspace (opt-in).

DSH（DeepSeek Harness）审批记忆插件：沙箱越界重试的审批，同一类操作你点过一次「允许」之后不再反复询问；点过「拒绝」也记住。

它**不做自动审批**，也**不扩大沙箱**：沙箱仍是 `workspace-write`，越界写入照样被拒绝；插件只是复用你对某次越界重试的回答。

## 背景：为什么不是 Auto review

DSH 自带的实验包 `@deepseek-ai/dsh-experimental-auto-review`（Auto review）走的是另一条路：把会话切到 `danger-full-access`（无文件沙箱），用模型逐次审查工具调用。它确实能减少点击，但代价是丢掉操作系统级的文件沙箱。

本插件反过来：保留 `workspace-write` + `ask` 审批，只在「需要你审批的越界重试」上复用你上次的答案。它不介入其它审批（安装插件、问答等仍逐次询问）。

## 两档记忆

| 档位 | 配置 | 作用范围 | 存储 |
| --- | --- | --- | --- |
| 会话档（默认） | `rememberAcrossSessions: false` | 仅当前会话 | 内存，会话关闭 / 应用重启即失效 |
| 跨会话档 | `rememberAcrossSessions: true` | 按工作区跨会话 | `<profile>/approval-memory/<工作区哈希>.json` |

跨会话档每个工作区一个文件，互不污染；文件里记录工作区路径和规则，规则格式为「工具名 + 升级目标模式 + 操作签名」。

## 什么算「同类操作」

- 沙箱升级的目标模式相同（如 `danger-full-access`）；
- 工具相同；
- 操作相同：
  - shell 类（`command`）：空白规范化后的命令文本完全一致；
  - 文件类（`file_path` / `path`）：解析后的绝对路径一致（Windows 下大小写不敏感）；
  - 其它（如 `run_code` 的 `code`）：参数去掉 `sandbox_permissions` / `justification` 后稳定序列化哈希。

即：`npm test` 放行过一次，下次 `npm test` 不再问；`npm run build` 仍会再问一次。

## 安装

插件以本地 bundle 形式安装（bundle 自带 `cordis.patch.yml`，装好即全 profile 生效，不需要手改 profile）：

```powershell
# 在 DSH 里让 Agent 执行，target 换成插件目录的绝对路径
# plugin_manager action=install_bundle target=D:\path\to\dsh-approval-memory
```

卸载：

```powershell
# plugin_manager action=remove_bundle target=@local/dsh-approval-memory
```

## 使用

| 命令 | 作用 |
| --- | --- |
| `/approval-memory` | 查看档位、已记规则数、记忆文件路径 |
| `/approval-memory workspace` | 临时切到跨会话档（仅本次运行） |
| `/approval-memory session` | 临时切到会话档（仅本次运行） |
| `/approval-memory clear` | 清空当前会话与当前工作区的记忆 |

持久切换档位：设置 → 插件 → 审批记忆 → 「跨会话记住审批」。

插件代码更新后需要让正在运行的实例重新加载（DSH 中按重载/刷新按钮，或重启应用），仅改文件不会热替换已加载的 host 插件。

## 安全模型

- **只复用既有审批**：`tools/pre-execute` 记录带 `sandbox_permissions` + `justification` 的调用，`approval/request` 用同一个 `callId` 对上后才可能复用答案；对不上、参数缺失、非升级审批一律交给原生弹窗（fail closed）。
- **不制造权限**：插件返回的只有 `allowed-once` / `rejected`，从不自行发起执行，也不改变会话的沙箱模式或审批策略。
- **防自举**：任何命令/路径命中记忆存储目录的调用一律不记忆，避免 Agent 先把规则写进存储文件再借此自我放行。
- **不联网**：插件不发起网络请求，也不读取工作区内容做判断；只读自己写的规则文件。
- **存储位置**：跨会话规则只写在 profile 目录（`$DSH_PROFILE_DIR/approval-memory`，否则 `~/.dsh/approval-memory`），不写进你的工作区。

## 存储与清理

- 清空跨会话记忆：删除 `approval-memory` 目录，或 `/approval-memory clear`。
- 规则文件是可编辑的 JSON：任何能写 profile 目录的进程都能改它，请把它当作本地配置看待；不需要跨会话记忆时请关闭该档位。

## 已知限制

- 依赖审批请求携带与工具调用一致的 `callId`（DSH 内置工具满足；第三方工具若不带 `callId`，不会被复用）。
- 精确匹配：命令改一个字就会重新询问。
- 只对沙箱升级审批生效；其它审批不记忆。
- 会话档在应用重启后丢失（刻意的安全取舍）。
- 实验性 API：依赖 DSH 的 `tools/pre-execute`、`approval/request`、`commands` 等扩展点，DSH 版本升级后可能需要适配（开发时针对 0.2.1-rc.5 验证）。

## 开发与测试

```powershell
node --check index.js
node test/sim.mjs
```

`test/sim.mjs` 不依赖 DSH 运行时，用伪 ctx 直接驱动事件回调，覆盖：首问委托原生弹窗、同类复用、不同操作仍问、拒绝记忆、非升级审批不拦截、存储目录防自举、跨会话落盘与重启复用、斜杠命令。

CI：见 `.github/workflows/ci.yml`（Node 20/22/24）。

## 许可

MIT
