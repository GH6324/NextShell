# NextShell OSC 终端序列全量适配 —— 调查报告与实施计划

> 状态:提案 / 待实施
> 日期:2026-07-24
> 范围:`apps/desktop`(main / preload / renderer)、`packages/shared`、`packages/core`

---

## 一、现状调查结论(TL;DR)

当前 OSC 支持确实是**半成品**:只有 OSC 7(cwd 上报)和一套 OSC 10/11/12 查询抑制 shim,且两者都被 `monitorSession` 开关门控,不是通用终端能力。其余成熟 SSH 客户端(iTerm2、WezTerm、Windows Terminal、Tabby、WindTerm)的标配 OSC 能力——标题(0/2)、剪贴板(52)、显式超链接(8)、shell 集成(133)、桌面通知(9/777)、任务栏进度(9;4)——**全部缺失**。

### 能力矩阵

| OSC      | 语义                                    | 现状                                                                     | 关键位置                                                                                                                       |
| -------- | --------------------------------------- | ------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------ |
| 7        | cwd 上报                                | ⚠️ 半成品:仅 bash/zsh、仅 `monitorSession=true`、手写正则剥离            | `main/services/terminal-osc7-bootstrap.ts`、`renderer/utils/osc7.ts`、`session-service.ts:135-162`、`TerminalPane.tsx:361-411` |
| 0/1/2    | 窗口/标签标题                           | ❌ 无(未订阅 `onTitleChange`,tab 标题恒为连接名)                         | `renderer/utils/sessionTitle.ts`                                                                                               |
| 52       | 剪贴板读写                              | ❌ 无                                                                    | —                                                                                                                              |
| 8        | 显式超链接                              | ⚠️ 半成品:只有 WebLinksAddon 的 URL 正则探测,不解析 OSC 8;点击外链无确认 | `TerminalPane.tsx:757-775`、`main/services/preferences-dialog-service.ts:118-162`                                              |
| 9 / 777  | 桌面通知                                | ❌ 无                                                                    | —                                                                                                                              |
| 9;4      | 任务栏进度(ConEmu/WT)                   | ❌ 无                                                                    | —                                                                                                                              |
| 133      | shell 集成(FTCS 提示符标记)             | ❌ 无;命令历史只捕获 CommandInputBar 提交,终端里直接敲的命令不进历史     | `WorkspaceLayout.tsx:355-366`、`hooks/useCommandHistory.ts`                                                                    |
| 10/11/12 | 前景/背景/光标色查询                    | ⚠️ 只抑制查询 + 过滤回显,不做真实应答,远端程序无法探测主题明暗           | `renderer/utils/terminalControlSequenceCompat.ts`                                                                              |
| 1337     | iTerm2 扩展(CurrentDir/File/SetUserVar) | ❌ 无                                                                    | —                                                                                                                              |

### 现有实现的结构性问题

1. **OSC 7 解析绕过了 xterm parser**。`sanitizeSessionOutput`(`TerminalPane.tsx:361-411`)用手写扫描器(`utils/osc7.ts`)在 `term.write` 之前剥离 OSC 7,与 xterm 内置的跨 chunk 状态机重复造轮子。IPC 层 `ipc-stream-dispatcher.ts` 按 512KB 字节窗口切分,会在任意字节处切断序列——`osc7.ts` 自己维护 pending 状态来补救,但这套逻辑本应由 `terminal.parser.registerOscHandler` 免费获得。
2. **功能被 `monitorSession` 错误门控**。OSC 7 解析、cwd 跟踪、兼容 shim 全部要求连接开启 Monitor Session(`terminalSessionMonitoring.ts`、`session-service.ts:135`)。cwd 跟随、标题等是终端基础能力,与监控会话无关,普通连接即使远端 shell 主动发 OSC 7 也会被无视。
3. **Bootstrap 注入侵入性强**。为让远端发 OSC 7,主进程用 `openExecChannel` + `bash --init-file <mktemp>` / 临时 `ZDOTDIR` **重启用户 shell**(`terminal-osc7-bootstrap.ts:48-67`),改变 login/interactive 语义、依赖远端 mktemp、异常断开可能残留临时文件、与 starship 等 PROMPT_COMMAND 使用者冲突;且仅支持 bash/zsh,fish/POSIX sh/Windows 全无覆盖。
4. **兼容 shim 是"抑制"而非"应答"**。DA/DECRQM/OSC 10-12 查询被吞掉不回复,依赖这些回复的 TUI 会降级或反复重试。
5. **cwd 只有一个消费者**(SFTP 面板跟随,`FileExplorerPane.tsx:37-39`),标题、命令历史等潜在消费者未接入。

