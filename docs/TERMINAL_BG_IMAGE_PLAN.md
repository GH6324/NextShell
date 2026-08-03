# 终端透出程序背景图（壁纸穿透）— 调查结论与实施计划

> **状态**：调查完成，待实施（排队于 OSC 遗留问题之后）
> **调查日期**：2026-07-25（Claude Fable 调查会话产出）
> **面向读者**：实施 agent。本文档自包含，不依赖原调查会话上下文。
> **产品意图（用户原话归纳）**：用户设置图片后，**图片作为整个程序的背景**，终端界面也能**透明透过图片**；不是给终端单独配一张图。功能可选——不设图的用户继续用纯色，行为与现在完全一致。
> **重要**：仓库历史上（2026-02）对"终端透明"的"不可行"结论**已被推翻**，不要沿用任何旧结论。
> **工具链注意**：仓库已迁移 pnpm（commit `6a21a32`），CLAUDE.md 里的 `bun` 命令是旧文档；类型检查用 `pnpm run typecheck`。

---

## 0. TL;DR

App 已有完整的"程序壁纸"体系：`window.backgroundImagePath` 壁纸层 + 各面板按 `--app-background-opacity` 半透明化（session-tabs、terminal-shell 等都已接入）。**唯一挡住壁纸的就是终端本体**：xterm 画布画了不透明纯色 + `.xterm-viewport` 被官方样式表垫了黑底。

当年（2026-02，`0eea093`）就是想做终端透明，做法完全正确（`allowTransparency:true` + 透明 `theme.background`），但被 **xterm 6.0.0 发布版的一处样式表回归**（`.xterm .xterm-viewport { background-color:#000 }` 无条件生效）挡住，误判为不可行而回退。**应用侧一行 CSS 覆盖即可绕过**，已用本仓库 node_modules 的原包做过带截图实机验证：WebGL + 透明背景渲染完全正常，6 万行彩色输出压测无残影。

实施规模比想象小得多：**图片加载、协议白名单、CSP、选图 UI 全部零改动**（继续用现有壁纸设置），核心改动只有——终端画布透明化（TerminalPane 构造参数 + 重建策略）、一行 viewport CSS 覆盖、两个新布尔偏好、渲染器保守策略（见 §5.6）。

---

## 1. 背景与历史

### 1.1 现状与目标

现状：设置壁纸后（设置中心「APP 背景」卡片），壁纸透过侧栏/标签栏等半透明面板可见，但**终端区域是一块不透明纯色**（`terminal.backgroundColor`），把壁纸挡住——正是用户不满意的点。

目标：壁纸模式下终端也半透明，文字浮在壁纸上（带压暗保证可读性）；无壁纸时保持纯色，路径零变化。

### 1.2 历史时间线（git 考古，均可 `git show` 验证）

| Commit    | 日期       | 内容                                                                                                                                                                                                      |
| --------- | ---------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `0eea093` | 2026-02-20 | 实现过终端背景图：`allowTransparency: true` + `theme.background = "rgba(0,0,0,0)"` + 容器贴图。**透明看似不生效**（根因见 §2）                                                                            |
| `3727b2c` | 2026-02-21 | 回退：图片降级为 App 壳壁纸（`window.backgroundImagePath`），面板半透明体系（`--app-background-opacity` + color-mix）由此建立；storage 加了 legacy 迁移把旧 `terminal.backgroundImagePath` 搬到 window 层 |
| `7f466b2` | 之后       | 移除 `allowTransparency: true`，终端回到不透明纯色（今日现状）                                                                                                                                            |

### 1.3 现有壁纸体系（本方案的接入点，全部现成）

