# NextShell Agent 接入（MCP）—— 调研报告与实施方案

> 状态：**Phase 0 已落地（已提交 138c655）** / **Phase 1 已落地（本次提交）** / Phase 2–5 待实施
> 日期：2026-08-03
> 范围：`apps/desktop`(main / preload / renderer)、`packages/{shared,core,terminal,ssh,storage}`、`apps/mcp-ssh-proxy` 与 `packages/runtime`(已删除)、新增 `apps/mcp-bridge` 与独立插件仓库

## 实施状态

**Phase 0 已完成**（typecheck / lint 0 error / 460 + 34 测试全绿，均已独立复核）。落地内容与本文档的偏差：

| 项 | 计划 | 实际 |
| --- | --- | --- |
| `packages/runtime` | 保留目标解析 | 整包删除，解析逻辑移植为 `main/services/mcp/target-resolver.ts`（纯函数，吃 `ConnectionProfile[]`，**不含授权感知**——Gateway 必须在调用前过滤） |
| `command_search` | 检索命令历史 + 命令库 | **只返回命令库**。安全审查实测 `redactAuditMetadata` 对 8 种常见密码写法一字不脱敏，且 shell 历史无 connectionId 无法按主机限权，故 `listCommandHistory` 直接从 `AgentGatewayDeps` 移除（类型上够不着） |
| shim 分发 | `npx @nextshell/mcp-bridge` | 随应用分发（electron-builder `extraResources`），配置指向安装包内绝对路径 + `ELECTRON_RUN_AS_NODE=1`。该包保持 `private: true` 不发 npm |
| 限流键 | 每客户端 | `transport + clientInfo.name`（session id 会随重连刷新额度）。客户端自报名仍可伪造，真正的解法是 Phase 1 的按客户端审批 |
| `agentAccess` 入口 | 未明确 | 连接编辑表单「属性」页新增「Agent 授权」下拉；表单缺省一律提交 `"off"`（不是"保留已存值"），避免往返把主机留在可见状态 |

**Phase 0 未做**（有意）：`session_read` / `session_history`（依赖 Phase 1 OscTap 与 Phase 3 ScreenMirror，`tools/index.ts` 的 `AGENT_TOOL_REGISTRARS` 已留扩展位）；全部写类工具；应用内确认弹窗（偏好里的 `confirmWrites` / `confirmUnknownCommands` / `allowedLocalRoots` 暂未被消费，写类工具落地时必须接上）。

**已知遗留**（详见 §十）：`extraResources` 打包路径只做了配置接入，首次发版前需实跑一次 `dist` 确认 `resources/mcp-bridge/index.js` 落位；跨进程契约测试在 `pnpm run test:mcp-bridge` 下，根 `pnpm test` 不覆盖，CI 需单独接入；Windows 命名管道仍未实测。

**Phase 1 已完成**（typecheck 0 error / lint 0 error / 529 单测 + 34 契约测试全绿）。落地内容与本文档的偏差：

| 项 | 计划 | 实际 |
| --- | --- | --- |
| 1.0b bash 命令文本 | DEBUG trap | 改用 **PS0 + `__nextshell_preexec`**：PS0 在 bash 读完完整命令后展开一次，整条 pipeline 保留（DEBUG trap 对每个简单命令触发，会截断 pipeline）；`fc -ln -0` 取历史条目，`HISTCMD` 对比处理 `ignorespace` 下"不写入历史"的命令（避免回放上一条）。三套脚本均对命令文本做控制字符消毒（`__nextshell_sanitize_command` / fish `string replace`），命令只作数据、绝不作为 shell 源码求值 |
| 1.4 确认弹窗 | `nMessageBox` 模式 | 主进程 `AgentPromptBroker`（`confirm.ts`，显式 id 关联 + 5 分钟超时防悬挂）+ 渲染进程 antd `modal.confirm`，支持 confirm / select / text 三种 kind、`sensitive` 输入与「本客户端会话内始终允许」 |
| 1.5 连接建立 | 2FA 走 `ask_user` | 交互认证重试仅对 `password` / `interactive` 认证类型、且错误文本匹配 `auth|password|permission denied|userauth` 时触发，经 `promptUser`（`sensitive: true`，值不落库、不返回 agent）；钥匙串/主密码失败经 `classifyError` 快速返回固定错误码 |
| 1.7 活动面板 | renderer 新 slice | `useAgentActivityStore`（按 id 合并运行中条目，上限 100）+ `AgentActivityPanel` 挂在工作区侧边栏；事件经 `AgentActivityEvent` IPC 通道广播 |
| exec 审计 | 复用 `command.exec` | Gateway 写 `agent.exec`（redact 后的命令/输出），`CommandService.execCommand` 支持 `audit: false` 跳过双重记录 |
| exec cwd 回显 | 回显实际执行目录 | 经 `printf '\036NEXTSHELL_CWD=%s\037' "$PWD" >&2` 标记从 stderr 提取并剥离，agent 只见 `actualCwd` |
| 客户端审批 | 未明确 | `ensureClientApproved`：首次调用弹「新的 Agent 客户端请求接入」确认，同 MCP session 内记忆，断连即遗忘 |

**Phase 1 未做**（有意）：`session_read`（依赖 Phase 3 ScreenMirror）；`session_send_keys` / `session_open` 等 PTY 接管（Phase 4）；`notify_user` 只做了系统通知，未接入应用内消息中心。

**Phase 1 复审修正**（复审后单独提交，535 单测 + 34 契约测试全绿）。复审找出并修掉的五处真实缺陷：

| # | 缺陷 | 影响 | 修法 |
| --- | --- | --- | --- |
| 1 | 客户端审批被拒后不记忆，且 `execute` 把限流排在审批之后 | 被拒客户端每调一次工具就弹一次「新客户端接入」，可无限刷屏，反而把用户训练成闭眼点「允许」 | `deniedClients` 按 MCP 会话记住拒绝；限流提到审批之前——**任何会弹窗的路径都必须先花掉调用预算** |
| 2 | exec 的风险确认弹窗在 `execute` 之外，完全不受限流约束 | 同上，`rm -rf /` 刷 1000 次就是 1000 个模态框 | `execute` 改收 options 对象并新增 `preflight` 钩子（限流 → 审批 → 单主机并发 → preflight → 超时），exec 的确认搬进 preflight。Phase 2 的传输确认复用同一条通道 |
| 3 | OscTap 每会话保留上限 = 100 条 × 512KB ≈ **51MB**，主进程常驻 | 多开几个繁忙会话即撑爆主进程内存 | 新增每会话总保留预算 `OSC_TAP_MAX_SESSION_OUTPUT_BYTES`（2MB），超限时从最旧条目起释放输出正文、保留命令与退出码并标 `truncated`；最新一条永不释放 |
| 4 | `listSessions` 每会话调两次 `oscTaps.get()`，每次都克隆整段历史；而它在单次 gateway 调用里会被调多次 | 纯浪费，且随历史增长恶化 | 新增 `OscTap.getSummary()` / `OscTapRegistry.getSummary()`，只取 cwd 与 lastCommand；`OscTapRegistry.feed` 不再返回快照 |
| 5 | `session_list` 工具描述仍写着「cwd 在主进程会话跟踪落地前恒为 null」 | Agent 读到这句会主动忽略 cwd —— 直接废掉用例 C 的核心能力，也让 1.2 的 cwd 继承形同虚设 | 改为如实描述：cwd 来自 OSC 7、后台标签同样可信、仅在无 shell 集成时为 null，并点明可把 sessionId 直接当 exec 的 target |

