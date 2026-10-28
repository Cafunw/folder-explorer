import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { execSync } from "node:child_process";
import { version } from "./package.json";

// the About row shows where a build sits relative to the release tags (src/version.ts); without git it's ""
function gitDescribe() {
  try {
    return execSync('git describe --tags --long --dirty --always --match "v[0-9]*"', { stdio: ["ignore", "pipe", "ignore"] })
      .toString()
      .trim();
  } catch {
    return "";
  }
}

export default defineConfig({
  plugins: [react()],
  clearScreen: false,
  define: {
    __APP_VERSION__: JSON.stringify(version),
    __APP_DESCRIBE__: JSON.stringify(gitDescribe()),
  },
  server: {
    port: 1420,
    strictPort: true,
    watch: { ignored: ["**/src-tauri/**"] },
  },
  build: {
    target: "es2022",
    outDir: "dist",
    emptyOutDir: true,
  },
  test: { include: ["src/**/*.test.{ts,tsx}", "scripts/**/*.test.mjs"] },
});
