# 终端透出背景图 — 手测清单

> 实施已完成（对应 `TERMINAL_BG_IMAGE_PLAN.md`）。本文档列出**还需要人工判断**的项。
> 自动化能覆盖的部分已跑完，见 §1，**不用重测**。
> 手测请在真实 profile（`pnpm dev`）下进行。

---

## 1. 已自动验证（不用重测）

### 1.1 代码门禁

| 项                   | 结果                                                 |
| -------------------- | ---------------------------------------------------- |
| `pnpm run typecheck` | ✅ 通过（desktop + 8 个 package + mcp-ssh-proxy）    |
| `pnpm test`          | ✅ 81 files / 320 tests 通过（新增 1 文件 / 7 用例） |
| `npx eslint`         | ✅ 无新增 warning（仅剩仓库既有的 83 条）            |
| `prettier --check`   | ✅ 全部符合                                          |

新增单测：

- `apps/desktop/src/renderer/utils/terminalWallpaper.spec.ts` — 透明/渲染器决策真值表（无壁纸、纯空格路径、默认值、实验 GPU、关闭透出）
- `packages/shared/src/contracts.preferences.test.ts` — schema 默认值注入、老数据缺 `wallpaper` 块、patch 单字段、非布尔拒绝
- `apps/desktop/src/main/services/preferences.test.ts` — 嵌套合并不丢兄弟字段、patch 无 `wallpaper` 块时保留原值

### 1.2 真实 app 行为（隔离 profile + CDP 探测，你的真实数据库未被改动）

| 场景                     | 客观证据                                                                                                                                                                                          |
| ------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 无壁纸（零回归）         | `.terminal-shell` = `rgb(11, 24, 41)` 不透明；2 个 canvas，WebGL `alpha=true`                                                                                                                     |
| 壁纸 + 透出（默认）      | `.xterm` 类名含 `xterm-dom-renderer-owner-1`（DOM 渲染器）；canvas 数 = **0**；`.xterm-viewport` = `rgba(0, 0, 0, 0)`（xterm 6.0.0 黑底已被覆盖）；`.terminal-shell` = `color(srgb 0 0 0 / 0.46)` |
| 壁纸 + 透出 + GPU 加速   | canvas 数 = 2，`alpha=true`，仍保持透明                                                                                                                                                           |
| 开关切换 → 重建 + replay | 切换后 `RED-BG` / `BLUE-BG` 彩色单元格完整恢复，且**保持自身不透明底色**                                                                                                                          |
| 透明度滑杆 46 → 75       | `.terminal-shell` alpha 同步变化；`.xterm` 元素上的标记存活 → **未触发重建** ✅                                                                                                                   |
| 清除壁纸                 | 回到 `.app-shell`（无 `--with-wallpaper`）+ 不透明 + WebGL 恢复；两个开关自动置灰                                                                                                                 |
| 大流量（DOM 渲染器）     | 60000 行 `yes` 输出后宽字符/中文正常，新命令仍可执行，彩色底 `rgb(78,154,6)` / `rgb(204,0,0)` 保持不透明                                                                                          |
| 6 次重建后 DOM 泄漏      | `.xterm` / `.xterm-viewport` / `.xterm-screen` / `helper-textarea` 各 **1 个**，无堆叠                                                                                                            |

---

## 2. 需要你手测的项

### 2.1 观感（只能人眼判断）

- [ ] **A1** 设置壁纸后，终端文字在壁纸上是否**清晰可读**（不刺眼、不糊）。
- [ ] **A2** 「整体透明度」拉到 **30 / 60 / 80** 三档各看一次；判断可读性下限在哪。
      ⚠️ 注意语义：数值**越大 → 面板越不透明 → 壁纸越淡**（沿用现有壁纸体系，与侧栏/标签栏一致）。若觉得对终端反直觉，告诉我，可以单独给终端加一个独立的压暗系数。
      ℹ️ 「滑条拖不动 / 输入框改不了」已修（见 §5），现在拖动实时跟手、松手立即生效，输入框打完约 0.5s 生效。