---

## 一、结论（TL;DR）

现有 `apps/mcp-ssh-proxy` 之所以"没什么用"，不是做得不完整，而是**方向选错了**：它是一个由 MCP 客户端拉起的独立进程，自己读 `nextshell.db`、自己解密全部凭据、自己开 SSH 连接跑一次性 `exec`——桌面端开不开着都一样。它不是"NextShell 的 agent 接口"，而是"另一个持有你全部凭据的 SSH 客户端"。

本方案把 MCP server **搬进 Electron 主进程**，让 agent 操作的是**桌面端正在持有的那条连接、用户正在看的那个会话**：凭据一步不出应用，agent 只见 `connectionId`；人在 GUI 里实时看见 agent 的每一步，随时一键夺回。

三条设计主线：

| 主线 | 做法 |
| --- | --- |
| **接管而非旁路** | 复用 `ServiceContainer` 的连接池、跳板、host key 固定与会话上下文（含 OSC 7 跟踪的 cwd），而不是另开连接 |
| **能力面 = NextShell 的能力面** | exec / SFTP（含目录打包传输）/ 交互式 PTY / 监控快照 / 命令库 / 传输队列 / 弹窗问人，而不是只有 exec |
| **零配置接入** | 应用内点一下启用，Claude Code 侧装个插件即可，不粘 token、不填端口 |

技术上有一个**关键支点**：在主进程的终端数据抽头上补一层会话感知。当前主进程对终端输出**过手不留**，既不知道会话的当前目录，也不知道命令边界与退出码——这两样东西是 agent 能"接着人的上下文干活"的前提。该层拆成一轻一重两块（§4.1、§4.2），轻的那块在早期阶段就要落地。

调研另一个值得注意的结论：**这件事在 SSH 客户端赛道上还没有先例**。现存 ssh MCP server（tufantunc/ssh-mcp、classfang/ssh-mcp-server 等）无一例外都是把凭据写进 MCP 客户端配置、自己另开连接。"GUI 持有连接、agent 通过 GUI 操作"的近亲是 JetBrains IDE 内置 MCP server 和 iterm-mcp，但都只覆盖本地。

---

## 二、现状诊断：现有 MCP 功能的五个问题

`apps/mcp-ssh-proxy` 现状：stdio 传输，5 个工具（`nextshell/list` `search` `connect` `exec` `disconnect`），通过 `packages/runtime` 的 `ReadonlyCredentialContext` 直读数据库。

| # | 问题 | 证据 |
| --- | --- | --- |
| 1 | **设备密钥明文外泄**。`NEXTSHELL_DEVICE_KEY` 被复制到 MCP 客户端配置文件里，等价于全部已保存凭据的解密能力；无法按主机收权、无法单独吊销（只能轮换整个设备密钥） | `apps/mcp-ssh-proxy/README.md:60` 自述"该环境变量等同于所有已保存凭据的解密能力"；`backup-password-service.ts:256` |
| 2 | **与运行中的桌面端零交互**。另开 `SshConnection`，不复用连接池、不进 `activeSessions`；用户在 NextShell 里看不到 agent 做了什么 | `mcp-ssh-proxy/src/server.ts:78` |
| 3 | **能力面窄且无上下文**。只有一次性 `exec`，README 明确"不提供交互式 shell""不保留 shell 上下文"——`cd`、venv、`docker exec` 里的状态全部丢失 | `mcp-ssh-proxy/README.md:15-16` |
| 4 | **零审计**。走只读 context，不写 `audit_logs`，桌面端的 `command.exec` 审计完全绕过 | `packages/runtime/src/index.ts` 无 `appendAuditLog` |
| 5 | **无授权粒度**。拿到 db + 设备密钥即可连所有主机，没有按 profile 授权、没有只读模式 | `resolveConnectionTarget` 对全表可见 |

桌面端侧的 MCP 痕迹只有一处：设置中心 → 安全 → 「复制 MCP 代理配置」（`security-section.tsx:139`、`registry.ts:688`、`IPCChannel.McpProxyCopyConfig`），没有任何代码启动或管理这个 proxy。**桌面端目前没有任何 HTTP/WS 监听**（全仓 `createServer|express|fastify|WebSocketServer` 零命中），本方案将引入第一个。

> `packages/runtime` 并非全部作废：其中的目标解析（`resolveConnectionTarget` / `searchServerSummaries` / `ServerSummary`，含 `not_found` / `ambiguous` 语义）正是 agent 按自然语言指名主机所需要的，予以保留并搬进主进程；作废的只是读库解密凭据那部分。

---

## 三、设计目标

1. **凭据零外泄**：agent 侧永远拿不到 password / 私钥 / passphrase / 设备密钥，只见 `connectionId`。撤销 = 应用里关一个开关，不需要轮换设备密钥。
2. **接管而非旁路**：agent 用的是桌面端已建立的连接与会话上下文；人能实时看见，随时夺回。
3. **能力面对齐 NextShell**：主机清单、exec、SFTP（含目录打包）、传输队列、监控、命令库全部开放，而不是只有 exec。
4. **人在环内且不依赖客户端能力**：确认闸口做在 NextShell 的原生弹窗里——elicitation 各客户端支持参差（Claude Desktop 至今不支持），不能作为唯一防线。
5. **零配置接入**：装插件即用，不粘 token、不填端口，应用重启换端口也不用改配置。
6. **默认关闭、按主机授权、全程审计**。

---

## 四、总体架构