- **壁纸层**：`App.tsx:640-650` — `window.backgroundImagePath` 非空时渲染 `.app-wallpaper-layer`（`nextshell-asset://local<path>`，cover，`opacity: var(--app-background-opacity)/100`），根元素挂 `app-shell--with-wallpaper` 类 + `--app-background-opacity` 变量（来自 `window.backgroundOpacity`，30–80）。
- **面板半透明**：`.app-shell--with-wallpaper .terminal-shell { background: color-mix(in srgb, #0b1829 calc(var(--app-background-opacity)*1%), transparent) }`（`styles/terminal.css:12-14`）；session-tabs 同款（`session-tabs.css:14-16`）；`reset.css:43+` 把 `--bg-base/--bg-surface/--bg-elevated` 全套换成 color-mix。**`.terminal-shell` 在 `WorkspaceLayout.tsx:876`。**
- **协议与 CSP**：`nextshell-asset://` 只放行 `window.backgroundImagePath` 一个路径（`main/index.ts:284-295` + `asset-protocol.ts` + 测试）；CSP 已含 `img-src nextshell-asset:`。**本方案不改这些**（不引入新图片路径）。
- **偏好链路**：`window.nextshell.settings.get/update`（`usePreferencesStore.ts:116/162`）；Zod 契约 `packages/shared/src/contracts.ts`（完整 schema ~L476、patch ~L615）；类型/默认值 `packages/core/src/index.ts`（`AppPreferences` L535、`AppPreferencesPatch` L621、`DEFAULT_APP_PREFERENCES` L782）；storage 防御解析 `packages/storage/src/index.ts` ~L640-680；主进程 patch 合并 `main/services/preferences.ts` ~L193。

---

## 2. 根因分析：当年为什么"终端透明不生效"

### 2.1 结论

`0eea093` 的透明做法**本身是对的**。失败根因：

**xterm 6.0.0 发布版 `xterm.css`（`node_modules/.pnpm/@xterm+xterm@6.0.0/.../css/xterm.css` L93-96）：**

```css
.xterm .xterm-viewport {
    /* On OS X this is required in order for the scroll bar to appear fully opaque */
    background-color: #000;
    overflow-y: scroll;
```

这条规则**无条件生效**，在（其实已正确透明的）WebGL 画布下垫了一层不透明黑。上游 master 的同条规则带 `:not(.allow-transparency)` 守卫（`allowTransparency:true` 时 xterm 给根元素加 `allow-transparency` 类跳过黑底），但：

- 6.0.0 发布版 css 里 `allow-transparency` 出现次数 = **0**（`grep -c` 验证）；
- 6.0.0 源码（`src/`）里**完全没有**该类的切换逻辑（`grep -rn` 零命中）。

这是 6.0 重写滚动条（上游 PR #5096，官方自标 ⚠️ breaking）时的**回归**：master 后来修回，但 6.0.0 stable 没带，且无 6.0.x 补丁版（stable 最新 = 6.0.0；6.1.0 只有 beta）。**依赖升级解决不了**（已在最新 stable），应用侧一行 CSS 覆盖即可（§5.4）。

### 2.2 渲染链路其余环节全部支持透明（逐层源码证据，出自本仓库安装版本）

| 环节         | 位置                                                          | 证据                                                                                                                                                |
| ------------ | ------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------- |
| WebGL 上下文 | `addon-webgl/src/WebglRenderer.ts` L83-88                     | `contextAttributes = { antialias:false, depth:false, preserveDrawingBuffer }` —— **没有 `alpha:false`**，WebGL2 默认 `alpha:true`，画布可与页面合成 |
| 背景清屏矩形 | `addon-webgl/src/RectangleRenderer.ts` L179/L183-194/L374-381 | 全屏背景矩形用 `colors.background` 绘制；`_colorToFloat32Array` 保留 RGBA **全部四个分量**                                                          |
| 主题解析     | `@xterm/xterm/src/browser/services/ThemeService.ts` L84       | `parseColor(theme.background, ...)` 原样保留 alpha                                                                                                  |
| 滚动层配色   | `@xterm/xterm/src/browser/Viewport.ts` L74                    | 主题背景 css 写到 `scrollableElement.getDomNode()`——**不是** `.xterm-viewport`，所以救不了上面的回归                                                |
| 纹理图集     | `addon-webgl/src/TextureAtlas.ts`                             | `allowTransparency` 有 11 处功能分支，透明字形处理是完整实现                                                                                        |

---

