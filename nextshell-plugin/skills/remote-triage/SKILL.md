---
name: remote-triage
description: Triage the health of a server managed by NextShell — resolve the host, take a monitor snapshot, then drill into failures with read-only commands. Use when the user asks to "check on", "look at", or "diagnose" a server (e.g. "看一下 prod-hk 上服务的运行情况").
---

# Remote triage through NextShell

Standard flow for "how is server X doing?" — observation first, drill-down second, never a write.

## Flow

1. **Resolve the target.** Call `host_list` (or `host_describe` if the user named a host). If the
   name matches several hosts, the tool returns candidates — pick via `ask_user`, never guess.
   If the host is missing from `host_list`, tell the user to grant it in NextShell:
   连接管理 → 编辑该连接 → 属性 → Agent 授权 → 只读/完全. Do not work around it.
2. **Snapshot before commands.** `monitor_snapshot(target)` gives CPU / memory / disk / network /
   top processes in one call. Read it before running anything — it usually decides where to look.
3. **Check the service layer** with read-only commands (auto-approved, so don't hesitate to run several):
   - `exec(target, "systemctl --failed")`
   - `exec(target, "docker ps --format '{{.Names}}\t{{.Status}}'")` when containers are in play
   - `exec(target, "journalctl -p err -n 50 --no-pager")` or `tail -n 200` of the app's log
4. **Use the human's context.** `session_list` shows live sessions with their OSC-tracked cwd and
   last command; `session_history(target)` shows what the user already ran and what it printed —
   check it before repeating their work. `session_read` shows the current screen of full-screen
   programs (top, htop, an installer) that exec cannot capture.
5. **Summarize** findings ordered by severity, each backed by the command output that shows it.

## Rules

- Stay read-only. If a fix requires a write (restart a service, delete files), state the exact
  command and ask the user before executing — even on hosts granted "full".
- Prefer `exec` over `session_send_keys`; only touch the user's PTY when state lives inside it.
- `exec` inherits the session cwd when the target is a session; the result echoes the actual
  cwd — verify it matches what you assumed.
- Long outputs are truncated; narrow with `tail`, `grep`, or time ranges instead of re-running.
