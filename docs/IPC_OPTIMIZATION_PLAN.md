# IPC / 稳定性优化 — 进度存档

> 本文档整理本次会话从"挂机白屏+内存暴涨+CPU 占用"排查开始,到 IPC 专项体检与优化的完整目标、计划与当前状态。生成于 2026-07-05。未纳入 git 版本控制的一次性记录,供后续继续或复盘使用。

## 起因

用户反馈:运维挂着几个 SSH 会话,闲置几天不动后,软件白屏(界面组件消失,只剩空壳)、内存占用暴涨约 3 倍、持续吃 CPU。

## 根因结论

三个症状对应一条完整故障链:

1. **白屏** — 渲染进程没有任何 ErrorBoundary/全局错误处理,任何一次未捕获的渲染异常会卸载整棵 React 树。
2. **CPU 持续占用** — 主进程监控轮询(系统 1s / 进程 5s / 网络 5s)只有在 WebContents 被 destroy 时才停止,渲染进程崩溃/挂起/托盘隐藏都检测不到;休眠唤醒后 SSH keepalive 失效导致重连风暴。
3. **内存暴涨** — 终端数据流的 ack 背压机制在渲染进程不回应时没有超时,`finalizeRemoteSession` 的清理逻辑挂在 `closeWhenDrained` 上,永远等不到 drain 就永久泄漏会话、连接、channel。

## 已完成的工作(按阶段)

### 阶段 0 — 稳定性三件套修复(白屏 / CPU / 内存)
状态:**完成**,已提交于 `2c1bd3a feat(desktop): implement renderer auto-reload and monitor pause/resume functionality`

- 新增 `AppErrorBoundary.tsx` 顶层错误边界 + `main.tsx` 全局 `error`/`unhandledrejection` 处理器。
- 主进程监听 `render-process-gone`/`unresponsive`/`responsive`,自动 reload(5 分钟内最多 3 次)。
- 引入 `powerMonitor` 的 `suspend`/`resume`,窗口 `hide`/`show` 均联动暂停/恢复监控轮询。
- `isReceiverAlive` 加固(`isCrashed()` 检查);隐藏连接重连改为首次失败即指数退避(封顶 5 分钟);`onClose` 监听器用 WeakSet 去重注册。
- `ipc-stream-dispatcher` 增加 30s 无 ack 判定接收端死亡的 stall 超时 + 60s `closeWhenDrained` 硬上限,保证会话清理一定执行(修复了内存泄漏主因,顺带修了一个 drain 回调双重触发的存量 bug)。
- `packages/ssh` `exec()` 正常关闭路径补上 `removeAllListeners()`。
- `SystemStaticInfoPane.tsx` 改用可见性感知的 `pollingScheduler`。

### IPC 专项扫描(死代码 / 性能黑洞 / 过度设计)
状态:**完成**(纯调研,产出后续 4 个 Phase 的执行计划)

三路并行 Explore 扫描结论:
- **死代码**:4 个不可达 handler(`BackupPassword*`)+ 14 个渲染层零调用的完整垂直切片(`templateParams.*`、`resourceOps` 4 个方法、`backup.*` password 别名、`audit.list`、`storage.migrations`、`savedCommand.list` 非 scoped 版)。
- **性能黑洞**:终端流停等式 ack 协议把吞吐锁死在 IPC 往返延迟上;同一段数据被重复编码/扫描 5 次以上(iconv、Buffer.byteLength 多次测量、TextEncoder 两遍、每帧 store 线性扫描)。
- **过度设计**:ServiceContainer 72 个方法中约 66 个是纯 1:1 转发;register.ts 111 个 handler 手写同一模板;监控快照套用为高吞吐流设计的 ack 协议纯属多余;返回值类型三处手写、互不约束。

### Phase 1 — 死代码删除 + 热路径修复
状态:**完成**,已提交(与 Phase 2 合并入 `51db376 feat(desktop): streamline IPC dispatcher and session management`)

- 删除 6 个死 IPC 垂直切片(channel + schema + handler + preload + api.ts 类型全删),typecheck 全绿,repo-wide grep 确认零残留引用。
- 热路径四项修复:
  1. `decodeTerminalData` UTF-8 快路径(`buffer.toString` 替代 `iconv.decode`)。
  2. dispatcher 字节数改为增量维护的 `pendingChunkBytes`,避免每帧 4-6 次 `Buffer.byteLength` 重复测量;顺带修了不同 JavaScript 运行时对孤立代理对字节数估算不一致的问题。
  3. `sessionOutputBuffer.appendWithLimit` 每个 chunk 只编码一次、原地 mutate 而非展开复制;顺带修了一个可能导致渲染进程死循环卡死的存量 bug(全缓冲区裁剪时特定多字节边界会无限循环)。
  4. `TerminalPane.sanitizeSessionOutput` 用 ref Map 缓存 session/connection 查找,避免每帧线性扫描整个 store。
- 双视角对抗审查:1 条 minor 发现(孤儿 schema 还需要后续阶段清理),0 条 confirmed 需要立即修复。

