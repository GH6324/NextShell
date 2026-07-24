import { describe, expect, test } from "vitest";
import { parseIterm2CurrentDir, parseIterm2SetUserVar } from "./iterm2";

const toBase64 = (value: string): string => {
  let binary = "";
  for (const byte of new TextEncoder().encode(value)) {
    binary += String.fromCharCode(byte);
  }
  return btoa(binary);
};

describe("parseIterm2CurrentDir", () => {
  test("accepts a raw absolute path", () => {
    expect(parseIterm2CurrentDir("CurrentDir=/home/user/projects")).toBe("/home/user/projects");
  });

  test("decodes a percent-encoded path", () => {
    expect(parseIterm2CurrentDir("CurrentDir=/home/user/my%20project")).toBe(
      "/home/user/my project"
    );
  });

  test("falls back to the raw value when percent-decoding fails", () => {
    expect(parseIterm2CurrentDir("CurrentDir=/home/user/100%done")).toBe("/home/user/100%done");
  });

  test("rejects relative paths", () => {
    expect(parseIterm2CurrentDir("CurrentDir=relative/path")).toBeUndefined();
    expect(parseIterm2CurrentDir("CurrentDir=")).toBeUndefined();
  });

  test("rejects relative paths after decoding", () => {
    expect(parseIterm2CurrentDir("CurrentDir=foo%2Fbar")).toBeUndefined();
  });

  test("ignores other 1337 commands", () => {
    expect(parseIterm2CurrentDir("SetUserVar=foo=YmFy")).toBeUndefined();
    expect(parseIterm2CurrentDir("File=name.png")).toBeUndefined();
  });
});

describe("parseIterm2SetUserVar", () => {
  test("decodes a base64 value round-trip", () => {
    expect(parseIterm2SetUserVar(`SetUserVar=branch=${toBase64("main")}`)).toEqual({
      key: "branch",
      value: "main"
    });
  });

  test("decodes UTF-8 values and keeps base64 padding", () => {
    const encoded = toBase64("提交完成");
    expect(parseIterm2SetUserVar(`SetUserVar=status=${encoded}`)).toEqual({
      key: "status",
      value: "提交完成"
    });
  });

  test("rejects malformed payloads", () => {
    expect(parseIterm2SetUserVar("SetUserVar=")).toBeUndefined();
    expect(parseIterm2SetUserVar("SetUserVar==bm9rZXk=")).toBeUndefined();
    expect(parseIterm2SetUserVar("SetUserVar=no-separator")).toBeUndefined();
  });

  test("rejects values that are not valid base64", () => {
    expect(parseIterm2SetUserVar("SetUserVar=key=!!!not-base64!!!")).toBeUndefined();
  });

  test("ignores other 1337 commands", () => {
    expect(parseIterm2SetUserVar("CurrentDir=/home/user")).toBeUndefined();
  });
});
