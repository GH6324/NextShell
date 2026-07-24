import { describe, expect, test } from "vitest";
import { parseOsc7Path } from "./osc7";

describe("parseOsc7Path", () => {
  test("parses file:// URLs with a hostname", () => {
    expect(parseOsc7Path("file://remote-host/home/user/projects")).toBe("/home/user/projects");
  });

  test("parses file:// URLs without a hostname", () => {
    expect(parseOsc7Path("file:///var/log")).toBe("/var/log");
  });

  test("decodes percent-encoded path segments", () => {
    expect(parseOsc7Path("file://host/home/user%20name/my%20project")).toBe(
      "/home/user name/my project"
    );
  });

  test("normalizes duplicate slashes and a trailing slash", () => {
    expect(parseOsc7Path("file://host//home//user/")).toBe("/home/user");
  });

  test("normalizes dot and dot-dot segments", () => {
    expect(parseOsc7Path("file://host/home/./user/../user/docs")).toBe("/home/user/docs");
  });

  test("keeps the root path", () => {
    expect(parseOsc7Path("file://host/")).toBe("/");
  });

  test("rejects non-file schemes", () => {
    expect(parseOsc7Path("http://host/home/user")).toBeUndefined();
    expect(parseOsc7Path("sftp://host/home/user")).toBeUndefined();
  });

  test("rejects relative paths and garbage input", () => {
    expect(parseOsc7Path("home/user")).toBeUndefined();
    expect(parseOsc7Path("not a url")).toBeUndefined();
    expect(parseOsc7Path("")).toBeUndefined();
  });

  test("rejects invalid percent-encoding", () => {
    expect(parseOsc7Path("file://host/home/%zz")).toBeUndefined();
  });
});