### Phase 2 — 监控流去 ack 化
状态:**完成**,已提交(与 Phase 1 合并入同一 commit `51db376`)

- 删除 `createLatestOnlyDispatcher` 整套(在途/合并/ack 协议),监控三路快照(系统/进程/网络)改为裸 `sender.send`,仅做 `!isDestroyed() && !isCrashed()` 守卫。
- `streamKindSchema` 收窄为 `["session"]`,ack 协议现在只服务终端流。
- 审查发现 1 条 minor(阻塞但存活的渲染进程会导致快照消息在 IPC 队列无界累积)——已追加代码注释说明该风险由"unresponsive 自动重载"和"隐藏/休眠暂停轮询"兜底,未做额外机制(评估为可接受的已知权衡)。

### Phase 3 — 终端流滑动窗口 + 攒批 ack
状态:**完成**,已提交(与 Phase 4 合并入 `1057ecc refactor(desktop): reorganize IPC handlers and introduce registry for improved maintainability`)

- 停等式协议 → 滑动窗口:多帧可在 `highWaterBytes`(512KB)窗口内同时在途,渲染进程按累计字节 delta 攒批 ack(阈值 128KB 或 50ms 定时器触发),不再是每帧一次 IPC 往返。
- 中途一次严重卡死事故:实现代理(当时误配置为 Opus)长时间无产出,判定为模型/服务临时不可用,停止工作流、去掉 model 覆盖后用 `resumeFromRunId` 续跑,改由 Fable 完成实现,问题解决。
- **三视角对抗审查发现 5 个 confirmed 严重缺陷**(2 critical + 2 major 等价问题,实为同一类 bug 的不同表现):
  - deliveryId 单调递增假设与渲染进程双路径攒批(同步 flush + xterm write 回调异步 flush)冲突,导致合法的"回退"ack 被丢弃,`inFlightBytes` 永久虚高 → 复现原本的内存泄漏 bug 类型。
  - 流被 `dropStalledStream` 重建后 deliveryId 计数器不归零(全局递增),旧 incarnation 的迟到 ack 会被新 incarnation 误接受,导致窗口计数下溢。
- 已修复:为每个流 incarnation 引入 `firstDeliveryId` 下限围栏,ack 接受逻辑与 deliveryId 单调性解耦,只按字节 delta + 上限/下限围栏校验。修复后重新跑测试全绿(dispatcher 覆盖窗口填满/攒批 ack/多字节/背压/stall/deadline/过量 ack 等场景)。

### Phase 4 — 容器扁平化 + register.ts 表驱动 + 孤儿代码清理
状态:**实现已完成,本地验证已在本轮补齐**(工作流内置的 verify 阶段因触碰到 API 会话额度限制而中止,不是代码问题;已在本地重新跑通)

