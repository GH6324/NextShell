---
description: Triage a server's health through the running NextShell app
argument-hint: <host name, address, or session>
---

Triage the NextShell-managed host "$ARGUMENTS" following the `remote-triage` skill:

1. Resolve "$ARGUMENTS" via `host_describe` (fall back to `host_list`; disambiguate with
   `ask_user`, never guess). If no argument was given, list hosts and ask which one.
2. Take a `monitor_snapshot` and read it before running any command.
3. Run the read-only sweep: `systemctl --failed`, container status if applicable, recent error
   logs. Check `session_history` for what the user already tried.
4. Report findings ordered by severity, each backed by the output that shows it. Propose — but do
   not execute — any write action.
