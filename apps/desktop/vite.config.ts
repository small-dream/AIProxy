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
      // MUI v9's internal/Transition.mjs imports react-transition-group via a
      // directory import (no extension) that strict ESM (vitest) can't resolve
      // because the subpath isn't in react-transition-group's `exports`.
      // Redirect to the real file.
      "react-transition-group/TransitionGroupContext":
        "react-transition-group/cjs/TransitionGroupContext.js",
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
    // MUI v9 ships internal ESM (internal/Transition.mjs) that imports
    // react-transition-group/TransitionGroupContext as a directory import.
    // vitest externalizes node_modules by default, so Node's strict ESM
    // resolver rejects it (and skips the resolve.alias above). Inline
    // @mui/material so vite's resolver — with the alias — handles its
    // internal imports instead.
    server: {
      deps: {
        inline: ["@mui/material"],
      },
    },
  },
});
