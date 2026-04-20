#!/usr/bin/env node
/**
 * DNA Injection CLI — Manage prompt injection files.
 *
 * Usage:
 *   dna injection --list           List all injections (id, trigger)
 *   dna injection <slug>           Show full content of an injection
 */
import { join } from "node:path";
import { readFileSync, existsSync, readdirSync } from "node:fs";
import { DNA_DATA, parseFrontmatter } from "../lib/common.ts";

const INJECTIONS_DIR = join(DNA_DATA, "injections");

const HELP = `🧬 DNA Injection CLI

Usage:
  dna injection --list           List all injections (id, trigger)
  dna injection <slug>           Show full content of an injection

Files live in:
  ${INJECTIONS_DIR}

Each .md file uses frontmatter:
  ---
  id: <slug>
  trigger: always | cron | interactive
  ---
`;

interface Injection {
  id: string;
  trigger: string;
  title?: string;
  body: string;
  filename: string;
}

function loadAll(): Injection[] {
  if (!existsSync(INJECTIONS_DIR)) return [];
  return readdirSync(INJECTIONS_DIR)
    .filter((f) => f.endsWith(".md"))
    .sort()
    .map((filename) => {
      const raw = readFileSync(join(INJECTIONS_DIR, filename), "utf-8");
      const { meta, body } = parseFrontmatter(raw);
      return {
        id: (meta.id as string) || filename.replace(/\.md$/, ""),
        trigger: (meta.trigger as string) || "always",
        title: meta.title as string | undefined,
        body,
        filename,
      };
    });
}

function cmdList() {
  const items = loadAll();
  if (!items.length) {
    console.log(`No injections found in ${INJECTIONS_DIR}`);
    return;
  }
  console.log(`🧬 Prompt Injections — ${items.length} entries\n`);
  const idCol = Math.max(...items.map((i) => i.id.length), 4) + 2;
  const trgCol = Math.max(...items.map((i) => i.trigger.length), 7) + 2;
  console.log(
    `${"ID".padEnd(idCol)}${"TRIGGER".padEnd(trgCol)}TITLE`,
  );
  console.log("-".repeat(idCol + trgCol + 30));
  for (const i of items) {
    console.log(
      `${i.id.padEnd(idCol)}${i.trigger.padEnd(trgCol)}${i.title || ""}`,
    );
  }
}

function cmdShow(slug: string) {
  const items = loadAll();
  const found = items.find((i) => i.id.toLowerCase() === slug.toLowerCase());
  if (!found) {
    console.error(`❌ Injection not found: ${slug}`);
    console.error(`   Run 'dna injection --list' to see available injections.`);
    process.exit(1);
  }
  console.log(found.body);
}

// ── Main ──
const args = process.argv.slice(2);
if (!args.length || args[0] === "--help" || args[0] === "-h") {
  console.log(HELP);
  process.exit(0);
}

if (args[0] === "--list") cmdList();
else cmdShow(args[0]);