---

## 二、设计目标:"无感接入"

对标成熟客户端,"无感"意味着:

1. **被动优先(passive-first)**:远端环境本来就在发的序列(VTE 系发行版的 OSC 7、程序设置的 OSC 0/2、`ls --hyperlink` 的 OSC 8、启用了 shell 集成的 OSC 133)应**开箱即用**,不要求任何注入、不要求 monitorSession。
2. **注入是可选增强,不是前提**:shell 集成脚本走 iTerm2/WezTerm 模式——提供一份幂等的集成脚本 + 一键安装/临时注入选项,用户可关;检测到远端已自发 OSC 时自动跳过注入。
3. **默认安全**:OSC 52 写剪贴板默认开、读默认禁;外链点击需确认;通知受频控;所有开关进设置中心。
4. **统一接缝**:所有 OSC 处理收敛到 xterm `registerOscHandler`(渲染进程),需要主进程能力的(系统通知、任务栏进度、文件落盘)经显式 IPC 通道 + Zod 校验,符合项目三进程隔离规则。
5. **回放安全**:`TerminalPane` 是单例、切会话时会 `replaySessionOutput` 重放缓冲——**有副作用的 OSC(52 写剪贴板、9/777 通知、9;4 进度)在重放时必须静默**,只有幂等状态类 OSC(7/0/2/133 状态)允许重放时重建。

---

## 三、总体架构

新增渲染进程统一层 `renderer/terminal/oscRuntime.ts`(每个 xterm 实例安装一次):

```
SSH data ──IPC──▶ TerminalPane.onData ──▶ term.write(原文透传,不再预剥离)
                                              │
                                    xterm parser (跨chunk状态机)
                                              │
                              oscRuntime.install(terminal, ctx)
                              ├─ OSC 7   → sessionOscStore.setCwd
                              ├─ OSC 0/2 → sessionOscStore.setTitle   (也可用 terminal.onTitleChange)
                              ├─ OSC 52  → 门控 → navigator.clipboard / 拒绝读
                              ├─ OSC 8   → xterm 内置链接 + 确认弹窗
                              ├─ OSC 133 → sessionOscStore.commandMarks(提示符/命令/退出码)
                              ├─ OSC 9/777 → 频控 → IPC → 主进程 Notification
                              ├─ OSC 9;4  → IPC → BrowserWindow.setProgressBar
                              └─ OSC 10/11/12 → 真实应答当前主题色(替换抑制)
```

配套:

- **`store/useSessionOscStore.ts`**(新 Zustand store,或并入 `useWorkspaceStore`):`cwdBySession`、`titleBySession`、`marksBySession`、`progressBySession`。现有 `sessionCwdById` 迁移进来。
- **ctx(会话上下文)**:`{ sessionId, isReplaying(), prefs, sendIpc }`。`isReplaying` 由 TerminalPane 在重放窗口置位,副作用类 handler 检查后静默。
- **偏好落点**(按 CLAUDE.md 三件套同步规则):
  - `packages/core/src/index.ts` `terminal` 段新增:`oscClipboardWrite`(默认 true)、`oscClipboardRead`(默认 false)、`oscNotifications`(默认 true)、`oscTitleUpdates`(默认 true)、`shellIntegration: "auto" | "off" | "manual"`(默认 auto)、`hyperlinkConfirm`(默认 true)。
  - `packages/shared/src/contracts.ts` 加 Zod schema + 默认值;`packages/shared/src/channels.ts` / `api.ts` 加通知与进度通道。
  - UI:`settings-center/terminal-section.tsx` 新增「终端集成」分组。