- **Cleanup(Opus)**:删除 Phase 1 标记的孤儿 service/container 方法(`listAuditLogs`、`listMigrations`、`listTemplateParams` 等）及 contracts.ts 中的孤儿 schema,并把 `backupPassword*Schema` 别名内联进 `masterPassword*` 名下。
- **Restructure(Fable)**:
  - `ServiceContainer` 从 ~170 个重复签名瘦身为 11 个只读子服务属性(`connections`/`sessions`/`sftp`/`monitors`/... )+ 少数真正的编排方法(`removeConnection`/`recycleBinList`/`pauseMonitors`/`resumeMonitors`/`dispose` 等）。
  - `register.ts` 从 ~97 个手写 `ipcMain.handle` 块改为新建的 `apps/desktop/src/main/ipc/registry.ts` 表驱动注册(每条 `channel/schema/label/dispatch`),register.ts 现在只是一个通用注册循环。
  - 新增 `registry.test.ts`:静态断言无重复 channel、97 个 preload 会 invoke 的 channel 与注册表一一对应。
- **本轮补齐的本地验证**(工作流因限额未跑完的部分):`pnpm run typecheck` 全绿;`registry.test.ts`(97/97 channel 对齐)、`ipc-stream-dispatcher.test.ts`、`contracts.stream-delivery.test.ts`、`sessionOutputBuffer.test.ts`、6 个 monitor 测试、`AppErrorBoundary.test.tsx` 全部通过。
- **遗留的两个已知孤儿方法(有意保留,未删)**:`resource-operations-service.ts` 的 `dangerMoveConnection`(:197)和 `copySshKey`(:513)—— cleanup 代理的任务范围只列了 command-service/backup-password-service/connection-service 三个文件,未涉及 resource-operations-service,且该服务是一个有独立类型定义的完整 API,判断删除超出"纯机械删除"边界,留作后续跟进项。
- **`packages/storage` 层的伴生孤儿复核修正**:`listAuditLogs`/`listMigrations`/`listTemplateParams`/`upsertTemplateParams` 当前在服务层未见调用者,但 `clearTemplateParams` 仍被 `CommandService.removeSavedCommand()` 用于删除本地 saved command 时清理遗留参数。因此后续不能把 template params 仓储 API 整组机械删除,需要先确认或替代这条清理路径。

## 复核结论(2026-07-05)

按当前 checkout 重新核对 plan 与代码后,未发现 `1057ecc` 里需要立即修复的 blocker。Phase 3/4 的主要目标与代码基本一致:终端流已改为滑动窗口 + 批量 delta ack,`ServiceContainer` 已扁平化为子服务属性 + 少量编排方法,`register.ts` 已改为表驱动注册,Phase 1 标记的多数孤儿 IPC/schema/service 方法已清理。

需要修正的是 plan 文档本身的几处事实:

1. `main` 当前只比 `origin/main` 超前 1 个提交(`1057ecc`);`2c1bd3a` 和 `51db376` 已在 `origin/main` 上。`IPC_OPTIMIZATION_PLAN.md` 自身是未跟踪文件,所以工作区不是完全干净。
2. `registry.test.ts` 只证明 preload invoke 的 97 个 channel 都有 registry entry 且无重复,不能证明每个 dispatch 与旧 handler 行为完全等价。本次人工对照旧 `register.ts` 后,连接/会话/监控/SFTP/云同步/SSH key/debug/resource/recycle bin 的 dispatch 路径没有发现明显行为漂移。
3. `resource-operations-service.ts` 中 `dangerMoveConnection` 和 `copySshKey` 仍是内部孤儿方法,但对应的 shared contract schema/type 已经删掉;后续若删除这两个方法,不再需要“连带删 contracts.ts 输入类型”。
4. `packages/storage` 的 template params 相关 API 不能按“全无调用者”处理:`clearTemplateParams` 仍有实际调用点。

## 当前代码状态

- 当前分支:`main...origin/main [ahead 1]`,仅 `1057ecc refactor(desktop): reorganize IPC handlers and introduce registry for improved maintainability` 尚未推送。
- 工作区只有 `IPC_OPTIMIZATION_PLAN.md` 是未跟踪/本地记录文件;代码 diff 相对 `origin/main...HEAD` 集中在 12 个文件。
- 复核时重新执行并通过:`pnpm run typecheck`;`pnpm exec tsx apps/desktop/src/main/ipc/registry.test.ts`;`pnpm exec tsx apps/desktop/src/main/services/ipc-stream-dispatcher.test.ts`;`pnpm exec tsx packages/shared/src/contracts.stream-delivery.test.ts`;`pnpm exec tsx apps/desktop/src/renderer/utils/sessionOutputBuffer.test.ts`;6 个 monitor 测试;`pnpm exec tsx apps/desktop/src/renderer/components/AppErrorBoundary.test.tsx`;`git diff --check origin/main...HEAD`。

## 尚未做 / 建议的后续项

1. **手动冒烟测试**(代码验证无法替代):开若干 SSH 会话 → 合盖休眠几分钟 → 唤醒,确认监控恢复、终端 Enter 可重连、内存平稳;DevTools 里 `process.crash()` 验证自动重载;终端里 `cat` 大文件验证滑动窗口吞吐提升;来回切换会话标签验证 ack 攒批不会误判连接死亡。
2. ~~`resource-operations-service.ts` 的 `dangerMoveConnection`/`copySshKey`~~ — **已完成(2026-07-05,未提交)**:删除两个方法及仅被 `dangerMoveConnection` 使用的 `DangerMoveConnectionInput` 接口(-57 行);`deleteConnection`(container.ts 在用)与 `ensureSshKeyInScope`(copyConnection 在用)确认有调用者,保留。
3. ~~`packages/storage` 层伴生孤儿仓储方法~~ — **已完成(2026-07-05,未提交)**:删除 `listAuditLogs`/`listMigrations`/`listTemplateParams`/`upsertTemplateParams` 的接口声明+缓存包装+SQLite 实现,连带孤儿 helper(`rowToAuditLog`/`rowToMigration`/`fromMetadataJSON`)、缓存字段(`migrCache`/`tplCache`)与测试 mock(共 -244 行)。`clearAuditLogs`/`clearTemplateParams` 有真实调用者,完整保留。验收:typecheck 全绿,storage 测试与 registry.test(97/97)通过,repo-wide grep 零残留。
   - 新发现的后续项:`command_template_params` 表现在只剩 `clearTemplateParams` 一个只删不增不查的调用路径,可评估连表带 schema/迁移一并废弃。
4. 如需要,把 `1057ecc` 及上述未提交的清理改动 push 到远端。

## 模型分工偏好(已存入长期记忆)

- 复杂/有规模的实现 → Fable(默认,不加 model 覆盖)。
- 目的清晰、显而易见的执行与修复 → Opus(`model: 'opus'`)。
- 验收/审查/裁判 → 一律 Fable。
- 教训:Phase 3 一度因把"滑动窗口协议改造"这种复杂实现误配置为 Opus 而卡死无产出,去掉覆盖后交给 Fable 才顺利完成——印证了上述分工规则。
