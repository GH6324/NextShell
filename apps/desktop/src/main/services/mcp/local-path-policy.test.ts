import { describe, expect, test } from "vitest";

import { evaluateLocalPath, expandLocalPath } from "./local-path-policy";

const HOME = "/Users/tester";
const APP_DATA = "/Users/tester/Library/Application Support/NextShell";

/**
 * Nothing on the machine running the suite is touched: the fake resolver maps a
 * handful of symlinks and otherwise reports the path unchanged, which is what a
 * real `realpathSync` does for an existing plain path.
 */
const withLinks = (links: Record<string, string> = {}) => {
  return (target: string): string => {
    const mapped = links[target];
    if (mapped) return mapped;
    // Mimic realpathSync on a missing path so the caller walks up to the parent.
    if (target.includes("/missing/")) throw new Error("ENOENT");
    return target;
  };
};

const evaluate = (
  input: string,
  intent: "read" | "write" = "read",
  overrides: { allowedRoots?: string[]; links?: Record<string, string> } = {}
) =>
  evaluateLocalPath(input, intent, {
    homeDir: HOME,
    appDataDir: APP_DATA,
    allowedRoots: overrides.allowedRoots ?? [],
    realpath: withLinks(overrides.links)
  });

describe("expandLocalPath", () => {
  test("expands ~ and collapses traversal", () => {
    expect(expandLocalPath("~", HOME)).toBe(HOME);
    expect(expandLocalPath("~/repo/../repo/dist", HOME)).toBe(`${HOME}/repo/dist`);
    expect(expandLocalPath("/opt/app/./bin", HOME)).toBe("/opt/app/bin");
  });
});

describe("credential exfiltration", () => {
  test.each([
    ["~/.ssh/id_rsa", "ssh key directory"],
    ["~/.aws/credentials", "aws credentials"],
    ["~/.gnupg/secring.gpg", "gnupg"],
    ["~/.config/gcloud/application_default_credentials.json", "gcloud"],
    ["~/Library/Keychains/login.keychain-db", "keychain"],
    ["~/Library/Application Support/Google/Chrome/Default/Cookies", "chrome profile"],
    ["~/project/.env", "dotenv"],
    ["~/project/.env.production", "dotenv variant"],
    ["~/certs/server.pem", "pem"],
    ["~/certs/wildcard.key", "private key"],
    ["~/.npmrc", "npm token file"]
  ])("refuses to read %s (%s)", (candidate) => {
    expect(evaluate(candidate).allowed).toBe(false);
  });

  test("a symlink pointing into a denied directory is refused", () => {
    const decision = evaluate("/tmp/handy", "read", {
      links: { "/tmp/handy": `${HOME}/.ssh/id_ed25519` }
    });
    expect(decision.allowed).toBe(false);
    expect(decision.resolved).toBe(`${HOME}/.ssh/id_ed25519`);
  });

  test("NextShell's own data directory is refused", () => {
    expect(evaluate(`${APP_DATA}/storage/nextshell.db`).allowed).toBe(false);
  });

  test("an ordinary build artifact is allowed", () => {
    const decision = evaluate("~/repo/myproject/dist/app-1.0.tar.gz");
    expect(decision.allowed).toBe(true);
    expect(decision.resolved).toBe(`${HOME}/repo/myproject/dist/app-1.0.tar.gz`);
  });
});