---

## 四、分阶段实施计划

### Phase 0 —— 地基重构(先修半成品,不加新功能)

**目标:OSC 7 从"monitorSession 专属 + 手写剥离"变成"全会话通用 + xterm parser 原生处理"。**

| #   | 任务                                         | 文件                                                                  | 要点                                                                                                                                                                      |
| --- | -------------------------------------------- | --------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 0.1 | 新建 `oscRuntime.ts` 骨架 + ctx/回放静默机制 | `renderer/terminal/oscRuntime.ts`(新)                                 | install/dispose 生命周期;handler 注册表;单测覆盖注册与重放静默                                                                                                            |
| 0.2 | OSC 7 迁移到 `registerOscHandler(7)`         | `oscRuntime.ts`、`TerminalPane.tsx`                                   | 复用 `osc7.ts` 里的 `parseOsc7Path`(URL 校验/路径归一)作为纯函数;删除 `sanitizeSessionOutput` 中的剥离逻辑与 `osc7StateBySessionRef`;handler 返回 `true` 消费序列(不上屏) |
| 0.3 | 解除 `monitorSession` 门控                   | `TerminalPane.tsx:392`、`renderer/utils/terminalSessionMonitoring.ts` | OSC 7 解析对所有远端会话常开;bootstrap 注入仍可保留原开关(Phase 3 重做)                                                                                                   |
| 0.4 | cwd 消费保持兼容                             | `useWorkspaceStore.ts:360-373`、`FileExplorerPane.tsx`                | `setSessionCwd` 改由 oscRuntime 调用;SFTP 跟随行为不变(手动回归)                                                                                                          |
| 0.5 | 回归验证                                     | —                                                                     | `bun run typecheck`;手测:连接开/关 monitorSession 两种情况下 cwd 跟随、缓冲重放不重复触发                                                                                 |

**验收**:普通连接(未开监控)下,远端 shell 自发的 OSC 7 也能驱动 SFTP 跟随;OSC 7 序列不再以手写扫描方式处理;`osc7.ts` 中 chunk 状态机代码删除,仅保留 `parseOsc7Path` 纯函数及其测试。

### Phase 1 —— 核心标配 OSC(标题、剪贴板、超链接)

**OSC 0/2 标题**

- `oscRuntime` 订阅 `terminal.onTitleChange`(xterm 原生解析 OSC 0/2)→ `setSessionTitle(sessionId, title)`。
- `sessionTitle.ts` 的 `resolveSessionBaseTitle` 优先级改为:OSC 标题 → connection.name → host;偏好 `oscTitleUpdates=false` 时忽略。
- 会话结束/断开时清除 OSC 标题回退到连接名。
- 单测:`sessionTitle.test.ts` 增补 OSC 标题优先级用例。

**OSC 52 剪贴板**

- `registerOscHandler(52)`:解析 `Pc;Pd`,`Pd` 为 base64 → 写路径:偏好允许且非重放时 `navigator.clipboard.writeText`;`Pd="?"` 读路径:**默认拒绝**(不应答或按偏好允许后应答 base64)。
- 大小上限(如 1 MB)防恶意刷剪贴板;超限丢弃并 console.warn。
- 不引入 `@xterm/addon-clipboard`(其行为不可门控,自研 handler 约 40 行,便于接偏好与重放静默)。
- 单测:base64 解码、`?` 读拒绝、超限、重放静默。

**OSC 8 显式超链接 + 点击确认**

- xterm 6 核心已解析 OSC 8,需配置 `linkHandler`(`ITerminalOptions.linkHandler`)接收显式超链接;保留 WebLinksAddon 处理裸 URL。
- 统一点击出口:`hyperlinkConfirm=true` 时先弹 AntD confirm(展示完整 URL,防钓鱼——显示文本与目标 URL 可能不一致,这正是 OSC 8 的钓鱼面),确认后走现有 `dialog.openPath`。
- 主进程 `preferences-dialog-service.ts` 的 `parseExternalUrl` 增加 scheme 白名单(http/https/mailto),拒绝 `file://` 之外的任意 scheme 直开。