```
┌── Agent 客户端 (Claude Code / Cursor / Claude Desktop / Codex / Gemini CLI) ──┐
│                                                                              │
│   ① 插件内 stdio shim（主推，零配置）        ② 直连 HTTP（高级/可选）          │
│      @nextshell/mcp-bridge                    http://127.0.0.1:PORT/mcp      │
└──────────────┬────────────────────────────────────────┬──────────────────────┘
               │ stdio ↔ UDS 转发                        │ Authorization: Bearer
               │ 读 endpoint.json 自动发现               │
               ▼                                        ▼
   ┌──────────────────────────────────────────────────────────────┐
   │  Electron 主进程                                              │
   │  ┌────────────────────────────────────────────────────────┐  │
   │  │ McpEndpointServer  (node:http + @modelcontextprotocol) │  │
   │  │   · Unix socket / 命名管道 0600（默认，无 token）        │  │
   │  │   · 127.0.0.1:PORT + Bearer token（可选，默认关）        │  │
   │  │   · Origin / Host 校验，防 DNS rebinding                │  │
   │  │   └ 每个客户端一对 McpServer + StreamableHTTPTransport   │  │
   │  └───────────────────────┬────────────────────────────────┘  │
   │                          ▼                                    │
   │  ┌────────────────────────────────────────────────────────┐  │
   │  │ AgentGateway（新增，唯一授权面）                         │  │
   │  │   · 目标解析（名称/host/分组/标签 → connectionId）       │  │
   │  │   · 主机授权表（ConnectionProfile.agentAccess）         │  │
   │  │   · 命令风险分级 + 策略引擎（packages/terminal）         │  │
   │  │   · 本地路径策略（防经由上传外泄本机文件）               │  │
   │  │   · 应用内确认弹窗 / ask_user 反向问询                   │  │
   │  │   · 审计 agent.* + 限流 + 超时 + 输出截断                │  │
   │  └───────────────────────┬────────────────────────────────┘  │
   │                          ▼                                    │
   │  ServiceContainer（现有，优先零改动复用）                      │
   │    sessions / commands / sftp / monitors / connections        │
   │                          │                                    │
   │   shell.on("data") ──┬──▶ sessionDataDispatcher ──IPC──▶ 渲染进程 xterm（人看，仅前台标签）
   │                      │                                        │
   │                      ├──▶ OscTap（轻，Phase 1）               │
   │                      │      流式 OSC 扫描：7 → cwd            │
   │                      │                    133 → 命令/退出码    │
   │                      │                                        │
   │                      └──▶ ScreenMirror（重，Phase 3）         │
   │                            @xterm/headless + addon-serialize  │
   │                            渲染后屏幕 → session_read          │
   └──────────────────────────────────────────────────────────────┘
```

### 4.1 主进程当前对会话一无所知

`session-service.ts:204` 把解码后的字符串直接推进 `sessionDataDispatcher` 就忘掉，全仓无任何 scrollback / replay 缓冲。更要命的是**渲染进程也不是可靠的替代来源**：

- 会话的 cwd 由渲染进程的 OSC 7 处理器写进 `useSessionOscStore`（`renderer/terminal/osc/cwd.ts`、`osc/iterm2.ts`），主进程完全不知情（主进程里唯一的目录概念是本地会话的 `os.homedir()`）。
- 命令语义同理：`CommandMark`（命令文本 + 退出码）只活在渲染进程的 `useSessionOscStore`；落到主进程的 `CommandHistoryEntry` 连 connectionId 和退出码都没有。
- **渲染进程的 xterm 是单实例多路复用，且只有前台标签的字节真的被写进终端**（`TerminalPane.tsx:451` 一带：非前台会话的数据只堆进 `bufferBySessionRef`，切回该标签 replay 时才被解析）。也就是说**后台标签的 cwd 与命令标记在渲染进程里是过期的**，切过去才会重建。

结论：任何"让 agent 接着人的上下文干活"的能力，都必须由主进程自己解析会话数据流。

### 4.2 一轻一重两层

| 层 | 做什么 | 开销 | 阶段 |
| --- | --- | --- | --- |
| **OscTap** | 在数据抽头上跑一个流式 OSC 扫描器，提取 **OSC 7（cwd）** 与 **OSC 133（命令文本 / 退出码 / 该命令的输出字节区间）**。无网格、无渲染，内存可忽略 | 极小 | Phase 1 |
| **ScreenMirror** | `@xterm/headless` + `addon-serialize` 全量终端仿真，产出"渲染后的屏幕" | 实测每个繁忙宽终端 2–4 MB RSS（附录 A.2） | Phase 3 |

拆开的理由：**读屏（重）和 cwd/命令语义（轻）是两件事，而后者才是 exec 类用例的刚需**。用例 C 的"当前目录"只需要 OscTap。而且 OscTap 配合 §4.3 已经能回答"这个会话里人跑过哪些命令、各自输出了什么"——**"agent 看得懂人在干什么"这件事大半由轻量层完成**；ScreenMirror 主要留给全屏 TUI 的当前状态（`top`、`htop`、`vim`、交互式安装器）。

读屏必须用终端仿真而不能存原始字节：原始字节是转义序列原文，`top` 刷新会是一堆光标定位指令而不是一屏内容。

**开销门控**：两层都只对**已授权 agent 访问的主机**开启，未授权主机零开销。ScreenMirror 的双份解析成本在 Phase 3.4 实测，必要时降级（缩 scrollback / 按需启停）。

**顺带的收益**：主进程一旦有了会话感知的 cwd 与命令标记，就不再依赖"切到该标签触发 replay"才能拿到正确状态，也为会话录制与断线重连回放打了地基（`docs/threat-model.md` 里"会话录制留存期与加密策略"那条未决项在此落地）。

### 4.3 命令文本与输出怎么拿（不靠终端网格）

渲染进程现在是靠读 xterm buffer 反推命令文本的（`shellIntegration.ts` 的 `captureCommand`：从 `B` 标记读到光标）——**这依赖网格，OscTap 没有网格**。但 NextShell 有一个别人没有的条件：**shell 集成脚本是我们自己的**（`apps/desktop/src/shared/shell-integration/nextshell-shell-integration.{bash,zsh,sh,fish}`，自行发 OSC 7 与 133 A/B/C/D）。

因此：

| 数据 | 获取方式 |
| --- | --- |
| 命令文本 | **扩展集成脚本，在 `C` 标记上直接带出命令行**（zsh/fish 的 `preexec` 天然拿得到，bash 用 `DEBUG` trap / `BASH_COMMAND`；对标 VS Code 的 `OSC 633;E;<cmdline>`）。主进程零推断、零启发式 |
| 退出码 | 现有 `133;D;$?` 已经带了 |
| 命令输出 | OscTap 截取 `C` 与 `D` 之间的**原始字节**即该命令的完整输出（带上限截断，`stripAnsi` 可选） |
| cwd | 现有 OSC 7 已经带了 |

这条路把"agent 想知道人刚跑的那条命令输出了什么"变成零成本查询，也让 `session_send_keys` 的 `waitForPrompt` 不必做屏幕 diff。

**降级**：远端未装 NextShell 集成（或 `shellIntegration: "off"`）时拿不到命令文本——此时如实向 agent 报告能力缺失，`waitForPrompt` 退化为哨兵标记或超时，而不是给出一个猜出来的命令文本。

---

## 五、真实用例走查

以下三个用例来自实际使用预期，用来校验能力面是否闭合。**它们暴露的四个设计细节（工作目录语义、按主机寻址、本地路径外泄面、传输进度回报）已回填进方案。**

### 用例 A：「帮我操作 prod-hk 服务器，看一下上面数据的运行情况」

```
1. host_list / host_describe("prod-hk")
     └ 目标解析：名称/host/分组/标签模糊匹配
       · 命中多个 → ask_user 弹出主机选择器（不是让 agent 猜）
       · 未连接   → 见 §5.4 连接建立流程
2. monitor_snapshot(target)        → CPU/内存/磁盘/网络/Top5 进程（复用 MonitorService）
3. exec(target, "systemctl --failed") / exec(target, "docker ps")
4. exec(target, "tail -n 200 /var/log/app/error.log")
     └ 命令风险分级判定为只读 → 自动放行，不打断人
5. 汇总回答；期间每一步都出现在 GUI 的 Agent 活动面板里，全部落审计
```

