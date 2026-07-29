# 钥匙串（keytar）设计精简与打扰最小化计划

> 状态：**全部实施完毕**（2026-07-25）——B / C / D / A、第 8 节的 MCP proxy 交接、「重新授权钥匙串」按钮，以及第 9 节的 mac 签名配置脚手架。
> `pnpm run typecheck` 通过，`vitest run` 82 文件 / 335 用例通过，`@nextshell/runtime` 的 node 测试 10/10 通过，`dist:dir` 打包通过。
> **CI/CD 已实测跑通**：v0.3.0-rc4 的 Release workflow 全绿，mac 包由 `NextShell Dev` 证书签名，DR 断言通过，产物为 `NextShell-0.3.0-rc4-mac-arm64.dmg` / `-win-x64.exe`。
> 上一轮已完成的部分（recall 内存缓存 + single-flight、dev 独立 service name、主密码懒加载）不在本计划范围内。

## 0. 目标与底线

**目标**：macOS 上「整个会话最多一次授权弹窗，且用户被明确引导点『始终允许』，误点拒绝不会损坏数据」；Windows / Linux 保持零打扰。

**安全底线（不可破坏的唯一一条）**：device key 不与密文同处一个文件——防的是「只拷走 `nextshell.db`」和「DB 被同步进 iCloud/OneDrive」。

**明确不在威胁模型内**：以同一用户身份运行的恶意程序。keytar / safeStorage / DPAPI 对此都无能为力，因此任何以「防本机恶意程序」为理由的额外层级都不算收益。

## 1. 现状事实（实施前的判断依据）

| 事实                                                                                                        | 证据                                                            |
| ----------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------- |
| 连接时读凭据完全不经过主密码                                                                                | `apps/desktop/src/main/services/container.ts:297`               |
| `EncryptedSecretVault` 只用 device key 加解密，主密码不参与                                                 | `packages/security/src/index.ts:422-453`                        |
| 主密码的真实用途只有备份归档加密；`revealConnectionPassword` 那处是纯 UI 闸门（校验完仍用 device key 解密） | `apps/desktop/src/main/services/backup-password-service.ts:221` |
| `rememberPassword` 默认 `true`，即默认把主密码明文写进钥匙串，与 device key 并排                            | `packages/core/src/index.ts:861`                                |
| `recall()` 抛错时会落到 `legacy ?? generate()`，legacy 已被清空则**当场生成新 device key 并写 DB**          | `packages/security/src/index.ts:388-420`                        |
| Windows 上 keytar 走 Credential Manager（DPAPI，无 UI）；弹窗是 macOS 独有问题                              | 平台行为                                                        |

**结论**：过度的不是加密强度，是「秘密层数」与「出错就兜底」。主密码层在默认配置下不收敛任何攻击面，只贡献一次弹窗；而那个 `catch` 兜底会造成静默的数据不可用。

---

## 2. 任务 B：拒绝授权不得生成新 device key（最高优先级，修 bug）

### 问题

macOS 上用户点「拒绝」或按 Esc → keytar reject → 进 `catch` → `legacy` 早已被 `clearLegacy()` 清空 → 生成全新 device key 并 `saveLegacy()`。后果双向损坏：

- 本次运行所有已存凭据解不开（`readCredential` 吞掉解密异常返回 `undefined`，表现为「该连接未保存登录密码」）
- 本次运行新存的凭据，下次启动钥匙串读成功后又解不开

### 改动

**`packages/security/src/index.ts`**

新增导出：

```ts
export class KeychainAccessDeniedError extends Error {
  constructor(readonly reason?: unknown) {
    super("系统钥匙串访问被拒绝");
    this.name = "KeychainAccessDeniedError";
  }
}
```

重写 `resolveDeviceKey`（`packages/security/src/index.ts:388`）的分支规则：