### Phase 2 —— Shell 集成(OSC 133)与命令语义

这是与成熟客户端差距最大的一块,也依赖 Phase 3 的注入通道才能"无感"覆盖未配置集成的远端。

- **解析**:`registerOscHandler(133)` 识别 `A`(提示符始)/`B`(提示符终/输入始)/`C`(输出始)/`D;exitCode`(命令终)。按会话累积 `CommandMark { promptLine, commandText?, exitCode?, startedAt, endedAt }` 入 `useSessionOscStore`。
- **命令文本捕获**:`B`→`C` 区间内通过 `terminal.buffer` 读取输入行文本(与 WezTerm 做法一致);作为现有命令历史的第二来源——终端里直接敲的命令也进 `commandHistory.push`(带去重,与 CommandInputBar 来源合并),补上现在"只记输入栏命令"的缺口。
- **UI 能力**(按序落地,前两个先行):
  1. 退出码标记:xterm decorations 在命令行 gutter 标红/绿点。
  2. 提示符跳转:Cmd+↑/↓ 在 marks 间滚动。
  3. (后续)命令块选择/复制输出、命令耗时提示。
- **重放兼容**:marks 属幂等状态类,重放时允许重建,但需在重放开始前清空该会话 marks 避免重复。

### Phase 3 —— Bootstrap 重做:可选注入的 shell 集成脚本

替换现有 `terminal-osc7-bootstrap.ts` 的"重启 shell + 临时 rcfile"方案:

- **单一集成脚本** `nextshell-shell-integration.sh`(打包进 app 资源):幂等(`NEXTSHELL_INTEGRATED` 环境哨兵)、同时发 OSC 7 + OSC 133 + OSC 0(可选)、兼容 bash/zsh/POSIX sh,另配 `.fish` 版本。参考 WezTerm `shell-integration.sh` 与 iTerm2 `it2_*` 的写法,PROMPT_COMMAND/precmd 追加而非覆盖。
- **注入策略(偏好 `shellIntegration`)**:
  - `auto`(默认):打开 shell 通道后,先观察首个提示符周期(~2s)内是否已收到 OSC 133/7;**收到则不注入**(远端已配 starship/wezterm/iTerm2 集成,天然无感);未收到且远端为受支持 shell,则通过 stdin 写入一行 `source` 命令(iTerm2 的 "inject" 模式),而不是重启 shell——保留 `openShell` 的真实 PTY 语义,废弃 `openExecChannel` 路径。写入的 source 行用 OSC 133 标记配合本地回显抑制,或退而求其次接受首行可见(WindTerm/Tabby 均如此)。
  - `manual`:设置中心提供「复制安装命令」(把脚本追加到远端 rc 的一行命令),不自动注入。
  - `off`:纯被动解析。
- **删除**:`createRemoteOsc7BootstrapPlan` 的 mktemp/exec-channel 机制、`resolveOsc7ShellFamily` 迁移为集成脚本的 shell 探测;`monitorSession` 与 OSC 彻底解耦(监控会话只保留其自身的 exec 采集通道)。
- **兼容 shim 收敛**:注入不再重启 shell 后,重评 `terminalControlSequenceCompat.ts` 的存在必要;将 OSC 10/11/12 从"抑制查询"改为**真实应答当前主题色**(从 `preferences.terminal.backgroundColor/foregroundColor` 换算 `rgb:RRRR/GGGG/BBBB` 回写 `session.write`),DA/DECRQM 保留 xterm 默认应答,仅在实测出回显污染的场景保留兜底过滤。

### Phase 4 —— 通知、进度与扩展序列

