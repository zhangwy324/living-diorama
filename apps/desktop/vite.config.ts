import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

// Set by `tauri dev` when targeting a remote device; unused on Windows desktop.
const host = process.env.TAURI_DEV_HOST;

export default defineConfig({
  plugins: [react()],
  // Keep Rust compiler errors visible in the terminal.
  clearScreen: false,
  server: {
    // Tauri's devUrl expects this exact port. Kept outside Windows' dynamic port range, where
    // Hyper-V/WSL reserve blocks that make listen() fail with EACCES (see docs/development.md).
    port: 17420,
    strictPort: true,
    host: host ?? false,
    hmr: host ? { protocol: "ws", host, port: 17421 } : undefined,
    watch: { ignored: ["**/src-tauri/**"] },
  },
  build: {
    // WebView2 is Chromium-based and evergreen.
    target: "chrome120",
  },
});
