// Renderer-only dev server for browser-based bug reproduction (no Electron).
// Mirrors vite.config.ts minus the electron plugin, so `window.nextshell` is
// absent and must be mocked before the page loads — see
// scripts/renderer-repro/ and RENDERER_PLAYWRIGHT_REPRO.md at the repo root.
//
// Usage (from apps/desktop):  pnpm exec vite --config vite.renderer-repro.config.ts
import path from "node:path";
import { fileURLToPath } from "node:url";
import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig, type Plugin } from "vite";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const pkg = (name: string) => path.resolve(__dirname, "../../packages", name, "src");
const aliases = {
  "@nextshell/core": path.join(pkg("core"), "index.ts"),
  "@nextshell/shared": path.join(pkg("shared"), "index.ts"),
  "@nextshell/storage": path.join(pkg("storage"), "index.ts"),
  "@nextshell/security": path.join(pkg("security"), "index.ts"),
  "@nextshell/ssh": path.join(pkg("ssh"), "index.ts"),
  "@nextshell/terminal": path.join(pkg("terminal"), "index.ts"),
  "@nextshell/ui-kit": path.join(pkg("ui-kit"), "index.ts")
};

// Same trimming as the real config so the icon font resolves in dev.
const remixiconWoff2Only = (): Plugin => ({
  name: "nextshell-remixicon-woff2-only",
  enforce: "pre",
  transform(source, id) {
    const normalizedId = id.replaceAll("\\", "/").split("?", 1)[0];
    if (!normalizedId?.endsWith("/remixicon/fonts/remixicon.css")) {
      return null;
    }
    return source.replace(
      /@font-face\s*\{[\s\S]*?\}/,
      `@font-face {
  font-family: "remixicon";
  src: url("remixicon.woff2") format("woff2");
  font-display: swap;
}`
    );
  }
});

export default defineConfig({
  plugins: [remixiconWoff2Only(), tailwindcss(), react()],
  resolve: {
    alias: aliases
  },
  define: {
    __APP_VERSION__: JSON.stringify("0.0.0-repro"),
    __GITHUB_REPO__: JSON.stringify("HynoR/NextShell")
  },
  // 5173 is what the CSP meta in index.html allowlists for dev connect-src.
  server: {
    port: 5173,
    strictPort: true
  }
});
