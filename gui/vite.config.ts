import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { resolve } from "path";

export default defineConfig({
  plugins: [react()],
  root: resolve(__dirname, "src/client"),
  build: {
    outDir: resolve(__dirname, "dist/client"),
    emptyOutDir: true,
    sourcemap: true,
  },
  server: {
    port: 4893,
  },
});