**暴露的问题 ①：按主机寻址，而不是按会话寻址。** 用户说的是"操作 xxx 服务器"，不是"操作会话 uuid"。所有工具的第一个参数统一为 `target`，接受主机名 / host / connectionId / sessionId，由 Gateway 解析——这正是 `packages/runtime` 里 `resolveConnectionTarget` 该保留的原因。

### 用例 B：「把当前项目打包的文件传到 /opt/app 目录」

```
1. （agent 在本地仓库里 build，得到 dist/app-1.0.tar.gz——这是 agent 自己的上下文）
2. file_stat(target, "/opt/app")        → 不存在则 file_mkdir
3. transfer_upload(target,
     localPath: "/Users/ztwang/repo/myproject/dist/app-1.0.tar.gz",
     remotePath: "/opt/app/")
     ├ 本地路径策略校验（见 §7.3）
     ├ 应用内确认弹窗：显示完整本地路径 + 目标主机 + 远端路径 + 文件大小
     ├ 任务进入 GUI 的传输队列（带 agent 徽标），人能看进度、能取消
     └ 返回 taskId
4. transfer_status(taskId) 轮询 → success
5. exec(target, "tar -xzf /opt/app/app-1.0.tar.gz -C /opt/app")
     └ 命令风险分级判定为写操作 → 按策略弹确认
```

**暴露的问题 ②：上传是一条本机文件外泄通道。** agent 能指定任意本地路径，NextShell 会老实读取并发到远端——`~/.ssh/id_rsa`、`nextshell.db`、浏览器 profile 都在射程内。必须有本地路径策略（§7.3），这是本方案里优先级最高的新增安全控制。

**暴露的问题 ③：大文件传输不能同步阻塞。** 现有传输进度是 sender-scoped（`container.ts:237` 对 `undefined` sender 直接 no-op），agent 发起的传输收不到任何事件。需要 `transfer_upload` 返回 taskId + `transfer_status` / `transfer_cancel` 轮询，同时把进度扇出到 GUI 传输队列。

**顺带的能力红利**：`localPath` 若是目录，直接走现有 `uploadRemotePacked`（tar/gzip 打包传输），比 agent 自己逐文件 scp 快一个量级——这就是"能力面 = NextShell 的能力面"的具体收益。

### 用例 C：「查看当前占用最大的文件夹及其内容」

```
1. session_list → 拿到该会话 OSC 7 跟踪的 cwd，例如 /var/www
2. exec(target, "du -sh -- * | sort -h | tail -20", cwd: "/var/www")
3. exec(target, "du -sh -- * | sort -h | tail -20", cwd: "/var/www/uploads")   ← 逐层下钻
4. file_list(target, "/var/www/uploads/2026")   ← 结构化列目录，优于解析 ls 输出
```

**暴露的问题 ④：exec 的工作目录语义。** `CommandService.execCommand` 走的是**独立 exec 通道**，起始目录是 `$HOME`，**不是** PTY 里的当前目录。用户说"当前占用最大的文件夹"，指的是他终端里 `cd` 过去的那个目录。若不处理，agent 会静默地在错误的目录下执行——这是一个不修就必然发生的 bug，而且错得很隐蔽（命令成功、结果无关）。

**对策**：`exec` 增加可选 `cwd`；缺省时若 `target` 是会话，取该会话的 cwd，并在返回值里**回显实际执行目录**让 agent 自我校验。**但主进程当前拿不到这个 cwd**（§4.1：OSC 7 只在渲染进程解析，且后台标签的值是过期的）——这正是 OscTap 必须排进 Phase 1 而不能推迟的原因。

### 5.4 连接建立与认证交互

用例 A 里"帮我操作 xxx 服务器"时该主机很可能**尚未连接**，agent 触发建连会撞上几类人机交互，必须显式处理，否则 agent 会静默挂起：

| 场景 | 处理 |
| --- | --- |
| Host key 首次固定（TOFU） | **绝不自动接受**。弹应用内窗口让人确认指纹；agent 侧返回明确的 `host_key_unverified` |
| 键盘交互 / 2FA / OTP | 经 `ask_user` 通道转给人输入；超时则失败并提示"请先在 NextShell 里手动连一次" |
| 钥匙串被拒 / 主密码未解锁 | 立即返回明确错误码，引导人去应用里解锁，**不阻塞 agent** |
| 首次为 agent 建连 | 默认需应用内确认；可按主机勾选"允许自动连接" |
| 连接池回收 | agent 持有的连接必须 `retainConnection()`，否则 `closeConnectionIfIdle`（`container.ts:591`）会因为没有 `activeSessions` 引用而回收掉 |
| 通道预算 | 用例 C 那种连续下钻会快速开关 exec 通道，注意 `CLIENT_CHANNEL_BUDGET`；Gateway 需限制单主机并发 exec |

---

## 六、能力面（工具清单）

工具按权限分层命名，配合 Claude Code 的 `mcp__nextshell__*` allowlist 前缀匹配。annotations 如实标注 `readOnlyHint` / `destructiveHint`，让客户端自动放行只读、对破坏性操作升级确认。所有工具第一个参数统一为 `target`（主机名 / host / connectionId / sessionId）。

### Tier 0 — 只读观察（`readOnlyHint: true`）

| 工具 | 说明 | 复用 |
| --- | --- | --- |
| `host_list` | 已授权主机清单（name/host/user/group/tags/在线状态/活动会话数）。**绝不含任何凭据字段** | `ConnectionService` + 保留的目标解析 |
| `host_describe` | 单主机详情 + 会话列表 + 最近监控快照 | `ConnectionService` / `MonitorService` |
| `session_list` | 活动会话：谁开的（人/agent）、**当前 cwd**、最后一条命令、状态 | `activeSessions` + **OscTap** |
| `session_read` | 读会话屏幕。`mode: "screen" \| "scrollback"`、`lines`、`stripAnsi` | **ScreenMirror** |
| `session_history` | 会话命令记录：命令文本 + 退出码 + 起止时间 + **该命令的完整输出**（可截断 / 去 ANSI） | **OscTap（OSC 133）** |
| `file_list` / `file_read` / `file_stat` | SFTP 只读（结构化列目录优于解析 `ls`） | `SftpService` / `packages/ssh` |
| `monitor_snapshot` | CPU / 内存 / 磁盘 / 网络 / Top 进程 | `MonitorService` |
| `command_search` | 检索用户自己的命令历史与命令库——**让 agent 用你收藏的命令，而不是现编** | `CommandService` |

### Tier 1 — 执行

| 工具 | 说明 |
| --- | --- |
| `exec` | 在主机上执行命令，返回 `stdout/stderr/exitCode/实际cwd`。可选 `cwd`（缺省继承会话 OSC 7 cwd）、`timeout`。走命令风险分级（§7.2）。**同时把命令与结果标注回显到 GUI 的 Agent 活动面板** |

### Tier 2 — 文件与传输

`file_write`、`file_mkdir`、`file_rename`、`file_delete`、`transfer_upload`、`transfer_download`、`transfer_status`、`transfer_cancel`