| 情况                                               | 处理                                                                                                     |
| -------------------------------------------------- | -------------------------------------------------------------------------------------------------------- |
| `isAvailable() === false`（模块没装 / 平台无后端） | 保持现状：降级 DB 存储，可以造新 key                                                                     |
| `recall()` 抛错 **且** DB 里还有 legacy key        | 保持现状：用 legacy，不清除（现有测试已覆盖，行为正确）                                                  |
| `recall()` 抛错 **且** 无 legacy                   | **新行为**：抛 `KeychainAccessDeniedError`，绝不造新 key                                                 |
| `recall()` 返回 `undefined`（条目确实不存在）      | 造新 key 或采用 legacy，然后 `remember()`                                                                |
| 上一条的 `remember()` 抛错                         | 降级 DB 存储（此时钥匙串里本来就没有 key，不会丢任何东西）；`clearLegacy()` 只在 `remember()` 成功后执行 |

骨架：

```ts
if (store.isAvailable()) {
  let existing: string | undefined;
  try {
    existing = await store.recall();
  } catch (error) {
    // 钥匙串可达但拒绝作答（用户拒绝/取消/瞬时故障）：已存凭据仍用这把读不到的
    // key 加密着，此时造新 key 会静默毁掉它们。
    if (legacy) {
      return { deviceKeyHex: legacy, storedIn: "database", migratedFromDatabase: false };
    }
    throw new KeychainAccessDeniedError(error);
  }

  if (existing) {
    if (legacy) db.clearLegacy();
    return { deviceKeyHex: existing, storedIn: "keychain", migratedFromDatabase: false };
  }

  const candidate = legacy ?? generate();
  try {
    await store.remember(candidate);
    if (legacy) db.clearLegacy();
    return { deviceKeyHex: candidate, storedIn: "keychain", migratedFromDatabase: Boolean(legacy) };
  } catch {
    if (!legacy) db.saveLegacy(candidate);
    return { deviceKeyHex: candidate, storedIn: "database", migratedFromDatabase: false };
  }
}
```

### 测试（`packages/security/src/resolve-device-key.spec.ts`）

现有 4 个用例全部保持通过（最后一个「runtime 抛错回落 legacy」的用例有 legacy，走保留分支）。新增：

- `recall()` 抛错且无 legacy → 抛 `KeychainAccessDeniedError`，且 `db.value` 仍为 `undefined`（**没有**偷偷写新 key）
- `recall()` 返回 undefined 且 `remember()` 抛错 → `storedIn === "database"`，key 落 DB，legacy 未被清
- `recall()` 返回 undefined、有 legacy、`remember()` 抛错 → 复用 legacy 且 legacy 未被清除

---

## 3. 任务 C：device key 懒加载

### 目标

只用 SSH key / agent、或只开本地 shell 的会话全程零弹窗；需要弹时也发生在「正在连接 xxx」的语境下，用户看得懂。同时给任务 B 的拒绝状态一个自然的落点。

### 改动

**`packages/security/src/index.ts` — `EncryptedSecretVault`（:422）**

构造参数从 `deviceKey: Buffer` 放宽为 `Buffer | (() => Promise<Buffer>)`，保留 Buffer 形式以免动 `packages/runtime`：

```ts
export type DeviceKeyResolver = Buffer | (() => Promise<Buffer>);

export class EncryptedSecretVault implements CredentialVault {
  constructor(private readonly store: SecretStoreDB, private readonly deviceKey: DeviceKeyResolver) {}

  private async key(): Promise<Buffer> {
    return typeof this.deviceKey === "function" ? await this.deviceKey() : this.deviceKey;
  }
  ...
}
```

`readCredential` 注意点：现在的 `try/catch` 会把一切异常吞成 `undefined`。**必须把 key 解析放在 try 之外**，否则「钥匙串被拒绝」会伪装成「该连接未保存登录密码」，正是任务 B 要消灭的那种误导。try 只包解密本身。

**新文件 `apps/desktop/src/main/services/device-key-provider.ts`**