## 3. 实验验证过程与结果

### 3.1 方法

把**本仓库 node_modules 安装的原包**（`@xterm/xterm@6.0.0` `lib/xterm.js`+`css/xterm.css`、`@xterm/addon-webgl@0.19.0` `lib/addon-webgl.js`）复制进独立 HTML 测试页：body 铺高饱和渐变+色块"壁纸"，两个终端都开 `allowTransparency:true` + WebglAddon——Case A `theme.background="rgba(0,0,0,0)"`（全透明）、Case B `"rgba(11,24,41,0.45)"`（半透明压暗）。写入 ANSI 16/256 色、反显、选中、中文宽字符，用 Playwright（Chromium，与 Electron 同内核）截图 + 读诊断。测试页全文见附录 A，2 分钟可复现。

### 3.2 结果

| #   | 验证项                                                                                              | 结果                                                                                                                                          |
| --- | --------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | 未覆盖 viewport CSS                                                                                 | ❌ 终端区域不透明（A 纯黑；B 恰好 = 0.45 alpha 叠**纯黑**的颜色）——复现当年"失败"，并指认黑底来源                                             |
| 2   | DOM 层排查                                                                                          | `.xterm-viewport` computed `rgb(0,0,0)`（stylesheet 来源）；WebGL canvas `gl.getContextAttributes().alpha === true`；WebglAddon 两例均 ACTIVE |
| 3   | 加 `.xterm-viewport { background-color: transparent !important }` 后                                | ✅ A：文字直接浮在壁纸上，色块清晰透出；B：壁纸均匀压暗透出。带色单元格（ANSI bg、反显、选中高亮）保持自身不透明底色                          |
| 4   | 压测：每终端共 6 万行彩色输出（红/绿 diff、256 色块、反显、中文宽字符）burst 写入 + 翻滚 scrollback | ✅ 无字形残影、无错位、无崩溃；40k 行写入 863ms、20k 行 98ms                                                                                  |

截图在调查会话临时目录（可能已被清理，重跑附录 A 可再生成）：`/private/tmp/claude-501/-Users-ztwang-repo-nextshell/206fb2d0-d178-462d-b6a8-19308b0021e7/scratchpad/xterm-poc/`。

### 3.3 实验注意事项（踩过的坑）

- Playwright 截图反复 5s 超时 ≠ 页面挂了：浏览器窗口被遮挡时 Chromium 把 rAF 节流到 ~1fps，截图管线卡死；`page.bringToFront()` 后恢复。压测结论已在 60fps 可见状态复核。
- 压测局限：单页 burst ≠ 真实 SSH 数小时持续流式输出的图集压力，不能据此断言上游 #5847（§4.2）在 Electron 绝不发生。

---

## 4. 外部调查结论（上游 & 同行，2026-07 时点）

### 4.1 上游 xterm.js

- **WebGL 透明是官方支持路径**：跟踪 issue #2252（2019 开、2022-07-30 关闭）；6.0.0 仍在投入（#5260/#5262 光标 alpha 混合、#5335）。"WebGL 不支持透明"是 2019–2022 的旧事实，网上残留大量过时论述——早期调查即被此误导。
- `allowTransparency`：必须 `open()` 前设置，运行时改需重开终端；官方注明"可能有性能负面影响"（未量化）。
- VS Code 只为 Sixel 内联图片（`enableImages`）开 `allowTransparency`，无背景透明功能。

### 4.2 待留意的上游缺陷

| Issue/PR                                                                                                                          | 状态            | 影响与对策                                                                                                             |
| --------------------------------------------------------------------------------------------------------------------------------- | --------------- | ---------------------------------------------------------------------------------------------------------------------- |
| **#5847** WebGL+透明+持续大流量输出 → 字形图集残影。fix **PR #5883 已合并（2026-05-21）但无 0.19.1**，只在 0.20.0-beta/6.1.0-beta | 修复未入 stable | SSH `cat 大文件`/编译日志正是触发画像 → **透出模式默认 DOM 渲染器**（§5.6），0.20.0 stable 后升级翻转。不要提前上 beta |
| #4212 `allowTransparency:true` 字形偏细                                                                                           | open            | 主观观感，压暗层降低感知，可接受                                                                                       |
| #1898 全透明背景反显极端 case（fix PR #5804 被关未合）                                                                            | open            | 我们前景色不透明、PoC 反显实测正常；保持关注                                                                           |