传输统一异步：返回 taskId，进入 GUI 传输队列（带 agent 徽标，人可取消），agent 轮询 `transfer_status`。目录自动走打包传输。

### Tier 3 — 会话控制与接管

| 工具 | 说明 |
| --- | --- |
| `session_open` / `session_close` | 开/关一个**真实可见的 GUI 标签**，标记为 agent 持有 |
| `session_send_keys` | 往人正在看的 PTY 注入输入（TUI、交互式安装器、sudo 提示、已有 cd/venv/docker 上下文）。可选 `waitForPrompt`：等到下一个 OSC 133 `D` 返回退出码与该命令输出 |
| `session_send_signal` | Ctrl-C / Ctrl-D 等控制字符 |
| `process_kill` | 复用 `MonitorService.killRemoteProcess` |

**默认用 `exec`，`session_send_keys` 是显式升级**。三个用例全部由 `exec` + SFTP 覆盖；只有状态活在那个 PTY 里的场景才值得注入（注入后再刮屏要面对 ANSI、分页器、提示符噪声）。

### Tier 4 — 人机协作（NextShell 独有）

| 工具 | 说明 |
| --- | --- |
| `ask_user` | **在 NextShell 里弹原生对话框问人**（确认 / 选项 / 文本输入），返回答案。用例 A 的主机歧义消解、§5.4 的 2FA 输入都走这条通道，且不依赖客户端 elicitation 支持 |
| `notify_user` | 桌面通知 / 应用内提示（"传完了，去看看"） |
| `session_focus` | 让 GUI 切到指定标签并置顶窗口，人直接围观 |

Tier 4 正是"agent 辅助 NextShell"与"SSH over HTTP"的分界线。

**Resources / Prompts**：把会话暴露为 `nextshell://session/{id}/screen` 并在变化时推 `resources/updated`，仅作渐进增强（各客户端对订阅支持参差）；核心契约全部走 tools。

---

## 七、安全模型

现有 `docs/threat-model.md` 的整个信任边界是"渲染进程不可信，特权能力藏在 preload + IPC + Zod 后面"。本地监听端点是**未建模的新主体**：它绕过 `ipc/register.ts:44` 的 sender-frame 校验，没有用户手势，直接调 `ServiceContainer`。因此需要自成一套。

### 7.1 分层控制

| 层 | 机制 |
| --- | --- |
| 1. 传输 | 默认 Unix socket / 命名管道，权限 0600（靠 OS 授权，无 token 可泄）；可选 loopback TCP + Bearer token；Origin/Host 校验；**总开关默认关闭** |
| 2. 主机授权 | `ConnectionProfile.agentAccess: "off" \| "readonly" \| "full"`，默认 `off`。`readonly` 让 agent 能看不能改——比布尔开关实用得多 |
| 3. 工具粒度 | 读 / 执行 / 写分名，配合 allowlist；诚实 annotations |
| 4. 命令风险分级 | 见 §7.2 |
| 5. 本地路径策略 | 见 §7.3 |
| 6. 应用内确认 | 原生弹窗（JetBrains 模式）：命中策略 / 写操作 / 传输 / PTY 注入时触发；支持"本会话内始终允许"与全局 brave 模式（默认关）。**这是唯一对所有客户端都生效的闸口** |
| 7. 审计 | 全量 `agent.*` action 落库（客户端标识、工具名、redact 后的参数、结果码）。**MCP 开启时强制打开审计**——现状审计默认关且只在容器构造时读一次（`container.ts:165`），不改的话这个特性等于没日志 |
| 8. 夺回控制 | 标签「Agent 控制中」徽标 + 一键中止、状态栏全局断闸、关应用即断 |

配套：每客户端调用限流、单主机并发 exec 上限、exec 默认 60s 超时、输出截断（完整内容落临时文件供 `file_read`）、复用 `redactAuditMetadata` 对返回内容脱敏。

### 7.2 命令风险分级

用例 A 和 C 几乎全是只读命令（`du` `df` `ls` `tail` `ps` `systemctl status` `docker ps`）。若对每条都弹窗，功能不可用；若一律放行，`rm -rf` 也就放行了。因此策略引擎按三档处理，落在**当前是死代码的 `packages/terminal`**（23 行、零调用点）里：

| 档位 | 判定 | 默认行为 |
| --- | --- | --- |
| 只读白名单 | 已知只读命令且无重定向 / 管道写 / `;`&`&&` 串接可疑写操作 | 自动放行，仅审计——保证用例 A/C 不打断人 |
| 未知 | 不在两张表里 | `readonly` 主机拒绝；`full` 主机按偏好（默认弹确认） |
| 危险黑名单 | `rm -rf /`、`mkfs`、`dd of=/dev/`、`shutdown`/`reboot`、fork bomb、重定向到设备文件、`chmod -R 777 /`、无差别 `kill -9 -1` | 强制确认；主机 tags 含 prod 时可配置为直接拒绝 |

`sudo` 单独门控（可按主机关闭）。分级结果写入审计，便于事后复盘。

### 7.3 本地路径策略（新增，优先级最高）

`transfer_upload` 让 agent 能把**本机任意文件**送到远端，这是本方案引入的最严重新增攻击面（用例 B 暴露）。控制：

- **默认拒绝清单**：`~/.ssh`、`~/.aws`、`~/.config/gcloud`、钥匙串路径、NextShell 自身数据目录（`nextshell.db`、备份文件）、浏览器 profile、`.env` / `id_*` / `*.pem` / `*.key` 等模式。
- **可选允许根**：用户可在设置里限定 agent 可读的本地根目录（如只允许 `~/repo`）。
- **确认弹窗必须展示完整本地路径与文件大小**——路径是防御的最后一道人工校验。
- 审计记录完整本地路径（不脱敏路径本身，但对内容不做读取记录）。

---

## 八、接入与分发（对标 Claude Code plugin 那套）

### A. Claude Code 插件（主推，零配置）

```
nextshell-plugin/
├── .claude-plugin/plugin.json     # mcpServers → node ${CLAUDE_PLUGIN_ROOT}/bin/bridge.mjs
├── bin/bridge.mjs                 # stdio ↔ UDS 转发；读 endpoint.json；零凭据
├── skills/
│   ├── remote-triage/SKILL.md     # 用例 A 的标准流程：先 monitor_snapshot 再逐层 exec
│   ├── deploy-upload/SKILL.md     # 用例 B：校验目标目录 → 打包上传 → 校验 → 解包
│   └── disk-forensics/SKILL.md    # 用例 C：从会话 cwd 出发逐层 du 下钻
├── commands/nextshell-triage.md   # /nextshell:triage <host>
└── agents/sre-operator.md         # 工具限定为 Tier 0 只读集的子代理
```

用户侧：`/plugin marketplace add HynoR/nextshell-plugin` → `/plugin install nextshell`。**不粘 token、不填端口**；应用重启换了 socket 路径也不用改配置。

> **shim 不能是纯转发管道**（附录 A.4 实测结论）：本地 CLI 在会话启动时就连接插件的 stdio server，失败重试 3 次后标红，且 **stdio server 无自动重连、无懒启动**。因此 shim 必须自己完成 `initialize`、用随插件发布的静态清单回答 `tools/list`，只在 `tools/call` 时才 dial UDS，连不上就返回工具级错误（"NextShell 未运行"）而**不是退出进程**——否则用户每次开会话都会看到一个红叉。

