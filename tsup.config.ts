import { defineConfig } from "tsup";

export default defineConfig({
  entry: [
    "scripts/spec-cli.ts",
    "scripts/philosophy-cli.ts",
    "scripts/convention-cli.ts",
    "scripts/protocol-cli.ts",
    "scripts/flow-cli.ts",
    "scripts/search-cli.ts",
    "scripts/distill-cli.ts",
    "scripts/mesh-cli.ts",
    "scripts/tool-cli.ts",
    "scripts/skill-cli.ts",
    "scripts/hydrate-cli.ts",
    "scripts/injection-cli.ts",
  ],
  outDir: "dist/scripts",
  format: "esm",
  target: "node18",
  clean: true,
  splitting: false,
  // Don't bundle node_modules dependencies
  external: ["js-yaml", "@huggingface/transformers"],
});
