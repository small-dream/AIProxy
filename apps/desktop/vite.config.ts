// Import defineConfig from vitest/config so the `test` field is typed. Vitest 4
// no longer augments vite's UserConfig globally, so importing from "vite" alone
// makes tsc reject the `test` key below.
import { defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react";
import { fileURLToPath, URL } from "node:url";

// User guides are bundled into the desktop app; @docs points at their source so
// docs-content.ts can import them as raw strings (single source of truth).
const docsGuidesDir = fileURLToPath(new URL("./user-guides", import.meta.url));

export default defineConfig({
  base: "./",
  plugins: [react()],
  build: {
    target: "esnext",
    cssCodeSplit: true,
    chunkSizeWarningLimit: 500,
    rollupOptions: {
      output: {
        entryFileNames(chunkInfo) {
          if (chunkInfo.name === "index") {
            return "assets/desktop-app-[hash].js";
          }

          return "assets/[name]-[hash].js";
        },
        chunkFileNames: "assets/[name]-[hash].js",
        manualChunks(id) {
          if (id.includes("node_modules")) {
            if (id.includes("@mui") || id.includes("@emotion")) {
              return "mui-vendor";
            }
            if (id.includes("react-router")) {
              return "router-vendor";
            }
            if (id.includes("/react-dom/") || id.includes("/scheduler/") || id.includes("/react/")) {
              return "react-vendor";
            }
            if (id.includes("@tanstack")) {
              return "query-vendor";
            }
            return "vendor";
          }
        },
      },
    },
  },
  resolve: {
    alias: {
      "@": fileURLToPath(new URL("./src", import.meta.url)),
      "@docs": docsGuidesDir,
    },
  },
  server: {
    port: 1420,
    strictPort: true,
  },
  test: {
    environment: "jsdom",
    globals: true,
    setupFiles: "./src/test/setup.ts",
  },
});