把三个用例固化成 skills 是这套分发方式的主要价值——agent 不用每次自己摸索"该先查什么"。

> 命名注意：插件内 server key 要短。插件安装后工具全名是 `mcp__plugin_<插件名>_<serverKey>__<tool>`，直连安装则是 `mcp__nextshell__<tool>`。文档需同时给出两种 allowlist 示例。

### B. 应用内一键配置（JetBrains 模式）

设置中心新增「Agent 接入」页：开关、状态、socket 路径 / 端口 / token、已连客户端列表、按客户端的一键按钮——

- 「复制 `claude mcp add` 命令」
- 「添加到 Cursor」（deeplink `cursor://anysphere.cursor-deeplink/mcp/install?name=…&config=<base64>`）
- 「写入 Claude Desktop 配置」（改 `claude_desktop_config.json`，操作前确认）
- 「导出 `.mcpb`」（Claude Desktop 一键安装包）

### C. 独立 npx

`npx -y @nextshell/mcp-bridge`，占用现有 `nextshell-mcp-ssh-proxy` 的 bin 位置。**同一个二进制位置，能力从"持有全部凭据的影子客户端"变成"零凭据的转发管道"。**

### D. 端点发现

`<userData>/mcp/endpoint.json`：`{ version, pid, socketPath, httpPort?, token?, appVersion, startedAt }`。**发现文件放 userData，socket 本身不能放**——macOS 路径上限 104 字节（附录 A.1），socket 需落在短路径（`os.tmpdir()` 下的 0700 目录）。正常退出时删除发现文件；shim 必须校验 pid 存活 + 连通性探测（JetBrains 早期 `@jetbrains/mcp-proxy` 靠端口探测，脆弱到被官方废弃，陈旧文件是同类坑）。多实例：每实例一份 `endpoint-<pid>.json` + 一个指向最新的 `endpoint.json`，shim 选最新存活者，`NEXTSHELL_MCP_ENDPOINT` 可覆盖。

---

## 九、分阶段实施计划

阶段顺序按**用例点亮速度**排定：Phase 0–2 完成即可覆盖全部三个用例，SessionMirror 与 PTY 接管排在其后。

### Phase 0 —— 地基与止血

| # | 任务 | 涉及文件 | 要点 |
| --- | --- | --- | --- |
| 0.1 | MCP 端点服务 | `main/services/mcp/endpoint-server.ts`(新) | **两个 `http.Server` 实例**（UDS + 可选 TCP）共用同一 handler 与同一张 session map；每客户端一对 `McpServer`+`StreamableHTTPServerTransport`。socket 路径 ≤104 字节、先建 0700 父目录再 listen 后 chmod 0600。**已实测，见附录 A.1** |
| 0.2 | AgentGateway 骨架 + 目标解析 | `main/services/mcp/agent-gateway.ts`(新) | 唯一授权面；从 `packages/runtime` 搬 `resolveConnectionTarget`（剥离凭据读取）；限流 / 超时 |
| 0.3 | 授权字段与偏好 | `packages/core`、`packages/shared`(contracts/channels/api)、`security-section.tsx` | `ConnectionProfile.agentAccess`；`AppPreferences.agent` 段；**按 CLAUDE.md 三件套同步规则** |
| 0.4 | 审计可运行时切换 | `container.ts:165-179` | 现状构造时读一次，MCP 开启必须能即时打开审计 |
| 0.5 | Tier 0 只读工具 | `main/services/mcp/tools/*.ts`(新) | host / session / file / monitor / command_search |
| 0.6 | 设置中心「Agent 接入」页 + endpoint.json + shim | `renderer/.../agent-section.tsx`(新)、`apps/mcp-bridge`(新) | |
| 0.7 | 旧 proxy 标记废弃 | `security-section.tsx:139`、`registry.ts:688` | 「复制 MCP 配置」改为引导到新页 + 明确警告旧路径外泄设备密钥 |

**验收**：Claude Code 经插件 shim 连上，能列主机、读文件、取监控快照；agent 侧全程无任何凭据；`audit_logs` 有完整 `agent.*` 记录。

### Phase 1 —— 会话感知、exec 与策略（点亮用例 A、C）

| # | 任务 | 涉及文件 | 要点 |
| --- | --- | --- | --- |
| 1.0a | **OscTap（主进程会话感知）** | `main/services/mcp/osc-tap.ts`(新)、`session-service.ts:204` | 流式 OSC 扫描器：OSC 7 → cwd、OSC 133 → 命令/退出码/输出字节区间；跨 chunk 状态机（数据按 512KB 窗口切分，序列会被从任意字节切断）；按 `agentAccess` 门控 |
| 1.0b | **集成脚本带出命令文本** | `shared/shell-integration/*.{bash,zsh,sh,fish}` + `index.spec.ts` | §4.3：`C` 标记上附命令行；zsh/fish 用 `preexec`，bash 用 `DEBUG` trap；保持幂等与向后兼容（旧脚本仍能被解析） |
| 1.1 | `exec` 工具 | `tools/exec.ts` | 复用 `CommandService.execCommand`；`retainConnection()` 防连接池回收；单主机并发上限 |
| 1.2 | **cwd 语义** | `tools/exec.ts` ← OscTap | 可选 `cwd`；缺省继承会话 cwd；返回值回显实际执行目录 |
| 1.2b | `session_history` | `tools/session.ts` | 直接由 OscTap 供数，无需等 ScreenMirror |
| 1.3 | 命令风险分级引擎 | `packages/terminal/src/*` | 替换现有死代码；只读白名单 / 未知 / 危险黑名单三档 + sudo 门控 |
| 1.4 | 应用内确认弹窗 | `main/services/mcp/confirm.ts`(新) | 复用 `nMessageBox` 模式；"本会话始终允许" |
| 1.5 | 连接建立流程 | `agent-gateway.ts` | TOFU 拒绝自动接受；2FA 走 `ask_user`；钥匙串/主密码失败快速返回 |
| 1.6 | `ask_user` / `notify_user` | `tools/interact.ts`(新) | 主机歧义消解、2FA 输入依赖它，故提前到本阶段 |
| 1.7 | Agent 活动面板 | `renderer/` 新 store slice + 面板 | 按 OSC store 模式加 slice，**不动 `SessionDescriptor` 契约** |

**验收**：完整跑通用例 A 与 C；只读命令不打断人；`rm -rf /` 被拦并弹窗；exec 在正确的工作目录下执行。

### Phase 2 —— 文件与传输（点亮用例 B）

