import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { fileURLToPath, URL } from "node:url";

const LOCAL_CHUNK_GROUPS: Array<[pattern: string, chunkName: string]> = [
  ["/src/pages/sessions/", "page-sessions"],
  ["/src/pages/compose/", "page-compose"],
  ["/src/pages/collections/", "page-collections"],
  ["/src/pages/rules/", "page-rules"],
  ["/src/pages/throttling/", "page-throttling"],
  ["/src/pages/certificates/", "page-certificates"],
  ["/src/pages/settings/", "page-settings"],
];

export default defineConfig({
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
          const normalizedId = id.split("\\").join("/");

          for (const [pattern, chunkName] of LOCAL_CHUNK_GROUPS) {
            if (normalizedId.includes(pattern)) {
              return chunkName;
            }
          }

          if (!normalizedId.includes("node_modules")) {
            return undefined;
          }

          if (normalizedId.includes("@mui/icons-material")) {
            return "vendor-mui-icons";
          }

          if (
            normalizedId.includes("@mui/material") ||
            normalizedId.includes("@mui/system") ||
            normalizedId.includes("@emotion")
          ) {
            return "vendor-mui";
          }

          if (normalizedId.includes("react-router")) {
            return "vendor-router";
          }

          if (
            normalizedId.includes("/react/") ||
            normalizedId.includes("/react-dom/") ||
            normalizedId.includes("scheduler")
          ) {
            return "vendor-react";
          }

          if (normalizedId.includes("@tauri-apps")) {
            return "vendor-tauri";
          }

          if (
            normalizedId.includes("@tanstack/react-query") ||
            normalizedId.includes("zustand")
          ) {
            return "vendor-state";
          }

          return "vendor";
        },
      },
    },
  },
  resolve: {
    alias: {
      "@": fileURLToPath(new URL("./src", import.meta.url)),
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