### 4.3 同行实现（源码确认）

- **electerm**（最像的 Electron SSH 客户端）：`allowTransparency` 恒开；**背景图/透明只走 DOM 渲染器且 DOM 是其全局默认**（webGL 时强制不透明背景，`terminal-color-query.mjs`）。
- **Hyper**：背景 alpha<1 时**主动禁用 WebGL** 并 console.warn（基于旧 xterm 5.x 时代的判断）。
- **Tabby**：vibrancy 时终端 `#00000000`，不禁 WebGL → 有活 bug（#646 反显文字消失，对应上游 #1898）。

**同行共同模式**：透明模式下避开 WebGL。本计划采纳同样保守默认，但因实测 6.0 WebGL 透明是好的，保留实验开关，#5883 进 stable 后翻转（§5.6）。

---

## 5. 实施计划（按依赖顺序）

> 设计原则：**图片相关一切复用现有壁纸体系**——不加新图片路径、不动 `asset-protocol.ts`、不动 CSP、不加选图 UI。终端只是作为"又一块面板"接入 `app-shell--with-wallpaper` 半透明体系，透明条件完全由现有 `window.backgroundImagePath` 是否非空驱动。
> 涉及 IPC 契约时遵守 CLAUDE.md：`packages/shared/src/` 与 main 同步改；本功能不加新通道，只扩 schema。

### 5.1 偏好：两个新布尔（唯一 schema 改动）

**`packages/core/src/index.ts`** 三处（`AppPreferences` L535 区 / `AppPreferencesPatch` L621 区 / `DEFAULT_APP_PREFERENCES` L782 区）：

```ts
terminal: {
  // ...现有字段...
  wallpaper: {
    seeThrough: boolean; // 壁纸模式下终端是否透出，默认 true
    useWebgl: boolean; // 透出时仍用 GPU 渲染（实验），默认 false
  }
}
// 默认值：{ seeThrough: true, useWebgl: false }
```

**`packages/shared/src/contracts.ts`** 两处：

```ts
// 完整 schema（terminal 对象内，≈L476 区）：
wallpaper: z
  .object({
    seeThrough: z.boolean().default(DEFAULT_APP_PREFERENCES.terminal.wallpaper.seeThrough),
    useWebgl: z.boolean().default(DEFAULT_APP_PREFERENCES.terminal.wallpaper.useWebgl)
  })
  .default(DEFAULT_APP_PREFERENCES.terminal.wallpaper),
// patch schema（≈L615 区）：两字段 .optional() 的镜像对象，整体 .optional()
```

**`packages/storage/src/index.ts`**（terminal 解析段 ≈L650-680）：对 `parsed.terminal?.wallpaper` 两个布尔做 typeof 校验，非法回退默认。
**`main/services/preferences.ts`**（≈L193 区，仿 localShell 嵌套合并）：`patch.terminal?.wallpaper` 逐字段合并。
`contracts.preferences.test.ts` 补默认值/patch 用例（正常 + 一条失败路径）。

> ⚠️ **命名红线**：不要引入任何叫 `terminal.backgroundImagePath` 的字段——`packages/storage/src/index.ts:603-605` 的 legacy 迁移会把该名字当旧数据搬去 `window.backgroundImagePath`。该迁移逻辑保持原样不动。本方案的 `terminal.wallpaper.*` 与之无冲突。

### 5.2 透明条件的单一来源

```ts
// TerminalPane 内派生（原始布尔，别把对象放 deps）：
const wallpaperActive = usePreferencesStore(
  (s) => s.preferences.window.backgroundImagePath.trim().length > 0
);
const seeThrough = usePreferencesStore((s) => s.preferences.terminal.wallpaper.seeThrough);
const useWebglWhenTransparent = usePreferencesStore(
  (s) => s.preferences.terminal.wallpaper.useWebgl
);
const transparencyEnabled = wallpaperActive && seeThrough;
```

