#!/usr/bin/env node
/**
 * DNA Philosophy CLI — Query the philosophy database.
 *
 * Usage:
 *   dna philosophy --list                        # List all entries
 *   dna philosophy artifact-is-the-test          # Full text of entry
 *   dna philosophy --inject artifact-is-the-test # Injectable format
 *   dna philosophy --search "artifact"           # Search by keyword
 *   dna philosophy --agent my-agent              # Show agent's philosophy
 */
import { join } from "node:path";
import { readFileSync, existsSync, writeFileSync } from "node:fs";
import { execSync } from "node:child_process";
import { DNA_DATA, INJECT_CHAR_LIMIT, resolveAgentWorkspace, loadYaml } from "../lib/common.ts";
import { buildGraph, getNodesByType, nodeToEntry } from "./mesh-cli.ts";

const PHILOSOPHY_DIR = join(DNA_DATA, "philosophies");

/** Load global philosophy entries via mesh graph. */
function loadGlobalEntries(): Array<Record<string, any>> {
  const graph = buildGraph();
  const nodes = getNodesByType(graph, "philosophy");
  // Sort by id (slug) for stable output
  nodes.sort((a, b) => {
    const ai = (a.fields.id || a.id).toString() + '.md';
    const bi = (b.fields.id || b.id).toString() + '.md';
    return ai < bi ? -1 : ai > bi ? 1 : 0;
  });
  return nodes.map(nodeToEntry);
}
const HELP = `🧬 DNA Philosophy CLI

Usage:
  dna philosophy --list                        List all entries
  dna philosophy <slug>                        Full text of entry
  dna philosophy --inject <slug>               Injectable format
  dna philosophy --search <query>              Search by keyword
  dna philosophy --agent <id>                  Show agent's philosophy
  dna philosophy --add <slug>                  Create new entry (opens in $EDITOR)
  dna philosophy --edit <slug>                 Edit existing entry in $EDITOR
  dna philosophy --rm <slug>                   Trash an entry`;

function cmdList() {
  const entries = loadGlobalEntries();
  if (!entries.length) { console.log("No philosophy entries found."); return; }
  console.log(`🧬 Philosophy Database — ${entries.length} entries\n`);
  const col = Math.max(...entries.map(e => (e.id as string).length)) + 2;
  console.log(`${"ID".padEnd(col)} ${"Title".padEnd(40)} Tags`);
  console.log("-".repeat(col + 50));
  for (const e of entries) {
    const tags = Array.isArray(e.tags) ? e.tags.join(", ") : (e.tags || "");
    console.log(`${(e.id as string).padEnd(col)} ${(e.title || "?").toString().padEnd(40)} ${tags}`);
  }
}

function cmdShow(slug: string) {
  const entries = loadGlobalEntries();
  const e = entries.find(e => (e.id as string).toLowerCase() === slug.toLowerCase());
  if (!e) { console.error(`❌ Entry not found: ${slug}`); process.exit(1); }
  console.log(e._body);
}

function cmdInject(slug: string) {
  const entries = loadGlobalEntries();
  const e = entries.find(e => (e.id as string).toLowerCase() === slug.toLowerCase());
  if (!e) { console.error(`❌ Entry not found: ${slug}`); process.exit(1); }

  const summary = e.summary || (() => {
    console.error(`⚠️ No summary field for ${e.id} — using body fallback`);
    return (e._body as string).slice(0, 500).trimEnd();
  })();

  let output = `<!-- DNA:${e.id} -->\n**🧬 ${e.id}** *(summary)*: ${summary}\n\n> 📖 *Full text*: \`dna philosophy ${e.id}\`\n<!-- /DNA:${e.id} -->`;
  if (output.length > INJECT_CHAR_LIMIT) {
    let truncated = output.slice(0, INJECT_CHAR_LIMIT);
    const lastNl = truncated.lastIndexOf("\n");
    if (lastNl > INJECT_CHAR_LIMIT / 2) truncated = truncated.slice(0, lastNl);
    output = truncated + `\n\n⚠️ TRUNCATED — run \`dna philosophy ${e.id}\` for full text.\n<!-- /DNA:${e.id} -->`;
  }
  console.log(output);
}