describe("write intent", () => {
  test("refuses to overwrite files executed at login", () => {
    expect(evaluate("~/.zshrc", "write").allowed).toBe(false);
    expect(evaluate("~/.bashrc", "write").allowed).toBe(false);
    expect(evaluate("~/Library/LaunchAgents/evil.plist", "write").allowed).toBe(false);
    expect(evaluate("~/.config/autostart/evil.desktop", "write").allowed).toBe(false);
  });

  test("refuses to write into system directories", () => {
    expect(evaluate("/usr/local/bin/kubectl", "write").allowed).toBe(false);
    expect(evaluate("/etc/hosts", "write").allowed).toBe(false);
  });

  test("reading a system file stays allowed — only writing it is the risk", () => {
    expect(evaluate("/etc/hosts", "read").allowed).toBe(true);
    expect(evaluate("/usr/local/bin/kubectl", "read").allowed).toBe(true);
  });

  test("a destination that does not exist yet resolves through its parent", () => {
    const decision = evaluateLocalPath(`${HOME}/downloads/missing/report.txt`, "write", {
      homeDir: HOME,
      appDataDir: APP_DATA,
      allowedRoots: [],
      realpath: withLinks()
    });
    expect(decision.allowed).toBe(true);
    expect(decision.resolved).toBe(`${HOME}/downloads/missing/report.txt`);
  });
});

describe("allowed roots", () => {
  test("confines the agent to the configured roots", () => {
    expect(evaluate("~/repo/app/dist.tar.gz", "read", { allowedRoots: ["~/repo"] }).allowed).toBe(
      true
    );
    const outside = evaluate("~/Documents/taxes.pdf", "read", { allowedRoots: ["~/repo"] });
    expect(outside.allowed).toBe(false);
    expect(outside.reason).toContain("允许的根目录");
  });

  test("an allowed root never unlocks a denied subdirectory", () => {
    // The user allowed their whole home; ~/.ssh must still be off limits.
    expect(evaluate("~/.ssh/id_rsa", "read", { allowedRoots: ["~"] }).allowed).toBe(false);
  });

  test("traversal cannot escape an allowed root", () => {
    expect(
      evaluate("~/repo/../Documents/taxes.pdf", "read", { allowedRoots: ["~/repo"] }).allowed
    ).toBe(false);
  });
});

describe("macOS firmlinks", () => {
  /**
   * On macOS `realpath` moves `/Users`, `/home` and friends onto the data
   * volume. Left unnormalized that both hides every `~/…` rule and falsely
   * trips the `/System` write rule for ordinary files in the user's home.
   */
  const firmlinked = withLinks({
    [`${HOME}/.ssh`]: `/System/Volumes/Data${HOME}/.ssh`,
    [`${HOME}/.ssh/config`]: `/System/Volumes/Data${HOME}/.ssh/config`,
    [`${HOME}/Downloads/report.pdf`]: `/System/Volumes/Data${HOME}/Downloads/report.pdf`,
    [HOME]: `/System/Volumes/Data${HOME}`
  });
  const evaluateFirmlinked = (input: string, intent: "read" | "write" = "read") =>
    evaluateLocalPath(input, intent, {
      homeDir: HOME,
      appDataDir: APP_DATA,
      allowedRoots: [],
      realpath: firmlinked
    });

  test("a denied home directory is still denied through the data-volume alias", () => {
    expect(evaluateFirmlinked(`${HOME}/.ssh/config`).allowed).toBe(false);
  });

  test("an ordinary home file is not mistaken for a write into /System", () => {
    const decision = evaluateFirmlinked(`${HOME}/Downloads/report.pdf`, "write");
    expect(decision.allowed).toBe(true);
    // The dialog shows the path the user recognizes, not the mount-point form.
    expect(decision.resolved).toBe(`${HOME}/Downloads/report.pdf`);
  });

  test("naming the data-volume path directly does not bypass a rule", () => {
    expect(evaluateFirmlinked(`/System/Volumes/Data${HOME}/.ssh/config`).allowed).toBe(false);
  });
});

describe("malformed input", () => {
  test("rejects empty paths and NUL bytes", () => {
    expect(evaluate("   ").allowed).toBe(false);
    expect(evaluate("/tmp/a\0b").allowed).toBe(false);
  });

  test("rejects a relative path instead of resolving it against the app cwd", () => {
    const decision = evaluate("repo/dist.tar.gz");
    expect(decision.allowed).toBe(false);
    expect(decision.reason).toContain("绝对路径");
  });
});
