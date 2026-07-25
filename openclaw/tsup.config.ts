import { defineConfig } from "tsup";

export default defineConfig({
  entry: {
    "index-codex-safe": "index.ts",
    "tools/dna-philosophy": "tools/dna-philosophy.ts",
    "tools/dna-convention": "tools/dna-convention.ts",
  },
  format: ["esm"],
  dts: false,
  sourcemap: true,
  clean: true,
  noExternal: ["@sinclair/typebox"],
  external: ["openclaw", "openclaw/plugin-sdk/core"],
});
