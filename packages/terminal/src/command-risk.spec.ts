import { describe, expect, it } from "vitest";

import { classifyCommandRisk } from "./index";

describe("classifyCommandRisk", () => {
  it.each([
    "du -sh -- * | sort -h | tail -20",
    "systemctl --failed",
    "systemctl status sshd",
    "docker ps --format '{{.Names}}'",
    "journalctl -u sshd -n 100",
    "ps aux | grep node | head -20"
  ])("accepts a proven read-only command: %s", (command) => {
    expect(classifyCommandRisk(command)).toMatchObject({ level: "readonly", hasSudo: false });
  });

  it("reports sudo independently from the risk tier", () => {
    expect(classifyCommandRisk("sudo -n ls -la /var/log")).toMatchObject({
      level: "readonly",
      hasSudo: true
    });
    expect(classifyCommandRisk("sudo -u root touch /tmp/agent-test")).toMatchObject({
      level: "unknown",
      hasSudo: true
    });
  });

  it.each([
    ["", "empty"],
    ["touch /tmp/agent-test", "not in the read-only allowlist"],
    ["ls -la > /tmp/list", "redirection"],
    ["cat < /etc/hosts", "redirection"],
    ["echo $(touch /tmp/agent-test)", "substitution"],
    ["echo $HOME", "expansion"],
    ["ps aux | tee /tmp/processes", "not in the read-only allowlist"],
    ["ls && touch /tmp/agent-test", "not in the read-only allowlist"],
    ["sh -c 'ls -la'", "not in the read-only allowlist"],
    ["sort -o /tmp/sorted", "not in the read-only allowlist"],
    ["journalctl --vacuum-time=1d", "not in the read-only allowlist"],
    ["echo 'unterminated", "incomplete"]
  ])("keeps an unproven command unknown: %s", (command, reasonFragment) => {
    const result = classifyCommandRisk(command);
    expect(result.level).toBe("unknown");
    expect(result.reason.toLowerCase()).toContain(reasonFragment.toLowerCase());
  });

  it.each([
    "rm -rf /",
    "/bin/rm --recursive --force -- /",
    "mkfs.ext4 /dev/sda1",
    "dd if=/dev/zero of=/dev/sda bs=1M",
    "shutdown -h now",
    "reboot",
    ":(){ :|:& };:",
    "echo destroy > /dev/nvme0n1",
    "chmod -R 777 /",
    "kill -9 -1"
  ])("recognizes a dangerous command: %s", (command) => {
    expect(classifyCommandRisk(command).level).toBe("dangerous");
  });

  it.each([
    "r''m -r -f /",
    "/usr/bin/r\\m -fr -- /*",
    "sudo -- rm -rf //",
    "sudo -u root /sbin/mkfs.xfs /dev/sdb1",
    "dd 'of=/dev/disk0' if=/dev/zero",
    "printf x 2>\"/dev/sda\"",
    "command rm -rf /",
    "env LC_ALL=C rm -rf /",
    "busybox rm -rf /",
    "sh -c 'rm -rf /'"
  ])("does not allow a simple quoting or path bypass: %s", (command) => {
    const result = classifyCommandRisk(command);
    expect(result.level).toBe("dangerous");
  });

  it("does not treat harmless /dev/null output as device destruction", () => {
    expect(classifyCommandRisk("grep error /var/log/app.log 2>/dev/null").level).toBe("unknown");
  });
});