| # | 任务 | 涉及文件 | 要点 |
| --- | --- | --- | --- |
| 2.1 | **本地路径策略** | `agent-gateway.ts` + 设置项 | 默认拒绝清单 + 可选允许根；确认弹窗展示完整本地路径 |
| 2.2 | SFTP 写工具 | `tools/file.ts` | `file_write`/`mkdir`/`rename`/`delete`；service 层补 `stat`/`chmod`/`readFile`/`writeFile`（现仅在 `packages/ssh`，未过 service/IPC） |
| 2.3 | 异步传输 + 进度扇出 | `sftp-service.ts`、`container.ts:237` | `transfer_upload/download/status/cancel`；进度扇出到 GUI 传输队列（现为 sender-scoped，agent 发起收不到事件）；目录自动打包 |
| 2.4 | 传输队列 agent 徽标 | `useTransferQueueStore` + UI | 人能看见并取消 agent 的传输 |

**验收**：完整跑通用例 B；上传 `~/.ssh/id_rsa` 被策略拒绝；大文件传输进度在 GUI 与 agent 侧都可见。

### Phase 3 —— ScreenMirror（读屏）

| # | 任务 | 涉及文件 | 要点 |
| --- | --- | --- | --- |
| 3.1 | headless 镜像 | `main/services/mcp/screen-mirror.ts`(新) | 复用 Phase 1 的抽头；**`allowProposedApi: true` 必开**（附录 A.2）；不要 external 该依赖（附录 A.3）；按 `agentAccess` 门控 |
| 3.2 | `session_read` | `tools/session.ts` | `screen` / `scrollback` 两种模式；`stripAnsi`；**读 buffer 必须在 `write()` 回调内** |
| 3.3 | 与 OscTap 合流 | | OSC 处理器可直接注册在 headless 实例上，避免同一份字节扫两遍；OscTap 在未开镜像的会话上继续独立工作 |
| 3.4 | 真实负载复核 | — | 单实例开销已实测（附录 A.2），本任务只需在真实多会话负载下复核并敲定 scrollback 上限与降级阈值 |

**验收**：agent 能读到**后台标签**的屏幕；`top` 刷新收敛为一屏内容而非转义序列堆。

### Phase 4 —— PTY 接管

| # | 任务 | 要点 |
| --- | --- | --- |
| 4.1 | `session_send_keys` + `waitForPrompt` | `contracts.ts:177` 的 `origin` 加 `"agent"`（现 `"user"\|"protocol"` 已定义但未消费）；命令回显去重（对齐 `recordSentCommand`） |
| 4.2 | `session_open` / `close` / `send_signal` / `focus` | agent 开的标签真实可见 |
| 4.3 | 标签徽标 + 全局断闸 + 输入抢占 | 人一敲键盘即暂停 agent 注入 |

### Phase 5 —— 分发与清理

| # | 任务 |
| --- | --- |
| 5.1 | Claude Code 插件仓库（三个用例固化为 skills / commands / agents / marketplace.json） |
| 5.2 | 一键配置按钮（Cursor deeplink / 写 Claude Desktop 配置 / 导出 `.mcpb`） |
| 5.3 | 删除 `apps/mcp-ssh-proxy`，`packages/runtime` 仅保留目标解析并入主进程 |
| 5.4 | 更新 `docs/threat-model.md`：把"本地监听端点""agent 主体""本地路径外泄面"纳入模型 |

---

## 十、风险与对策

| 风险 | 对策 |
| --- | --- |
| **经由上传外泄本机敏感文件** | §7.3 本地路径策略；确认弹窗展示完整路径；优先级最高 |
| exec 工作目录与用户预期不符（且错得隐蔽） | Phase 1.0 OscTap + 1.2：继承会话 cwd 并回显实际目录 |
| 只读命令被弹窗淹没导致功能不可用 | §7.2 三档分级，只读白名单自动放行 |
| 字节双份解析的 CPU/内存 | 轻重分层（§4.2），OscTap 开销可忽略；ScreenMirror 实测 2–4 MB RSS/会话（附录 A.2），按 `agentAccess` 门控 + scrollback 上限 |
| headless 的 `allowProposedApi` 陷阱 | 附录 A.2：headless 里 `buffer`/`parser` 是 proposed API，与渲染进程直觉相反；本仓已因 `registerDecoration` 踩过同一个坑，实现时无条件打开 |
| shim 在应用未运行时拖累每次会话启动 | 附录 A.4：shim 独立完成握手 + 静态工具清单 + 工具级错误，永不因应用未运行而退出 |
| UDS socket 路径超长 / 权限竞态 | 附录 A.1：socket 置于短路径（≤104 字节）；先建 0700 父目录再 listen 再 chmod 0600；吊销访问需主动断连（chmod 不影响已有连接） |
| OSC 序列被 IPC 分片从中间切断 | OscTap 必须是跨 chunk 状态机——渲染进程当年靠 `utils/osc7.ts` 手写 pending 状态补救过同一个坑 |
| 主进程新增监听面 | UDS 0600 为默认（无 token 可泄）；总开关默认关；Origin/Host 校验；TCP 默认关 |
| 人与 agent 抢同一个 PTY | 输入抢占 + 输入锁 + 标签徽标 |
| OSC 133 覆盖不全（远端未装集成、`shellIntegration: "off"`、非我方集成脚本） | §4.3 降级路径：如实报告能力缺失而非猜测命令文本；`waitForPrompt` 退化为哨兵标记或超时 |
| 改集成脚本可能打破既有会话 | Phase 1.0b 必须保持幂等与向后兼容（旧脚本仍可解析）；`index.spec.ts` 已有针对四种 shell 的真机 source 测试，扩展时一并覆盖 |
| MCP 规范 2026-07-28 RC 移除 `initialize` 握手与 `Mcp-Session-Id` | 架构不绑定服务端 SSE 推送、sampling、roots（后两者已在废弃通道）；核心能力全在 tools |
| 多实例 / 陈旧 endpoint 文件 | pid 校验 + 探活；每实例独立文件；环境变量可覆盖 |
| Windows 命名管道；WSL 里的 agent 够不到宿主 loopback | 文档说明；该场景开放可选 TCP 监听 |
| 连接池通道预算被连续 exec 打满 | Gateway 限制单主机并发；`retainConnection()` 防回收 |

---

## 十一、工作量估算

| 阶段 | 内容 | 估算 |
| --- | --- | --- |
| Phase 0 | 端点服务 + Gateway + 只读工具 + 设置页 + shim | 3–4 人天 |
| Phase 1 | OscTap + exec + cwd 语义 + 策略引擎 + 确认弹窗 + ask_user + 活动面板 | 5–6 人天 |
| Phase 2 | 本地路径策略 + SFTP 写 + 异步传输 + 队列可见 | 3–4 人天 |
| Phase 3 | ScreenMirror + 读屏工具 + 实测 | 2 人天 |
| Phase 4 | PTY 注入 + 接管 GUI 标签 | 2–3 人天 |
| Phase 5 | 插件 + 一键配置 + 清理 + 威胁模型 | 2–3 人天 |
| **合计** | | **17–22 人天** |

**Phase 0 + 1 + 2（约 11–14 人天）即可覆盖全部三个真实用例**，且此时 agent 仍无法注入 PTY、无法读屏，攻击面最小，建议作为第一个发布里程碑。

---

## 附录 A：可行性实测结论

