import path from "node:path";
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { codeInspectorPlugin } from "code-inspector-plugin";

export default defineConfig(({ command }) => ({
  root: "src",
  plugins: [
    command === "serve" &&
      codeInspectorPlugin({
        bundler: "vite",
      }),
    react(),
  ].filter(Boolean),
  base: "./",
  build: {
    outDir: "../dist",
    emptyOutDir: true,
    chunkSizeWarningLimit: 850,
    rollupOptions: {
      output: {
        manualChunks(id) {
          if (!id.includes("node_modules")) return undefined;
          if (id.includes("/three/")) return "vendor-three";
          if (id.includes("/smol-toml/") || id.includes("/jsonc-parser/")) {
            return "vendor-config";
          }
          if (
            id.includes("/recharts/") ||
            id.includes("/d3-") ||
            id.includes("/victory-vendor/")
          ) {
            return "vendor-charts";
          }
          if (
            id.includes("/react/") ||
            id.includes("/react-dom/") ||
            id.includes("/scheduler/")
          ) {
            return "vendor-react";
          }
          if (id.includes("/@tauri-apps/")) return "vendor-tauri";
          if (id.includes("/@codemirror/") || id.includes("/codemirror/")) {
            return "vendor-editor";
          }
          if (id.includes("/@radix-ui/")) return "vendor-radix";
          if (id.includes("/framer-motion/")) return "vendor-motion";
          if (
            id.includes("/lucide-react/") ||
            id.includes("/sonner/") ||
            id.includes("/clsx/") ||
            id.includes("/tailwind-merge/")
          ) {
            return "vendor-ui";
          }
          if (
            id.includes("/@tanstack/") ||
            id.includes("/i18next/") ||
            id.includes("/react-i18next/") ||
            id.includes("/zod/")
          ) {
            return "vendor-core";
          }
          return undefined;
        },
      },
    },
  },
  server: {
    port: 3000,
    strictPort: true,
  },
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "./src"),
    },
  },
  clearScreen: false,
  envPrefix: ["VITE_", "TAURI_"],
}));