`transparencyEnabled === false` 时（无壁纸、或用户关掉透出）→ **一切走现状路径**（不透明纯色 + WebGL），零回归。

### 5.3 TerminalPane 改造（`apps/desktop/src/renderer/components/TerminalPane.tsx`）

1. **构造选项**（挂载 effect L737-753）：

```ts
const terminal = new Terminal({
  cursorBlink: true,
  allowTransparency: transparencyEnabled,
  // ...
  theme: {
    background: transparencyEnabled ? "rgba(0, 0, 0, 0)" : terminalPreferences.backgroundColor
    // foreground/cursor 不变
  }
});
```

画布全透明；压暗统一交给 `.terminal-shell` 的 color-mix 层（§5.4），单元格区与四周留白视觉完全一致，无"光晕"缝。

2. **WebGL 加载门控**（L777-785 的 try/catch 外包一层）：

```ts
if (!transparencyEnabled || useWebglWhenTransparent) {
  try {
    /* 现有 WebglAddon 加载 + onContextLoss */
  } catch {
    /* 现状 */
  }
}
// 不加载 = xterm 6 内建 DOM 渲染器（canvas 渲染器 6.0 已被上游移除，#5105）
```

3. **重建策略**：`allowTransparency` 不能运行时改 → 把 `transparencyEnabled`、`useWebglWhenTransparent` 加进挂载 effect 依赖数组（现为 `[handleLocalAuthInput, message, tryReconnectOnEnter]`）。依赖变化时 React 先跑 cleanup（已完整 dispose + 置空 refs），effect 自然重建；重建后若 `sessionIdRef.current` 存在，调用现成 `replaySessionOutput(sessionIdRef.current)` 恢复画面（缓冲都在 ref 里跨重建存活），再 `fitAddon.fit()` + resize 上报。壁纸透明度滑杆（`--app-background-opacity`）变化是纯 CSS，**不触发重建**。
4. **主题热更新 effect**（L998-1034）：background 分支与构造保持同一条件式，deps 补 `transparencyEnabled`。

### 5.4 CSS（`apps/desktop/src/renderer/styles/terminal.css`）

```css
/* xterm 6.0.0 回归：官方 xterm.css 无条件写死 .xterm-viewport 黑底
   （master 已改为 .xterm:not(.allow-transparency) 守卫，6.0.0 未包含）。
   升级到带守卫的 xterm 版本后删除本条。 */
.terminal-shell .xterm-viewport {
  background-color: transparent !important;
}
```

无条件生效是安全的：不透明模式下该黑底本来就被画布盖住；透明化后露出的是 `.terminal-shell` 自己的背景。无条件比按类门控少一个"忘加类就黑屏"的失败模式。

**压暗层（可读性）**：`.terminal-shell` 的既有规则已经就是压暗层（`color-mix(#0b1829 opacity%, transparent)`），随现有「整体透明度」滑杆（30–80）联动。推荐小增强（可选，不阻塞）：把写死的 `#0b1829` 换成跟随用户终端底色——在 `App.tsx` 的 `appShellStyle` 里多注入一个变量 `--terminal-tint: <terminal.backgroundColor>`，CSS 改为 `color-mix(in srgb, var(--terminal-tint, #0b1829) calc(var(--app-background-opacity)*1%), transparent)`。若嫌多余可跳过，固定 #0b1829 观感也成立。

### 5.5 设置 UI（`settings-center/terminal-section.tsx`）

在现有「APP 背景」卡片里加两行（无壁纸时禁用）：

- Switch「终端透出背景图」→ `debouncedSave("terminal", { wallpaper: { seeThrough, useWebgl } })`（注意 `debouncedSave` 的 section 合并是浅合并，嵌套对象每次发**完整** wallpaper 对象）；
- Switch「透出时启用 GPU 加速」，hint：「实验性：大流量输出可能出现残影（上游 xterm #5847）」。