function cmdSearch(query: string) {
  const entries = loadGlobalEntries();
  const q = query.toLowerCase();
  const results = entries.filter(e => {
    const searchable = `${e.title || ""} ${e._body || ""} ${e.tags || ""}`;
    return searchable.toLowerCase().includes(q);
  });
  if (!results.length) { console.log(`No entries matching '${query}'`); return; }
  console.log(`🔍 ${results.length} entries matching '${query}':\n`);
  for (const e of results) console.log(`  ${e.id}: ${e.title}`);
}

function cmdAgent(agentId: string) {
  const workspace = resolveAgentWorkspace(agentId);
  if (!workspace) { console.error(`❌ Agent not found: ${agentId}`); process.exit(1); }
  const dnaPath = existsSync(join(workspace, "dna.yml"))
    ? join(workspace, "dna.yml")
    : join(workspace, "dna.yaml");
  if (!existsSync(dnaPath)) { console.error(`❌ No dna.yaml found in ${workspace}`); process.exit(1); }

  const data = loadYaml(dnaPath);
  // Find philosophy list - could be at root or nested
  const root = data && typeof data === "object" ? data : {};
  const firstKey = Object.keys(root)[0];
  const inner = (firstKey && typeof root[firstKey] === "object" && !Array.isArray(root[firstKey])) ? root[firstKey] : root;
  const phiIds: string[] = inner?.philosophy || [];
  if (!phiIds.length) { console.log(`No philosophy entries in ${dnaPath}`); return; }

  const entries = loadGlobalEntries();
  const entryMap = new Map(entries.map(e => [(e.id as string).toLowerCase(), e]));
  console.log(`🧬 ${agentId} Philosophy — ${phiIds.length} entries\n`);
  for (const pid of phiIds) {
    const e = entryMap.get(pid.toLowerCase());
    console.log(e ? `  ${pid}: ${e.title}` : `  ${pid}: ❌ NOT FOUND`);
  }
}

function slugToTitle(slug: string): string {
  return slug.split("-").map(w => w.charAt(0).toUpperCase() + w.slice(1)).join(" ");
}

function cmdAdd(slug: string) {
  const filePath = join(PHILOSOPHY_DIR, `${slug}.md`);
  if (existsSync(filePath)) { console.error(`❌ Entry already exists: ${slug}`); process.exit(1); }
  const template = `---\nid: ${slug}\ntitle: "${slugToTitle(slug)}"\ntags: []\n---\n\n# ${slug}\n\n## Principle\n\n(describe the principle here)\n`;
  writeFileSync(filePath, template, "utf-8");
  const editor = process.env.EDITOR || "vi";
  execSync(`${editor} ${filePath}`, { stdio: "inherit" });
  console.log(`✅ Created: ${filePath}`);
}

function cmdEdit(slug: string) {
  const filePath = join(PHILOSOPHY_DIR, `${slug}.md`);
  if (!existsSync(filePath)) { console.error(`❌ Entry not found: ${slug}`); process.exit(1); }
  const editor = process.env.EDITOR || "vi";
  execSync(`${editor} ${filePath}`, { stdio: "inherit" });
}

function cmdRm(slug: string) {
  const filePath = join(PHILOSOPHY_DIR, `${slug}.md`);
  if (!existsSync(filePath)) { console.error(`❌ Entry not found: ${slug}`); process.exit(1); }
  try {
    execSync(`which trash`, { stdio: "ignore" });
    execSync(`trash ${filePath}`, { stdio: "inherit" });
  } catch {
    execSync(`mv ${filePath} ~/.Trash/`, { stdio: "inherit" });
  }
  console.log(`🗑️  Trashed: ${slug}`);
}

// ── Main ──
const args = process.argv.slice(2);
if (!args.length || args[0] === "--help" || args[0] === "-h") { console.log(HELP); process.exit(0); }

if (args[0] === "--list" || args[0] === "list") cmdList();
else if ((args[0] === "--search" || args[0] === "search") && args[1]) cmdSearch(args[1]);
else if (args[0] === "--agent" && args[1]) cmdAgent(args[1]);
else if (args[0] === "--inject" && args[1]) cmdInject(args[1]);
else if (args[0] === "--add" && args[1]) cmdAdd(args[1]);
else if (args[0] === "--edit" && args[1]) cmdEdit(args[1]);
else if (args[0] === "--rm" && args[1]) cmdRm(args[1]);
else cmdShow(args[0]);
