import { defineConfig } from "tsup";

export default defineConfig({
  entry: ["index.ts", "tools/dna-philosophy.ts", "tools/dna-convention.ts"],
  format: ["esm"],
  dts: false,
  sourcemap: true,
  clean: true,
  external: ["openclaw", "openclaw/plugin-sdk/core"],
});