`SettingsCenterModal.tsx` 仿 `appBackgroundImagePath` 的既有方式把 props/setter 线程下去（L60/L132 附近）。切换任一开关会触发终端重建（§5.3），会话内容自动 replay，属预期行为。

### 5.6 渲染器策略（已定，不需再调研）

- **不透明模式**（无壁纸或 seeThrough=false）：现状零变化（WebGL + 纯色）。
- **透出模式（默认）**：不加载 WebglAddon → DOM 渲染器。依据：上游 #5847 修复未入 stable；electerm 全量用户默认 DOM 证明 SSH 场景可用。
- **透出 + useWebgl=true（实验）**：加载 WebGL。本仓库版本实测透明渲染正确、6 万行压测无残影（§3）。
- **翻转条件**：`@xterm/addon-webgl` 发布首个含 PR #5883 的 **stable**（预计 0.20.0，配套 xterm 6.1.0）后：升级 → `useWebgl` 默认翻 true（或删开关）→ 复测 §6 → 检查新版 xterm.css 是否恢复 `:not(.allow-transparency)` 守卫，是则删 §5.4 覆盖。**不要提前上 beta。**

---

## 6. 验收标准与冒烟清单

1. `pnpm run typecheck` 通过。
2. **无壁纸零回归**：默认配置下 WebGL 激活、纯色背景、外观与改动前一致。
3. 设置壁纸后：壁纸透进终端区域，亮度随「整体透明度」滑杆联动，与 session-tabs/侧栏观感一致；ANSI 16/256 色背景、反显、选中高亮、SearchAddon 搜索高亮均保持不透明底色；中文/宽字符正常。
4. 关闭「终端透出背景图」：终端回到不透明纯色（壁纸仍在其他面板可见）；重开恢复透出。两方向切换都经重建 + replay，不闪断会话、不影响输入/重连/认证提示流。
5. 调「整体透明度」滑杆：终端亮度即时变化，**不触发重建**。
6. 大流量：SSH 会话 `cat` 大文件或 `yes | head -100000`——DOM 路径无残影不卡死；实验 WebGL 路径同测并留意残影（出现属已知上游风险，记录即可）。
7. 清除壁纸图片：终端与全部面板回到纯色路径。
8. CLAUDE.md 冒烟基线：连接 CRUD、终端开/重连、SFTP 动作无回归。
9. 提交规范：`feat(desktop): ...`（可拆 `feat(shared)`/`feat(storage)` 等）。

## 7. 非目标（本期不做）

- **给终端单独配独立背景图**（用户已明确否决该方向；electerm 的 per-tab 背景仅作未来参考）。
- 远程 URL 图片（CSP 只放行 `nextshell-asset:`）。
- 窗口级/OS 级透明（vibrancy/毛玻璃）——真正的坑，继续不碰。
- 壁纸的 fit/blur 等展示参数扩展（现有 cover + 透明度已满足；要做也是壁纸体系的事，不属本任务）。

---

## 附录 A：PoC 复现步骤与测试页全文

```bash
mkdir -p /tmp/xterm-poc && cd /tmp/xterm-poc
R=<仓库根>/node_modules/.pnpm
cp "$R/@xterm+xterm@6.0.0/node_modules/@xterm/xterm/lib/xterm.js" .
cp "$R/@xterm+xterm@6.0.0/node_modules/@xterm/xterm/css/xterm.css" .
cp "$R/@xterm+addon-webgl@0.19.0/node_modules/@xterm/addon-webgl/lib/addon-webgl.js" .
# 保存下方 index.html 后：
python3 -m http.server 8391 --bind 127.0.0.1   # 打开 http://127.0.0.1:8391/index.html
```

预期：两个终端的文字浮在彩色壁纸上（A 全透、B 压暗）；删掉页内 `.term-box .xterm-viewport` 覆盖规则即可复现"黑底失败"原现象；底部 status 应显示 `webglAddon=ACTIVE | gl alpha attr=true`。