```ts
export class DeviceKeyProvider {
  private resolved?: Buffer;
  private inFlight?: Promise<Buffer>;
  private denied = false;

  get(): Promise<Buffer>; // 成功后永久缓存；被拒绝后本次会话粘住，不再反复弹
  reauthorize(): void; // 清掉 denied + 缓存，供「重新授权」按钮调用
  status(): "unresolved" | "keychain" | "database" | "denied";
}
```

- 首次 `get()` 时才调 `resolveDeviceKey`，并把现在 `container.ts:91-101` 的日志搬进来
- 捕获 `KeychainAccessDeniedError` → `denied = true` → 之后所有 `get()` 直接抛同一个错误，**不再触发系统弹窗**
- 在真正调用 `store.recall()` 之前触发任务 D 的预告钩子

**`apps/desktop/src/main/services/container.ts`**

- 删掉 `:86` 的 `await resolveDeviceKey(...)` 与 `:91-101` 的日志
- `:103` 的 `new EncryptedSecretVault(..., Buffer.from(...))` 改为传 `() => deviceKeyProvider.get()`
- `CreateServiceContainerOptions` 增加 `onBeforeKeychainPrompt?: () => Promise<void>`

**错误传播**：被拒绝后，连接（`container.ts:297`）、揭示密码、导入导出、云同步都会抛出「钥匙串授权被拒绝，本次会话无法读取已保存的密码，请手动输入或在设置中心重新授权」。这是**期望行为**——比静默失败好。需要检查各 IPC handler 会把 message 原样带给渲染层（现有 handler 都是 `throw` → invoke reject，符合）。

**可选（建议一起做）**：设置中心安全区加「重新授权钥匙串」按钮 → 新 IPC → `deviceKeyProvider.reauthorize()`，让误点拒绝的用户不必重启。

---

## 4. 任务 A：主密码移出钥匙串

### 设计

主密码改用 device key 加密后存进 `secret_store`（`packages/storage/src/index.ts:1101` 已有表）。安全等价——默认 `rememberPassword: true` 时主密码本来就与 device key 并排放在钥匙串里，谁能拿到一个就能拿到另一个。收益：钥匙串条目 2 → 1，`KeytarPasswordCache` 只剩 device key 一个用途。

- secret id：`master-password`，ref `secret://master-password`
- `putSecret` 的 `purpose` 用 `"app"` 而非 `"credential"`，与连接凭据区分（表已有 `idx_secret_store_purpose`）

### 改动

| 位置                                                         | 改动                                                                                                                                                             |
| ------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `container.ts:119` `tryRecallMasterPassword`                 | 改读 `vault.readCredential("secret://master-password")`；读不到再试 `keytarCache.recall()`（旧数据），命中则写入 vault 并 `keytarCache.clear()` 删除旧钥匙串条目 |
| `backup-password-service.ts:74` `rememberPasswordBestEffort` | 改成 `vault.storeCredential("master-password", password)`                                                                                                        |
| `backup-password-service.ts` `masterPasswordClearRemembered` | `vault.deleteCredential(...)` + 保留 `keytarCache.clear()` 以清掉遗留条目                                                                                        |
| `container.ts:110` `keytarCache`                             | 保留但仅用于迁移/清理；迁移完成后可评估彻底删除                                                                                                                  |

### 迁移与回退

一次性、无风险：迁移失败最坏结果是用户重输一次主密码。**不涉及 device key，不存在凭据解不开的风险。**

### 契约与文案变更（`keytarAvailable` 语义失效）

记住主密码不再依赖钥匙串，该字段必须改名，否则 UI 在说谎。改 `keytarAvailable` → `canRememberPassword`（恒为 `true`，除非将来加开关），涉及：

