#!/usr/bin/env tsx
/**
 * DNA Module Check — exits 0 if a module is enabled in config, 1 if not.
 *
 * Usage (internal, called by bin/dna guard):
 *   dna module-check <name>
 *
 * Prints a user-friendly error to stderr when the module is not enabled,
 * so bin/dna can just do:
 *   dna module-check philosophy || exit 1
 */
import { loadConfig, getModule } from "../lib/config.ts";
import { existsSync } from "node:fs";

const name = process.argv[2];
if (!name) {
  console.error("Usage: dna module-check <name>");
  process.exit(1);
}

const cfg = loadConfig();
const mod = getModule(cfg, name);

if (mod) {
  process.exit(0);
}

// Not enabled — print friendly guidance
const configPath = process.env.DNA_CONFIG ||
  (() => {
    const home = process.env.HOME || "";
    const candidates = [
      `${home}/.dna/dna.config.yaml`,
      `${home}/.openclaw/.dna/dna.config.yaml`,
      `${home}/.agentic-dna/dna.config.yaml`,
    ];
    for (const c of candidates) {
      if (existsSync(c)) return c;
    }
    return `${home}/.openclaw/.dna/dna.config.yaml`;
  })();

console.error(`Module '${name}' is not enabled.`);
console.error(`To enable it, add to ${configPath}:`);
console.error(``);
console.error(`  modules:`);
console.error(`    ${name}:`);
console.error(``);
console.error(`Then re-run your command.`);
process.exit(1);
