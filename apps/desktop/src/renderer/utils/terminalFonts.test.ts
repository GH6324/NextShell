import {
  TERMINAL_DEFAULT_FONT_FAMILY,
  TERMINAL_FONT_PRESETS,
  canonicalizeFontFamily,
  getTerminalFontOptions
} from "./terminalFonts";

const assert = (condition: boolean, message: string): void => {
  if (!condition) {
    throw new Error(message);
  }
};

(() => {
  assert(
    TERMINAL_DEFAULT_FONT_FAMILY === "JetBrains Mono, Menlo, Monaco, monospace",
    "default terminal font family should remain unchanged"
  );
  assert(TERMINAL_FONT_PRESETS.length > 0, "terminal font presets should not be empty");
})();

(() => {
  const darwin = getTerminalFontOptions("darwin");
  const win32 = getTerminalFontOptions("win32");
  const linux = getTerminalFontOptions("linux");

  assert(darwin.length > 0, "darwin font options should not be empty");
  assert(win32.length > 0, "win32 font options should not be empty");
  assert(linux.length > 0, "linux font options should not be empty");

  assert(
    darwin[0]?.value === "SFMono-Regular, Menlo, Monaco, 'Cascadia Mono', 'JetBrains Mono', monospace",
    "darwin options should prioritize macOS-friendly monospace stack"
  );
  assert(
    win32[0]?.value === "'Cascadia Mono', Consolas, 'JetBrains Mono', 'Courier New', monospace",
    "win32 options should prioritize Windows-friendly monospace stack"
  );
  assert(
    linux[0]?.value === "'JetBrains Mono', 'DejaVu Sans Mono', 'Liberation Mono', 'Noto Sans Mono CJK SC', monospace",
    "linux options should prioritize Linux-friendly monospace stack"
  );
})();

(() => {
  const a = canonicalizeFontFamily("\"JetBrains Mono\", Menlo, Monaco, monospace");
  const b = canonicalizeFontFamily("'jetbrains mono' ,  menlo ,monaco,monospace");
  assert(a === b, "canonicalizeFontFamily should normalize quotes, spaces and case differences");
})();