```html
<!doctype html>
<html>
  <head>
    <meta charset="utf-8" />
    <title>xterm 6.0 + webgl 0.19 transparency PoC</title>
    <link rel="stylesheet" href="xterm.css" />
    <style>
      html,
      body {
        margin: 0;
        height: 100%;
        font-family: -apple-system, sans-serif;
      }
      body {
        background:
          radial-gradient(circle at 18% 28%, rgba(255, 214, 0, 0.95) 0 90px, transparent 91px),
          radial-gradient(circle at 82% 20%, rgba(0, 229, 255, 0.9) 0 70px, transparent 71px),
          radial-gradient(circle at 70% 80%, rgba(255, 64, 129, 0.9) 0 110px, transparent 111px),
          radial-gradient(circle at 30% 75%, rgba(118, 255, 3, 0.85) 0 60px, transparent 61px),
          linear-gradient(135deg, #4527a0 0%, #d81b60 50%, #f57f17 100%);
        background-attachment: fixed;
      }
      .row {
        display: flex;
        gap: 16px;
        padding: 16px;
      }
      .case {
        flex: 1;
      }
      .case h3 {
        color: #fff;
        text-shadow: 0 1px 3px rgba(0, 0, 0, 0.8);
        margin: 0 0 6px;
        font-size: 14px;
      }
      .term-box {
        height: 340px;
        border: 1px solid rgba(255, 255, 255, 0.5);
        border-radius: 8px;
        overflow: hidden;
      }
      #status {
        color: #fff;
        background: rgba(0, 0, 0, 0.65);
        margin: 0 16px 16px;
        padding: 10px 14px;
        border-radius: 8px;
        font: 12px/1.6 monospace;
        white-space: pre-wrap;
      }
      /* THE FIX: xterm 6.0.0 ships `.xterm .xterm-viewport { background-color: #000 }` unconditionally
     (the :not(.allow-transparency) guard only exists on master). Override it. */
      .term-box .xterm-viewport {
        background-color: transparent !important;
      }
    </style>
  </head>
  <body>
    <div class="row">
      <div class="case">
        <h3>A — allowTransparency:true, background rgba(0,0,0,0)（全透明）</h3>
        <div class="term-box" id="termA"></div>
      </div>
      <div class="case">
        <h3>B — allowTransparency:true, background rgba(11,24,41,0.45)（半透明压暗）</h3>
        <div class="term-box" id="termB"></div>
      </div>
    </div>
    <div id="status">booting…</div>

    <script src="xterm.js"></script>
    <script src="addon-webgl.js"></script>
    <script>
      const TerminalCtor =
        window.Terminal && window.Terminal.prototype ? window.Terminal : window.Terminal.Terminal;
      const WebglCtor = window.WebglAddon.WebglAddon || window.WebglAddon;
      const lines = [];

      function demoContent(term, label) {
        term.writeln("\x1b[1;33m★ " + label + " — NextShell terminal background PoC\x1b[0m");
        term.writeln(
          "user@host:~$ ls -la  \x1b[36m(cyan)\x1b[0m \x1b[32m(green)\x1b[0m \x1b[31m(red)\x1b[0m \x1b[35m(magenta)\x1b[0m"
        );
        let bar = "";
        for (let i = 0; i < 16; i++) bar += "\x1b[48;5;" + i + "m  \x1b[0m";
        term.writeln(bar);
        term.writeln(
          "\x1b[7m reverse video \x1b[0m  \x1b[1mbold\x1b[0m  \x1b[4munderline\x1b[0m  普通中文宽字符"
        );
        term.writeln(
          "\x1b[42;30m PASS \x1b[0m default-bg cells must be see-through; colored cells stay opaque:"
        );
        term.writeln(
          "\x1b[41m red-bg \x1b[44m blue-bg \x1b[100m gray-bg \x1b[0m ← these keep their own background"
        );
        for (let i = 0; i < 6; i++)
          term.writeln(
            "line " + i + " — the wallpaper circles must be visible between these letters"
          );
      }

      function makeTerm(elId, bg, label) {
        const el = document.getElementById(elId);
        const term = new TerminalCtor({
          allowTransparency: true,
          cursorBlink: false,
          fontSize: 13,
          theme: { background: bg, foreground: "#eaf6ff", cursor: "#eaf6ff" }
        });
        let webglOk = false,
          webglErr = "";
        term.open(el);
        try {
          const addon = new WebglCtor();
          term.loadAddon(addon);
          webglOk = true;
        } catch (e) {
          webglErr = String(e);
        }
        term.resize(66, 16);
        demoContent(term, label);
        const canvases = el.querySelectorAll("canvas");
        let alphaAttr = "n/a";
        for (const c of canvases) {
          const gl = c.getContext("webgl2");
          if (gl) {
            alphaAttr = String(gl.getContextAttributes().alpha);
            break;
          }
        }
        lines.push(
          label +
            ": webglAddon=" +
            (webglOk ? "ACTIVE" : "FAILED " + webglErr) +
            " | canvases=" +
            canvases.length +
            " | gl alpha attr=" +
            alphaAttr +
            " | theme.background=" +
            bg
        );
        return term;
      }

      const termA = makeTerm("termA", "rgba(0,0,0,0)", "CASE A");
      const termB = makeTerm("termB", "rgba(11,24,41,0.45)", "CASE B");
      termB.select(0, 4, 40);
      lines.push("xterm version path: local node_modules @xterm/xterm@6.0.0 + addon-webgl@0.19.0");
      document.getElementById("status").textContent = lines.join("\n");
      window.__pocDiag = lines;
      window.termA = termA;
      window.termB = termB;
    </script>
  </body>
</html>
```

压测（DevTools console，对应 §3.2 第 4 项）：

```js
const mk = (i) =>
  i % 4 === 0
    ? "\x1b[41;97m- removed " + i + "\x1b[0m tail"
    : i % 4 === 1
      ? "\x1b[42;30m+ added " + i + "\x1b[0m tail"
      : i % 4 === 2
        ? "\x1b[48;5;" + (16 + (i % 200)) + "m bg256 " + i + " \x1b[0m \x1b[7mrev " + i + "\x1b[0m"
        : "plain " + i + " 中文混排 ★☆";
const burst = (t, f, n) =>
  new Promise((r) => {
    let b = "";
    for (let i = f; i < f + n; i++) b += mk(i) + "\r\n";
    t.write(b, r);
  });
for (let r = 0; r < 8; r++) {
  await burst(termA, r * 5000, 5000);
  await burst(termB, r * 5000, 5000);
}
termA.scrollLines(-500); // 翻历史检查残影
```

## 附录 B：上游引用索引（供核实）

- 回归对照：`node_modules/.pnpm/@xterm+xterm@6.0.0/.../css/xterm.css` L93-96（无条件黑底） vs `https://github.com/xtermjs/xterm.js/blob/master/css/xterm.css`（`:not(.allow-transparency)` 守卫）
- WebGL 透明支持史：`xtermjs/xterm.js#2252`（2022-07-30 关闭）、PR #2560、#5335（入 6.0.0）、#5260/#5262（入 6.0.0）
- 残影 bug：issue #5847（2026-04-27 开）→ fix PR #5883（2026-05-21 合并，仅 0.20.0-beta；npm 确认无 0.19.1，stable latest = 0.19.0 / 6.0.0）
- 仍 open：#4212（细字）、#1898（反显，fix PR #5804 被关未合）
- 6.0.0 breaking：#5105 移除 canvas 渲染器（**WebGL 之外唯一 fallback 是 DOM**）、#5096 滚动条重写（本回归来源区）
- VS Code：`xtermTerminal.ts` 中 `allowTransparency: config.enableImages`（仅为 Sixel 内联图片）
- electerm：`terminal-color-query.mjs`（webGL 强制不透明背景）、`default-setting.js`（`rendererType:'dom'` 默认）、`terminal.jsx`（`allowTransparency` 恒开）
- Hyper：`lib/components/term.tsx`（alpha<1 时禁用 WebGL 的 console.warn）
- Tabby：`Eugeny/tabby#646`（WebGL+vibrancy 反显 bug）
