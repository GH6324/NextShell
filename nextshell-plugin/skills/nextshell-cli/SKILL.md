---
name: nextshell-cli
description: Operate remote servers through the running NextShell desktop app — run commands, read logs and files, check monitoring, upload/download files over SSH without holding any credential. Activate when the user mentions NextShell, or asks to check/deploy/investigate a server that NextShell manages, or when SSH access is needed but no key/password is available to the agent.
allowed-tools: Bash(node:*)
---

# NextShell CLI

Operate servers through a **running NextShell desktop app**. You never see a credential —
NextShell resolves hosts, holds the SSH keys, enforces per-host authorization and asks the
human for confirmation when policy requires it. Every action is visible live in its GUI.

The CLI is the single file `scripts/nextshell-cli.mjs` next to this SKILL.md. It needs
Node.js ≥ 20 and nothing else. Set a shell variable once and reuse it:

```bash
NS="node <path-to-this-skill>/scripts/nextshell-cli.mjs"
```

## Quick start

```bash
$NS status                                    # is NextShell running + agent access on?
$NS host_list                                 # which hosts am I allowed to touch?
$NS exec --target web-1 --command "uptime"
$NS file_read --target web-1 --path /var/log/nginx/error.log
```

- `--target` accepts a host name, connection id, or an active session id from `session_list`.
- Tool arguments are `--key value` (or `--key=value`); numbers/booleans are auto-typed.
- `$NS tools` lists every tool; `$NS tools --full` prints the full JSON schemas.

## Observe (read-only, auto-approved)

```bash
$NS host_describe --target web-1              # host + active sessions + monitor summary
$NS session_list                              # the human's open terminal tabs, with cwd
$NS session_history --target <sessionId>      # commands, exit codes, bounded output
$NS session_read --target <sessionId>         # rendered screen — safe for top/vim/TUIs
$NS session_read --target <sessionId> --mode scrollback --lines 200
$NS monitor_snapshot --target web-1           # CPU / memory / disk / network snapshot
$NS file_list --target web-1 --path /opt/app
$NS file_stat --target web-1 --path /opt/app/config.yml
$NS command_search                            # user's saved command library
```

## Execute commands

```bash
$NS exec --target web-1 --command "systemctl status nginx"
$NS exec --target web-1 --command "journalctl -u app --since -1h | tail -50"
$NS exec --target web-1 --command "df -h" --cwd /var
$NS exec --target web-1 --command "sleep 100 && echo done" --timeoutSec 180 --timeout 200
```

Read-only commands run immediately. Unknown or dangerous commands may pop a confirmation
inside NextShell — the call blocks until the human decides. `--timeoutSec` is the remote
command budget; `--timeout` is how long the CLI itself waits (default 300s).

## Remote files

```bash
$NS file_write --target web-1 --path /opt/app/.env.staging --content "PORT=8080"
$NS file_mkdir --target web-1 --path /opt/app/releases/v2
$NS file_rename --target web-1 --from /opt/app/current --to /opt/app/previous
$NS file_delete --target web-1 --path /tmp/old-build --type directory   # always confirmed in-app
```

`file_write` is for small files (≤1MB). For anything bigger, or whole directories, use transfers.

## Transfers (local ⇄ remote, async)

```bash
$NS transfer_upload --target web-1 --localPath ./dist.tar.gz --remotePath /opt/app/
$NS transfer_download --target web-1 --remotePath /var/log/app.log --localPath ./app.log
```

Both return a `taskId` immediately. Poll until `status` is `success` / `failed` / `cancelled`:

```bash
$NS transfer_status --taskId <taskId>         # repeat every few seconds
$NS transfer_cancel --taskId <taskId>
```

Uploading a directory packs it as tar.gz and unpacks remotely. A `local path rejected`
error is a NextShell policy decision (credential dirs, browser profiles, `.env`, keys are
blocked) — report it to the user; never try to smuggle the file via another path.

## Drive the human's terminal (PTY)

Prefer `exec`. Use these only when state lives inside an interactive session
(a TUI, a prompt waiting for input, an activated venv/container):

```bash
$NS session_open --target web-1               # opens a visible tab, marked "Agent 控制中"
$NS session_send_keys --target <sessionId> --text "htop" --submit
$NS session_read --target <sessionId>         # see what the screen shows now
$NS session_send_signal --target <sessionId> --signal interrupt    # Ctrl-C
$NS session_focus --target <sessionId>        # bring the tab to front, hand back to human
$NS session_close --target <sessionId>
```

Every keystroke injection is confirmed by the human in NextShell, and is rejected while
the human is actively typing in that session — wait and retry, or use `exec`.

## Talk to the user

```bash
$NS ask_user --question "重启 nginx 还是只 reload？" --json '{"choices":["restart","reload","取消"]}'
$NS notify_user --title "部署完成" --message "v2.3.1 已上线 web-1"
```

## Output and exit codes

Success prints the tool's text result (usually JSON) to stdout — pipe into `jq` freely.
`--full` prints the whole MCP result envelope instead.

- `0` success · `1` tool error (message on stdout/stderr) · `2` usage error · `3` NextShell unreachable

## Common mistakes

- **`--json` for tricky values** — a string that looks like JSON (`"true"`, `"42"`) gets
  auto-typed; force a string with `--json '{"content":"42"}'`.
- **A host missing from `host_list` is not an error to work around** — the user has not
  granted it in NextShell (连接管理 → 编辑连接 → Agent 授权). Say so and stop.
- **Exit code 3** — NextShell is not running or agent access is off (设置中心 → Agent 接入).
  Ask the user to start/enable it; do not retry in a loop.
- **Confirmation dialogs appear in NextShell, not in your terminal** — a hanging call
  usually means the human has a pending dialog. Tell them to look at the NextShell window.
- **Don't spam confirmations** — each denied or pending dialog costs rate-limit budget;
  batch your intent into fewer, clearer calls.
