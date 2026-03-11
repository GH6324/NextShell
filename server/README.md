# NextShell Cloud Sync Server

轻量自部署的云同步服务端，让同一用户在多台设备间共享连接、SSH 密钥和代理配置。

## 特性

- 单二进制，零外部依赖（内嵌 SQLite）
- 强制 HTTPS，Basic Auth 认证
- Workspace 自动创建，密码 bcrypt 加密存储
- 资源引用完整性检查（删除被引用的 SSH Key / Proxy 返回 409）
- 删除墓碑机制，确保跨设备同步删除
- 版本号单调递增，支持增量检测

## 快速开始

### 构建

```bash
cd server
go build -o nshellserver .
```

### 生成 TLS 证书

生产环境建议使用 Let's Encrypt 等 CA 签发的证书。本地测试可用自签名证书：

```bash
openssl req -x509 -newkey rsa:2048 -keyout key.pem -out cert.pem \
  -days 365 -nodes -subj '/CN=localhost'
```

### 启动

```bash
./nshellserver --cert cert.pem --key key.pem
```

### 配置项

| 参数 | 环境变量 | 默认值 | 说明 |
|---|---|---|---|
| `--addr` | `NSHELL_ADDR` | `:8443` | 监听地址 |
| `--cert` | `NSHELL_CERT` | （必填） | TLS 证书文件 |
| `--key` | `NSHELL_KEY` | （必填） | TLS 私钥文件 |
| `--db` | `NSHELL_DB` | `./nshell.db` | SQLite 数据库路径 |

CLI 参数优先于环境变量。

### 验证

```bash
curl -k -X POST https://localhost:8443/api/v1/sync/workspace/status \
  -u "myworkspace:mypassword" \
  -H "Content-Type: application/json" \
  -d '{}'
```

成功返回：

```json
{"ok": true, "workspace": "myworkspace", "version": 0, "serverTime": "..."}
```

## 项目结构

```
server/
├── main.go                        # 入口：CLI、TLS server、路由、graceful shutdown
├── internal/
│   ├── config/config.go           # 配置加载
│   ├── db/
│   │   ├── db.go                  # SQLite 连接、pragma、迁移
│   │   └── store.go               # 数据层 CRUD
│   ├── handler/
│   │   ├── handler.go             # Handler + JSON 工具函数
│   │   ├── middleware.go          # Basic Auth + Body Limit
│   │   ├── workspace.go          # workspace/status
│   │   ├── pull.go               # pull
│   │   ├── connection.go         # connections upsert/delete
│   │   ├── sshkey.go             # ssh-keys upsert/delete
│   │   └── proxy.go              # proxies upsert/delete
│   └── model/model.go            # 请求/响应结构体
```

## 依赖

| 包 | 用途 |
|---|---|
| `github.com/go-chi/chi/v5` | HTTP 路由 |
| `modernc.org/sqlite` | CGO-free SQLite 驱动 |
| `golang.org/x/crypto` | bcrypt 密码哈希 |
