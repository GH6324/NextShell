# NextShell MCP SSH Proxy

独立发布的本地 `stdio` MCP 程序，用来复用 NextShell 已保存的 SSH 凭据。

## 能力

- `nextshell/list`
- `nextshell/search`
- `nextshell/connect`
- `nextshell/exec`
- `nextshell/disconnect`

## 约束

- 不提供交互式 shell。
- 每次 `exec` 都是单次远程命令执行，不保留 shell 上下文。
- 不返回密码、私钥、passphrase 或任何 secret store 原始内容。

## 本地运行

```bash
pnpm install
pnpm --filter @nextshell/mcp-ssh-proxy run build
node /absolute/path/to/apps/mcp-ssh-proxy/dist/index.js
```

也可以在 MCP 客户端里直接配置该构建产物的绝对路径。

## MCP 客户端配置示例

```json
{
  "mcpServers": {
    "nextshell-ssh": {
      "command": "node",
      "args": ["/absolute/path/to/apps/mcp-ssh-proxy/dist/index.js"],
      "env": {
        "NEXTSHELL_DEVICE_KEY": "……"
      }
    }
  }
}
```

## 设备密钥

凭据在 `nextshell.db` 里是加密存放的，解密用的**设备密钥**保存在系统钥匙串里，不在数据库中。

本程序**不会去读钥匙串**：它由 MCP 客户端以无界面方式拉起，macOS 的钥匙串授权弹窗在这种场景下没人能点，而且它的代码签名身份与桌面端不同，本来也匹配不上桌面端那条 ACL。

因此设备密钥由桌面端交接过来：在 NextShell 里打开 **设置中心 → 安全 → MCP 代理配置 → 复制 MCP 配置**（需先解锁主密码），把复制到剪贴板的 JSON 粘进 MCP 客户端配置即可，其中已包含 `NEXTSHELL_DEVICE_KEY` 和 `NEXTSHELL_DB_PATH`。

密钥解析顺序：

1. `NEXTSHELL_DEVICE_KEY` 环境变量
2. 数据库里的明文副本（仅存在于系统钥匙串不可用的安装）

两者都拿不到时启动会失败并提示 `credential store unavailable`。

> 该环境变量等同于所有已保存凭据的解密能力，请按密钥对待 MCP 客户端的配置文件。

## 数据来源

程序默认读取 NextShell 桌面端的本地数据目录：

- macOS: `~/Library/Application Support/NextShell/storage/nextshell.db`
- Windows: `%APPDATA%\\NextShell\\storage\\nextshell.db`
- Linux: `${XDG_CONFIG_HOME:-~/.config}/NextShell/storage/nextshell.db`

测试或自定义环境下也可以通过以下环境变量覆盖：

- `NEXTSHELL_DB_PATH`
- `NEXTSHELL_DATA_DIR`
- `NEXTSHELL_DEVICE_KEY`（见上文「设备密钥」）