- **OSC 9 / 777;notify**:handler → 频控(如 5s/会话)→ 新 IPC `IPCChannel.TerminalNotification`(channels/contracts/api 三处同步)→ 主进程 `new Notification`;仅在窗口失焦或会话非活动时弹,点击通知聚焦对应会话。
- **OSC 9;4 进度**:解析 `st;pr` → 新 IPC → `BrowserWindow.setProgressBar`(state: normal/error/indeterminate);会话关闭/切换清零;可同时在 tab 上画进度环。
- **OSC 1337 子集**(低优先):`CurrentDir=` 作为 OSC 7 的备选 cwd 源;`SetUserVar` 存 store 备查。`File=`(内联图片/下载)单独立项——涉及主进程文件落盘与图片渲染(`@xterm/addon-image`),安全面大,不在本计划内承诺。

---

## 五、风险与对策

| 风险                                     | 对策                                                                                          |
| ---------------------------------------- | --------------------------------------------------------------------------------------------- |
| 解除剥离后 OSC 7 上屏乱码                | handler 返回 `true` 即被 xterm 消费,不会上屏;Phase 0 单测覆盖                                 |
| 重放触发副作用(剪贴板被覆盖、通知轰炸)   | ctx.isReplaying 静默机制,Phase 0 就位,后续 handler 强制走 ctx                                 |
| auto 注入的 source 行污染用户终端首屏    | 观察期检测已集成则跳过;可接受一行可见回显作为兜底,偏好可关                                    |
| OSC 52 被恶意远端滥用                    | 写默认开但限 1MB + 可关;读默认禁;远程会话与本地会话可分级                                     |
| OSC 8 钓鱼(显示文本≠目标)                | 点击确认弹窗展示真实 URL;scheme 白名单                                                        |
| 真实应答 10/11/12 后旧的回显污染问题复发 | 保留 `consumeTerminalQueryReplyChunk` 兜底过滤;灰度:先只对新注入路径启用真实应答              |
| IPC 契约漂移                             | 每个新通道同步改 `channels.ts` + `contracts.ts`(Zod)+ `api.ts` + `register.ts`,遵循 CLAUDE.md |

## 六、测试与验收

- **单测**(colocated `*.test.ts`):oscRuntime 注册/静默、OSC 52 解码与门控、OSC 133 状态机、标题优先级、10/11/12 应答格式、进度解析。
- **手工冒烟脚本**(加入 `docs/` 或脚本目录,连任意远端执行):
  ```sh
  printf '\e]0;TITLE-TEST\a'                 # tab 标题变化
  printf '\e]7;file://%s%s\a' "$(hostname)" "$PWD"   # SFTP 跟随
  printf '\e]52;c;%s\a' "$(printf hi | base64)"      # 剪贴板出现 "hi"
  printf '\e]8;;https://example.com\e\\link\e]8;;\e\\\n'  # 可点击+确认弹窗
  printf '\e]9;notify-test\a'                # 桌面通知
  printf '\e]9;4;1;50\a'                     # Dock/任务栏 50% 进度
  ```
- **回归**:连接 CRUD、终端开/重连、SFTP 动作、monitorSession 开关两态、缓冲重放、`bun run typecheck` 全绿。

## 七、里程碑排期建议

| 阶段 | 内容                                                  | 预估   |
| ---- | ----------------------------------------------------- | ------ |
| P0   | 地基重构(oscRuntime + OSC7 迁移 + 解耦门控)           | 2-3 天 |
| P1   | 标题 / 剪贴板 / 超链接 + 设置面板                     | 3-4 天 |
| P2   | OSC 133 解析 + 退出码标记 + 提示符跳转 + 命令历史补全 | 4-5 天 |
| P3   | Bootstrap 重做(auto/manual/off)+ 兼容 shim 收敛       | 4-5 天 |
| P4   | 通知 / 进度 / 1337 子集                               | 3 天   |

P0→P1 可直接串行开工;P2 与 P3 有耦合(133 的"无感覆盖"依赖 P3 注入),但 P2 的被动解析可先行。每阶段独立可发布,不产生用户可见的功能回退。
