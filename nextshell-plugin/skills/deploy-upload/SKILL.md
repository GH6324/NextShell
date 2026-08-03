---
name: deploy-upload
description: Upload a build artifact or directory to a server through NextShell's transfer queue — verify the target directory, upload with progress, verify integrity, unpack. Use when the user asks to deploy, upload, or copy local files to a server (e.g. "把打包好的文件传到 /opt/app").
---

# Deploy / upload through NextShell

Standard flow for moving local artifacts onto a server. Every transfer shows up in the NextShell
GUI transfer queue with an Agent badge and requires an in-app confirmation — that is expected,
not an error.

## Flow

1. **Confirm the artifact.** Build it if the user asked for that; know its absolute local path and
   size before transferring. Directories are fine — NextShell packs them (tar/gzip) automatically,
   which beats per-file copying by an order of magnitude.
2. **Verify the destination.** `file_stat(target, "/opt/app")`; if absent, `file_mkdir`. Uploading
   into a guessed path fails late and messily.
3. **Upload.** `transfer_upload(target, localPath, remotePath)` returns a `taskId` immediately;
   the user sees a confirmation dialog showing the full local path — if they reject it, stop and
   ask, don't retry. A `remotePath` ending in `/` (or naming an existing directory) gets the local
   file name appended, like `scp`.
4. **Poll** `transfer_status(taskId)` until `success` / `failed` / `cancelled`. Transfers are
   detached from the tool-call timeout; a large file simply takes a while. Back off between polls.
5. **Verify then unpack.** Compare the remote size (`file_stat`) or checksum
   (`exec: sha256sum`) against the local artifact, then e.g.
   `exec(target, "tar -xzf /opt/app/app-1.0.tar.gz -C /opt/app")` — a write command, so it will
   ask for confirmation per policy.

## Rules

- Local path policy is enforced by NextShell: credential directories (`~/.ssh`, `~/.aws`, …),
  `.env` / key files and the NextShell data directory are always refused, and the user may have
  restricted allowed roots. A `local path rejected` error is a policy decision — report it,
  never try to smuggle the file via another path.
- Small config files (< 1 MB) can go through `file_write` directly; `transfer_upload` is for
  artifacts and directories.
- Deleting remote files (`file_delete`) always prompts the user; it is not covered by any
  "always allow" grant.
