# NextShell Cloud Sync API Reference

Base URL: `https://<host>:<port>/api/v1/sync`

## 通用约定

- 所有接口均为 **POST**，请求体和响应体均为 JSON
- `Content-Type: application/json`
- 请求体最大 10 MB
- 认证方式：HTTP Basic Auth

## 认证

每个请求必须携带 `Authorization` header：

```
Authorization: Basic base64(workspaceName:workspacePassword)
```

- **首次请求**时 workspace 自动创建，密码以 bcrypt 哈希存储
- 后续请求验证密码，密码错误返回 `401`

## 状态码

| 状态码 | 含义 |
|---|---|
| `200` | 成功 |
| `400` | 请求参数错误 |
| `401` | 认证失败 |
| `409` | 资源引用冲突（删除仍被引用的 SSH Key / Proxy） |
| `500` | 服务端内部错误 |

## 错误响应格式

```json
{
  "ok": false,
  "error": "error message"
}
```

---

## 接口列表

### 1. 检查 Workspace 状态

`POST /api/v1/sync/workspace/status`

验证服务可达和认证有效，获取当前 workspace 版本号。

**请求**

```json
{}
```

**响应**

```json
{
  "ok": true,
  "workspace": "alice",
  "version": 21,
  "serverTime": "2026-03-11T10:00:00.000Z"
}
```

| 字段 | 类型 | 说明 |
|---|---|---|
| `workspace` | string | workspace 名称 |
| `version` | integer | 当前版本号 |
| `serverTime` | string | 服务器 UTC 时间（RFC 3339） |

---

### 2. 拉取 Workspace 快照

`POST /api/v1/sync/pull`

根据客户端已知版本号决定返回完整快照或标记未变化。

**请求**

```json
{
  "knownVersion": 21
}
```

| 字段 | 类型 | 必填 | 说明 |
|---|---|---|---|
| `knownVersion` | integer | 是 | 客户端已知的版本号 |

**响应（无变化）**

当 `knownVersion` 与服务端版本一致时：

```json
{
  "ok": true,
  "workspace": "alice",
  "version": 21,
  "unchanged": true,
  "serverTime": "2026-03-11T10:05:00.000Z"
}
```

**响应（有变化）**

当 `knownVersion` 与服务端版本不一致时，返回完整快照：

```json
{
  "ok": true,
  "workspace": "alice",
  "version": 24,
  "unchanged": false,
  "serverTime": "2026-03-11T10:05:00.000Z",
  "snapshot": {
    "connections": [
      {
        "id": "conn-1",
        "name": "prod-hk",
        "host": "1.2.3.4",
        "port": 22,
        "username": "root",
        "authType": "password",
        "credentialCipher": { "v": 1, "alg": "aes-256-gcm", "..." : "..." },
        "sshKeyId": null,
        "hostFingerprint": "SHA256:xxx",
        "strictHostKeyChecking": true,
        "proxyId": "proxy-1",
        "keepAliveEnabled": true,
        "keepAliveIntervalSec": 15,
        "groupPath": "/server/prod",
        "tags": ["prod", "hk"],
        "notes": "main",
        "favorite": true,
        "updatedAt": "2026-03-11T10:04:00.000Z"
      }
    ],
    "sshKeys": [
      {
        "id": "key-1",
        "name": "prod-key",
        "privateKeyCipher": { "v": 1, "alg": "aes-256-gcm", "..." : "..." },
        "passphraseCipher": null,
        "updatedAt": "2026-03-11T10:04:00.000Z"
      }
    ],
    "proxies": [
      {
        "id": "proxy-1",
        "name": "hk-socks",
        "proxyType": "socks5",
        "host": "5.6.7.8",
        "port": 1080,
        "username": "u1",
        "passwordCipher": { "v": 1, "alg": "aes-256-gcm", "..." : "..." },
        "updatedAt": "2026-03-11T10:04:00.000Z"
      }
    ],
    "deleted": {
      "connections": ["conn-9"],
      "sshKeys": [],
      "proxies": []
    }
  }
}
```

| 字段 | 类型 | 说明 |
|---|---|---|
| `unchanged` | boolean | 版本未变化时为 `true` |
| `snapshot` | object | 仅 `unchanged=false` 时返回 |
| `snapshot.connections` | array | 所有连接对象 |
| `snapshot.sshKeys` | array | 所有 SSH 密钥对象 |
| `snapshot.proxies` | array | 所有代理对象 |
| `snapshot.deleted.connections` | string[] | 已删除的连接 ID 列表 |
| `snapshot.deleted.sshKeys` | string[] | 已删除的 SSH 密钥 ID 列表 |
| `snapshot.deleted.proxies` | string[] | 已删除的代理 ID 列表 |

---

### 3. 新增/更新连接

`POST /api/v1/sync/connections/upsert`

**请求**

```json
{
  "baseVersion": 24,
  "connection": {
    "id": "conn-1",
    "name": "prod-hk",
    "host": "1.2.3.4",
    "port": 22,
    "username": "root",
    "authType": "password",
    "credentialCipher": { "v": 1, "alg": "aes-256-gcm", "..." : "..." },
    "sshKeyId": null,
    "hostFingerprint": "SHA256:xxx",
    "strictHostKeyChecking": true,
    "proxyId": "proxy-1",
    "keepAliveEnabled": true,
    "keepAliveIntervalSec": 15,
    "groupPath": "/server/prod",
    "tags": ["prod", "hk"],
    "notes": "main",
    "favorite": true,
    "updatedAt": "2026-03-11T10:06:00.000Z"
  }
}
```