- [ ] **A3** 换几个「终端颜色」主题预设（终端底色变化），确认压暗色跟着终端底色走、观感合理（本次新增 `--terminal-tint`，不再写死深蓝 `#0b1829`）。
- [ ] **A4** 终端区域与四周留白、与 session-tabs / 侧栏的观感是否连贯（有没有"接缝"或亮度断层）。

### 2.2 真实 SSH 会话（我这边没有可连的服务器）

- [ ] **B1** 连一台服务器，透出模式下跑：`vim`、`htop`、`tmux`、`ls --color` — 全屏 TUI 有无错位/残影/光标丢失。
- [ ] **B2** `cat` 一个大文件 / 看编译日志（持续大流量）— DOM 渲染器路径有无卡顿或字形残影。
- [ ] **B3** 打开「透出时启用 GPU 加速」后重复 B2 — **出现残影属已知上游风险**（xterm #5847，修复未进 stable），只需记录现象即可。
- [ ] **B4** 断线 → 按回车重连的提示流；密码错误 → 终端内重输密码的认证流 — 在透出模式下文字是否正常显示。
- [ ] **B5** 多标签：开 2~3 个会话，来回切 tab，每个 tab 的历史输出都正确（不串、不空白）。

### 2.3 透出模式下的交互元素

- [ ] **C1** `Ctrl/Cmd+Shift+F` 搜索高亮是否清晰可见（高亮底色应保持不透明）。
- [ ] **C2** 鼠标框选的选中高亮是否可见。
- [ ] **C3** 右键菜单：复制 / 粘贴 / 粘贴选中 / 清空界面。
- [ ] **C4** 反显文本（`printf '\033[7mREVERSE\033[0m'`）底色是否不透明。

### 2.4 CLAUDE.md 冒烟基线（本次改动未触碰这些路径，走一遍确认）

- [ ] **D1** 连接 CRUD（新建 / 编辑 / 删除）。
- [ ] **D2** 终端开启 / 重连。
- [ ] **D3** SFTP 上传 / 下载 / 远程编辑。

---

## 3. 反馈方式

按编号回报即可，例如：

```
A2: 30% 太淡看不清，60% 最舒服
B3: cat 500MB 日志出现残影，滚动后恢复
C1: 搜索高亮偏暗，建议加亮
```

有问题的项我直接改；A2 若要改语义我会同时调整设置文案。

---

## 4. 本次改动涉及的文件（供 review）

| 文件                                                                            | 改动                                                                                 |
| ------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------ |
| `packages/core/src/index.ts`                                                    | `terminal.wallpaper.{seeThrough,useWebgl}` 类型 + patch + 默认值（`true` / `false`） |
| `packages/shared/src/contracts.ts`                                              | 完整 schema + patch schema                                                           |
| `packages/storage/src/index.ts`                                                 | 老数据解析防御（非布尔回退默认）                                                     |
| `apps/desktop/src/main/services/preferences.ts`                                 | patch 嵌套合并                                                                       |
| `apps/desktop/src/renderer/utils/terminalWallpaper.ts`                          | **新增** 透明/渲染器决策单一来源                                                     |
| `apps/desktop/src/renderer/components/TerminalPane.tsx`                         | `allowTransparency` + 透明 theme + WebGL 门控 + 重建时 replay                        |
| `apps/desktop/src/renderer/styles/terminal.css`                                 | `.xterm-viewport` 黑底覆盖（xterm 6.0.0 回归）+ `--terminal-tint`                    |
| `apps/desktop/src/renderer/App.tsx`                                             | 注入 `--terminal-tint`（跟随终端底色）                                               |
| `apps/desktop/src/renderer/store/usePreferencesStore.ts`                        | 乐观更新的 `wallpaper` 嵌套合并（否则单字段 patch 会吞掉兄弟字段）                   |
| `settings-center/terminal-section.tsx` + `types.ts` + `SettingsCenterModal.tsx` | 「APP 背景」卡片内两个开关（无壁纸时置灰）                                           |

> 未来 `@xterm/addon-webgl` 发布含 PR #5883 的 stable 后，按计划 §5.6 翻转 `useWebgl` 默认值，并检查是否可删掉 `terminal.css` 里的 viewport 覆盖。
