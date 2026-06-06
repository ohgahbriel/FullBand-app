import { defineConfig } from "vite";

// Relative base so the built bundle works when loaded from file:// inside the
// Capacitor Android WebView (and equally from any path on the desktop).
export default defineConfig({
  base: "./",
  build: { outDir: "dist", emptyOutDir: true },
});