- `packages/shared/src/contracts.ts:1087`
- `apps/desktop/src/main/services/backup-password-service.ts:156,165`
- `apps/desktop/src/renderer/components/SettingsCenterModal.tsx:87-88`
- `apps/desktop/src/renderer/components/settingsCenterBackupAccess.ts:4`
- `apps/desktop/src/renderer/components/settings-center/backup-section.tsx:38`
- `apps/desktop/src/renderer/components/settings-center/security-section.tsx:37,82,125,134`

UI 文案：

- 删掉「钥匙串可用」Tag（`security-section.tsx:82-86`，恒真已无信息量）
- 「使用系统钥匙串记住主密码」→「记住主密码（本机加密存储）」（`:132`）
- 「清除钥匙串缓存」→「清除已记住的主密码」（`:126`）
- `:134` 的 `disabled={loading || !pwdStatus.keytarAvailable}` → 只留 `loading`

---

## 5. 任务 D：弹窗前的预告对话框（macOS only）

### 改动

**`packages/storage/src/index.ts`**：仿照 `getDeviceKey/saveDeviceKey`（:2969-2997，底层是通用 `app_settings` 表）增加一对 `getKeychainNoticeAcknowledged() / saveKeychainNoticeAcknowledged()`，接口声明补在 `:1582` 附近。

**`apps/desktop/src/main/index.ts`**：向 `createServiceContainer` 传 `onBeforeKeychainPrompt`：

```ts
onBeforeKeychainPrompt: async () => {
  if (process.platform !== "darwin") return; // Win/Linux 从不弹，直接跳过
  if (repo.getKeychainNoticeAcknowledged()) return;
  await dialog.showMessageBox(mainWindow, {
    type: "info",
    message: "NextShell 需要访问系统钥匙串",
    detail:
      "用于读取保护已保存密码的加密密钥。\n\n接下来 macOS 会弹出授权窗口，请选择「始终允许」——选「允许」的话，每次启动都会再问一次。",
    buttons: ["继续"]
  });
  repo.saveKeychainNoticeAcknowledged();
};
```

由 `DeviceKeyProvider` 在首次真正 `recall()` 之前 `await` 该钩子。得益于任务 C 的懒加载，此时主窗口一定已存在，`dialog` 有正确的 parent。

**注意**：该钩子只在「即将访问钥匙串」时触发，不在启动时无条件弹；纯本地 shell 用户永远不会看到它。

---

## 6. 执行顺序

1. **B**（独立，修 bug，可单独合入）
2. **C**（依赖 B 的 `KeychainAccessDeniedError`）
3. **D**（依赖 C 的 provider 钩子点）
4. **A**（独立于 B/C/D，但放最后，避免与 C 同时改 vault 构造）

## 7. 验证清单

自动化：

- `pnpm test`（vitest）；新增 `resolve-device-key.spec.ts` 用例，新增 `device-key-provider.spec.ts`（拒绝粘住、不重复触发、reauthorize 生效）
- `pnpm run typecheck`

手工（macOS）：

- [ ] 全新安装：首次连接时才出现预告框 + 一次系统弹窗；点「始终允许」后重启不再弹
- [ ] 只开本地 shell / 只用 SSH agent：全程无任何弹窗
- [ ] 系统弹窗点「拒绝」：报错文案清晰、**已存连接的密码不丢**（重启并允许后仍能连）、本次会话不再反复弹
- [ ] 升级路径：旧版存过主密码 → 新版首次解锁后，钥匙串里的 `backup-password` 条目消失，功能正常
- [ ] 设置中心主密码区状态、开关、清除按钮行为正确

手工（Windows）：

- [ ] 全程零弹窗，凭据读写正常（DPAPI 路径未受影响）

---

## 8. 发现的连带问题（不在本次四项内，需决策）

`packages/runtime/src/index.ts:209` 的 `createReadonlyCredentialContext()` **只从 DB 读 device key**（`connections.getDeviceKey()`），读不到就抛 `CredentialStoreUnavailableError`。而 `resolveDeviceKey` 在迁移成功后会 `clearLegacy()` 把 DB 里的 key 删掉。