以下均为在 macOS 27 / Node 24 上**实际跑过的实验**结论（`@modelcontextprotocol/sdk` 1.29 与 1.30、`@xterm/headless@6.0.0`、`@xterm/addon-serialize@0.14.0`），不是文档推断。踩到的坑一并列出——它们全都会在实现时撞上。

### A.1 传输层（Phase 0.1）—— 成立

- `StreamableHTTPServerTransport.handleRequest(req, res, body)` **无需任何改动**即可处理 Unix socket 上的 `IncomingMessage` / `ServerResponse`：`initialize` → 200 并正常签发 `Mcp-Session-Id`，`tools/list` → 200 返回带 `annotations` 的工具定义，SSE 帧正常。
- SDK 1.30 内部已改写为基于 `@hono/node-server` 的 web 标准传输，**在 UDS 上依旧工作**。
- **跨监听共享会话成立**：在 UDS 上建立的 session，用其 session id 从 TCP 监听发 `tools/call` → 200 正常执行。

**修正：一个 `http.Server` 不能 listen 两次**（第二次抛 `ERR_SERVER_ALREADY_LISTEN`）。正确形态是**两个 `http.Server` 实例共用同一个 handler 函数与同一张 session map**。

**必须注意的四点：**

| # | 坑 | 对策 |
| --- | --- | --- |
| 1 | macOS 的 `sun_path` 上限 **104 字节**（Linux 108），路径长了 `listen()` 直接 `EINVAL` | socket 放在短路径下（`os.tmpdir()` 一带），不要放进深层 userData 目录；`endpoint.json` 可以放深处，socket 不行 |
| 2 | `listen()` 后 socket 默认权限是 `0777 & ~umask`（实测 755），chmod 前存在竞态窗口 | **先建 0700 父目录再 listen**，然后 chmod socket 0600。macOS 确实强制执行（connect 需要写权限：600 → owner 可连，000 → `EACCES`） |
| 3 | chmod 只影响**新连接**，已建立的连接不受影响 | 吊销访问必须主动关连接，不能只改权限 |
| 4 | `enableDnsRebindingProtection` 默认关闭；打开后 `allowedHosts` 是精确字符串匹配，且缺失 `Host` 头也会 403 | UDS 上 Node 客户端默认发 `Host: localhost`，故 `allowedHosts` 需含 `localhost`；TCP 监听要把带端口的变体一并列入 |

### A.2 ScreenMirror（Phase 3）—— 成立，但有一个致命前提

- **`allowProposedApi: true` 在 headless 构建里是必需的**：headless 把 `buffer`、`parser`、`unicode`、`markers` 全部划为 proposed API，不开就直接抛 `You must set the allowProposedApi option to true to use proposed API`。**注意这与渲染进程的直觉相反**——DOM 构建（本仓已用的 `@xterm/xterm@6.0.0`）里 `buffer` 和 `parser` 是稳定 API，只有 `registerDecoration` 等才需要该开关。**这正是本仓此前 `registerDecoration` 踩过的同一个坑**，实现时无条件打开即可。
- 渲染语义确认为真渲染而非拼接：写入三行后用 `\x1b[2;1H` 覆盖第二行，读回为 `["line1","REPLACED","line3"]`；模拟 `top` 的三帧刷新收敛为最后一帧，且 `buffer.length` 不增长（光标寻址刷新不产生 scrollback）。
- `SerializeAddon` 在 headless 下工作（同样依赖 `allowProposedApi`），无 DOM 依赖。
- `parser.registerOscHandler(133, cb)` 在 headless 下正常触发，BEL 与 ST 两种终止符都能收到，`D;<code>` 可直接取退出码。

**内存实测**（cols 140 / rows 40 / scrollback 1000，20 个实例）：

| 场景 | 每实例堆 | 每实例 RSS |
| --- | --- | --- |
| ~110 KB 典型带色输出 | 0.26 MB | 1.55 MB |
| scrollback 打满 | 0.45 MB | ~3.2 MB |

即**每个繁忙宽终端约 2–4 MB RSS**，20 个会话约 30–65 MB。作为主进程常驻可以接受，Phase 3.4 的实测目标从"能不能用"降级为"在真实负载下复核并定 scrollback 上限"。

其他两点：`term.write()` 是异步排队的，**读 buffer 必须在 write 回调里**，否则读到旧状态；喂入的必须是真实 PTY 字节（`\r\n`），裸 `\n` 需要 `convertEol: true`。

### A.3 打包（Phase 3）—— 成立，注意不要 external

`@xterm/headless` 无原生依赖、无 DOM 引用（产物里 `document.` / `window.` / `requestAnimationFrame` 零命中），可进主进程包。但它的 `module` 字段指向一个**不存在的文件**（上游打包 bug），且产物是 CJS UMD——

- **必须让它被打包进主进程 bundle，不要 external**。本仓 `apps/desktop/vite.config.ts` 只 external 原生模块，默认就是打包，符合要求。
- 若误 external，运行时 ESM `import { Terminal } from "@xterm/headless"` 会报 `Named export 'Terminal' not found`（cjs-module-lexer 解析不了它的 webpack 产物）。
- 用本仓自带的 Vite 8.1.5(Rolldown) 以 node/SSR 方式实测打包并执行通过。

### A.4 插件 shim（Phase 5）—— 设计需修正

- `${CLAUDE_PLUGIN_ROOT}` 在 `command` / `args` / `env` 中确实会被展开，且对 `bin/` 下的可执行文件有专门处理；插件可以同时携带 skills + commands + agents + mcpServers。
- 可执行位在实测的插件缓存里得以保留，但文档未承诺，且 Windows 没有 exec 位——**稳妥写法是 `"command": "node", "args": ["${CLAUDE_PLUGIN_ROOT}/bin/bridge.mjs"]`**。
- **关键修正**：本地 CLI 会在**会话启动时立即连接**插件的 MCP server，失败重试 3 次后标记为 `✘ Failed to connect`；**stdio server 不会自动重连，也没有懒启动**（懒连接只在 web 会话）。若 shim 在 NextShell 未运行时退出，用户每次开会话都会看到一个红叉。

  因此 shim **不能是纯转发管道**，必须是一个能独立完成握手的最小 MCP server：
  1. 自己响应 `initialize`；
  2. `tools/list` 由**随插件版本发布的静态工具清单**回答，NextShell 没开也能列出；
  3. `tools/call` 时才去 dial UDS，连不上就返回明确的工具级错误（"NextShell 未运行，请启动应用后重试"）而不是进程退出；
  4. 连上后可从应用刷新真实工具清单并发 `tools/list_changed`。

- shim 用官方 SDK 客户端走 UDS 是可行的：`StreamableHTTPClientTransport(url, { fetch })` 配合 undici 的 `Agent({ connect: { socketPath } })`。**必须用 `Agent` 不能用 `Client`**——后者单条流水线连接会被常驻的 GET SSE 流独占，导致所有请求 `Request timed out`（已复现）。

### A.5 未验证项

Windows 命名管道路径（`\\.\pipe\`）仅有 Node 文档支持，本机无法实测，实现时需在 Windows 上单独验证；WSL 内的 agent 够不到宿主 loopback 与命名管道，该场景仍需可选 TCP 监听兜底。