| 字段 | 类型 | 必填 | 说明 |
|---|---|---|---|
| `baseVersion` | integer | 是 | 客户端当前已知版本号 |
| `connection` | object | 是 | 完整连接对象，必须包含 `id` |

**响应**

```json
{
  "ok": true,
  "version": 25,
  "updatedAt": "2026-03-11T10:06:01.000Z"
}
```

**说明**
- 如果该 `id` 已存在则覆盖更新
- 如果该 `id` 存在对应的删除墓碑，墓碑会被自动清除

---

### 4. 删除连接

`POST /api/v1/sync/connections/delete`

**请求**

```json
{
  "baseVersion": 25,
  "id": "conn-1"
}
```

| 字段 | 类型 | 必填 | 说明 |
|---|---|---|---|
| `baseVersion` | integer | 是 | 客户端当前已知版本号 |
| `id` | string | 是 | 要删除的连接 ID |

**响应**

```json
{
  "ok": true,
  "version": 26,
  "deletedAt": "2026-03-11T10:06:10.000Z"
}
```

**说明**
- 删除后会创建墓碑记录，防止其他设备将旧数据重新同步回来

---

### 5. 新增/更新 SSH 密钥

`POST /api/v1/sync/ssh-keys/upsert`

**请求**

```json
{
  "baseVersion": 26,
  "sshKey": {
    "id": "key-1",
    "name": "prod-key",
    "privateKeyCipher": { "v": 1, "alg": "aes-256-gcm", "..." : "..." },
    "passphraseCipher": null,
    "updatedAt": "2026-03-11T10:07:00.000Z"
  }
}
```

| 字段 | 类型 | 必填 | 说明 |
|---|---|---|---|
| `baseVersion` | integer | 是 | 客户端当前已知版本号 |
| `sshKey` | object | 是 | 完整 SSH 密钥对象，必须包含 `id` |

**响应**

```json
{
  "ok": true,
  "version": 27,
  "updatedAt": "2026-03-11T10:07:01.000Z"
}
```

---

### 6. 删除 SSH 密钥

`POST /api/v1/sync/ssh-keys/delete`

**请求**

```json
{
  "baseVersion": 27,
  "id": "key-1"
}
```

**响应（成功）**

```json
{
  "ok": true,
  "version": 28,
  "deletedAt": "2026-03-11T10:07:10.000Z"
}
```

**响应（409 冲突）**

当该 SSH 密钥仍被连接引用时：

```json
{
  "ok": false,
  "error": "ssh key \"key-1\" is still referenced by 1 connection(s)"
}
```

---

### 7. 新增/更新代理

`POST /api/v1/sync/proxies/upsert`

**请求**

```json
{
  "baseVersion": 28,
  "proxy": {
    "id": "proxy-1",
    "name": "hk-socks",
    "proxyType": "socks5",
    "host": "5.6.7.8",
    "port": 1080,
    "username": "u1",
    "passwordCipher": { "v": 1, "alg": "aes-256-gcm", "..." : "..." },
    "updatedAt": "2026-03-11T10:08:00.000Z"
  }
}
```

| 字段 | 类型 | 必填 | 说明 |
|---|---|---|---|
| `baseVersion` | integer | 是 | 客户端当前已知版本号 |
| `proxy` | object | 是 | 完整代理对象，必须包含 `id` |

**响应**

```json
{
  "ok": true,
  "version": 29,
  "updatedAt": "2026-03-11T10:08:01.000Z"
}
```

---

### 8. 删除代理

`POST /api/v1/sync/proxies/delete`

**请求**

```json
{
  "baseVersion": 29,
  "id": "proxy-1"
}
```

**响应（成功）**

```json
{
  "ok": true,
  "version": 30,
  "deletedAt": "2026-03-11T10:08:10.000Z"
}
```

**响应（409 冲突）**

当该代理仍被连接引用时：

```json
{
  "ok": false,
  "error": "proxy \"proxy-1\" is still referenced by 1 connection(s)"
}
```

---

## curl 示例

```bash
BASE="https://localhost:8443/api/v1/sync"
AUTH="myworkspace:mypassword"

# 检查状态
curl -k -X POST "$BASE/workspace/status" -u "$AUTH" \
  -H "Content-Type: application/json" -d '{}'

# 创建连接
curl -k -X POST "$BASE/connections/upsert" -u "$AUTH" \
  -H "Content-Type: application/json" \
  -d '{
    "baseVersion": 0,
    "connection": {
      "id": "c1", "name": "my-server", "host": "1.2.3.4",
      "port": 22, "username": "root", "authType": "password",
      "updatedAt": "2026-03-11T10:00:00Z"
    }
  }'

# 拉取快照
curl -k -X POST "$BASE/pull" -u "$AUTH" \
  -H "Content-Type: application/json" -d '{"knownVersion": 0}'

# 删除连接
curl -k -X POST "$BASE/connections/delete" -u "$AUTH" \
  -H "Content-Type: application/json" -d '{"baseVersion": 1, "id": "c1"}'
```