也就是说：**`apps/mcp-ssh-proxy` 在任何钥匙串正常工作的安装上已经是坏的**——这是上一轮 device key 迁移进钥匙串时引入的既有回归，与本计划无关，但会被本计划的改动进一步固化。

三种可选方向：

1. **桌面端在启动 MCP proxy 时把 device key 通过 stdio 握手/环境变量传给它** —— 最干净，proxy 不碰钥匙串，不破坏底线
2. **proxy 自己调 keytar** —— 不可行：它是独立二进制，macOS 会为它单独弹窗，而 MCP 场景下没人能点
3. **DB 保留一份 device key 副本** —— 直接放弃底线，不推荐

建议按方向 1 单开一个任务处理。需要你确认是否要做、以及 proxy 当前的实际启动方式。

---

## 9. mac 签名身份：方案 B（自签名证书）—— 已跑通

前八节把弹窗次数压到了 1 次，但**「始终允许」能不能跨版本生效，只取决于签名是否稳定**。macOS 的钥匙串 ACL 通过「指定要求（designated requirement, DR）」认应用；ad-hoc 签名的 DR 基于 cdhash，每次构建都变，于是每次更新后 ACL 都不再匹配，又开始弹。

Beta 阶段采用**方案 B：一张固定的自签名代码签名证书**。钥匙串 ACL 只关心 DR 稳不稳定，不关心证书是不是 Apple 签发的——所以自签名同样能达成目标，代价是 Gatekeeper 仍会拦下载来的包（首次需右键 → 打开），且无法公证。

### 已验证的产物

签名后实测得到的 DR：

```
designated => identifier "com.nextshell.desktop" and certificate leaf = H"e6e4c5f2821cb1a4ba0358a62f138e900646d9ad"
```

**不含 cdhash**，只绑 bundle id + 证书指纹 —— 只要一直用同一张证书，每次构建的 DR 完全一致，用户点一次「始终允许」就永久有效。这是整件事的验收标准。

`codesign --verify --deep --strict` 报 `valid on disk` / `satisfies its Designated Requirement`，嵌套的 `better-sqlite3` / `keytar` / `node-pty` 全部通过（靠 entitlements 里的 `disable-library-validation`）。

### 一次性：创建证书

```bash
pnpm --filter @nextshell/desktop run signing-cert
```

`apps/desktop/scripts/create-signing-cert.sh` 会生成一张 10 年有效期、带 `codeSigning` EKU 的自签名证书，导入登录钥匙串、标记为代码签名可信，并把 `.p12` 和随机密码导出到 `~/.nextshell-signing/`。脚本幂等，已存在时直接跳过。

实现上有两个坑已经踩过并规避：

- **必须用 `/usr/bin/openssl`（LibreSSL）导出 p12**。Homebrew 的 OpenSSL 3.x 默认用 AES-256 + PBKDF2 打包 PKCS#12，macOS `security import` 读不了，报 `MAC verification failed`。脚本已把 `OPENSSL` 固定到系统路径。
- **`security import` 要带 `-A`**，否则 codesign 每次签名都会弹一个钥匙串确认框（在 CI 里没人能点）。

> ⚠️ `~/.nextshell-signing/` 请异地备份。**弄丢这张证书 = 下个版本所有用户重新被问一遍**；重建一张新的等于换了 DR，同样会重新弹。

### 本地签名构建

```bash
pnpm --filter @nextshell/desktop run dist:mac       # dmg
pnpm --filter @nextshell/desktop run dist:mac:dir   # 只出 .app，快，用于验证
```

两个脚本都是 `CSC_NAME="${CSC_NAME:-NextShell Dev}"`，外部已设置 `CSC_NAME` 时以外部为准。没有证书的贡献者继续用 `pnpm dist`，构建照常成功，只是不签名。

验证签名：

