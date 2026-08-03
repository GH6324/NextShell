---
name: disk-forensics
description: Find what is eating disk space on a server managed by NextShell — start from the user's session cwd, drill down layer by layer with du, list the culprits structurally. Use when the user asks what is taking up space, why a disk is full, or to find the largest directories/files (e.g. "查看当前占用最大的文件夹").
---

# Disk usage drill-down through NextShell

"当前占用最大" refers to the directory the user's terminal is sitting in, not `$HOME`.

## Flow

1. **Anchor on the user's context.** `session_list` reports each live session's OSC-tracked cwd.
   If the user has a session on the host, start from its cwd (pass the sessionId as the exec
   target so the cwd is inherited; the result echoes the actual directory — check it). No session
   or no cwd (shell integration missing)? Ask which directory to start from, or start from `/`
   with `df -h` to pick the full mount first.
2. **Get the global picture once.** `exec(target, "df -h")` — knowing which filesystem is full
   prevents drilling into the wrong mount.
3. **Drill down one level at a time.**
   `exec(target, "du -xsh -- * .[!.]* 2>/dev/null | sort -h | tail -20", cwd: <current>)`
   then descend into the biggest entry by passing the deeper path as `cwd`. `-x` keeps `du` from
   crossing mounts and double-counting.
4. **Inspect the leaf structurally.** `file_list(target, path)` gives sizes and mtimes as data —
   better than parsing `ls` output. For many-small-files suspicion, `find . -type f | wc -l`.
5. **Report** the chain from the starting point to the culprits, with sizes at each level. If
   cleanup is warranted, propose the exact deletion commands and let the user decide — deletions
   always require their confirmation, and old-but-large logs or caches may still matter.

## Rules

- Read-only throughout; the whole drill-down runs without interrupting the user.
- On slow/huge trees prefer `du -xd1 -h` over `-s` per entry, and warn that the first pass over
  a cold cache can take a while.