```bash
codesign -dv --verbose=4 apps/desktop/release/mac-arm64/NextShell.app   # flags 应含 runtime，Authority 应是证书名
codesign -d -r- apps/desktop/release/mac-arm64/NextShell.app            # DR 应含 certificate leaf，不含 cdhash
```

### CI/CD 发布

`.github/workflows/release-electron.yml` 的 mac 分支新增两步：

1. **Import macOS signing certificate**（仅 mac）：建临时 keychain → 导入 p12 → `set-key-partition-list`（否则 codesign 卡在 GUI 确认）→ 从 keychain 导出公钥证书 → `sudo security add-trusted-cert -d -r trustRoot -p codeSign` 写进系统 keychain（自签名根不被信任的话 `security find-identity -v` 不会列出它，electron-builder 就会跳过签名）→ 校验身份可用。
2. **Verify macOS signature is certificate-pinned**（构建后）：`codesign --verify --deep --strict`，并断言 DR 里含 `certificate leaf`。**DR 退化成 cdhash 就直接 fail**，防止某天悄悄发出一个会让所有用户重新被问的包。

需要配置的 GitHub secrets：

| 名称                    | 取值                                                        |
| ----------------------- | ----------------------------------------------------------- |
| `MACOS_CERT_P12_BASE64` | `base64 -i ~/.nextshell-signing/signing-cert.p12 \| pbcopy` |
| `MACOS_CERT_PASSWORD`   | `cat ~/.nextshell-signing/p12-password.txt`                 |

可选变量 `MACOS_CERT_NAME`（默认 `NextShell Dev`）。

**secret 未配置时不会让流水线报错**，只打一条 `::warning::` 并产出未签名的包——避免在你加 secret 之前把发布卡死。加完 secret 后 mac 包才会真正签名。

**已在 v0.3.0-rc4 实测通过**：CI 日志里 `Imported code-signing identity: NextShell Dev` → `signing … identityHash=E6E4C5F2…` → 验证步骤输出 `designated => identifier "com.nextshell.desktop" and certificate leaf = H"e6e4c5f2…"`，与本地签名结果完全一致。

此前 rc3 失败的两个根因也一并修掉了：

- `pnpm run dist -- --win …` 会把 `--` 原样转发给 electron-builder，yargs 于是把后面所有 flag 当成 positional —— `--publish never` 失效导致它尝试 publish 并因缺 `GH_TOKEN` 报错，`-c.extraMetadata.version` 失效导致产物被命名成 `0.1.0`。现在改为在 `apps/desktop` 下直接 `pnpm exec electron-builder`。
- `prettier --check` 卡住 CI（`backup-password-service.ts`、`tsconfig.node.json`）。

### 本地 dev（`pnpm dev`）不受影响，也不需要签名

`pnpm dev` 跑的是 `node_modules` 里的 Electron.app，不是打包产物，签名配置对它无效。它的现状：

- npm 分发的 Electron.app 是 `adhoc, linker-signed`，且没有 CodeResources —— `codesign --verify --deep --strict` 本来就会报 `code has no resources but signature indicates they must be present`，**这是正常状态，不是损坏**（删掉 `dist/` 重新解压后完全一致）。
- 它的 DR 基于 cdhash，但同一个 Electron 版本的二进制是固定的，所以 ACL 只在**升级 Electron 版本**时失效 —— 一年也就几次。
- 加上第 3 节给 dev 分配的独立钥匙串条目 `NextShell (Dev)`，dev 和正式版互不干扰。

**曾尝试给 dev 的 Electron.app 签上同一张证书让它也永久稳定，已放弃并回退**：`codesign --deep` 在 `Electron Framework.framework` 上会因 `bundle format is ambiguous` 失败，正确做法要按 helper → framework `Versions/A` → 外层 app 的顺序手工签，脆弱且每次 Electron 升级都要重跑；收益只是一年少几次弹窗，而签坏了会让 `pnpm dev` 起不来。不值得。
