#!/usr/bin/env node
/**
 * DNA Convention CLI — Query global and local (agent-level) conventions.
 *
 * Usage:
 *   dna convention --list                          # List all global conventions
 *   dna convention use-orm-not-raw-sql             # Full text of global convention
 *   dna convention --inject use-orm-not-raw-sql    # Injectable format
 *   dna convention --agent my-agent                # Show agent's local conventions
 *   dna convention --agent my-agent --all          # Show global + local for agent
 *   dna convention --search "database"             # Search by keyword
 */
import { join } from "node:path";
import { existsSync } from "node:fs";
import { DNA_DATA, INJECT_CHAR_LIMIT, loadEntries, resolveAgentWorkspace, loadYaml } from "../lib/common.ts";

const CONVENTION_DIR = join(DNA_DATA, "conventions");
const HELP = `📏 DNA Convention CLI

Usage:
  dna convention --list                          List all global conventions
  dna convention <slug>                          Full text of global convention
  dna convention --inject <slug>                 Injectable format
  dna convention --agent <id>                    Show agent's local conventions
  dna convention --agent <id> --all              Show global + local
  dna convention --search <query>                Search by keyword`;

function cmdList() {
  const entries = loadEntries(CONVENTION_DIR);
  if (!entries.length) { console.log("No global conventions found."); return; }
  console.log(`📏 Global Conventions — ${entries.length} entries\n`);
  const col = Math.max(...entries.map(e => (e.id as string).length)) + 2;
  console.log(`${"ID".padEnd(col)} ${"Title".padEnd(45)} Derives From`);
  console.log("-".repeat(col + 60));
  for (const e of entries) {
    console.log(`${(e.id as string).padEnd(col)} ${(e.title || "?").toString().padEnd(45)} ${e["derives-from"] || "-"}`);
  }
}

function cmdShow(slug: string) {
  const entries = loadEntries(CONVENTION_DIR);
  const e = entries.find(e => (e.id as string).toLowerCase() === slug.toLowerCase());
  if (!e) { console.error(`❌ Convention not found: ${slug}`); process.exit(1); }
  console.log(e._body);
}

function cmdInject(slug: string) {
  const entries = loadEntries(CONVENTION_DIR);
  const e = entries.find(e => (e.id as string).toLowerCase() === slug.toLowerCase());
  if (!e) { console.error(`❌ Convention not found: ${slug}`); process.exit(1); }

  const derives = e["derives-from"] ? ` (← ${e["derives-from"]})` : "";
  if (e.summary) {
    console.log(`<!-- CONVENTION:${e.id} -->\n**📏 ${e.id}:** ${e.summary}${derives}\n<!-- /CONVENTION:${e.id} -->`);
    return;
  }

  let output = `<!-- CONVENTION:${e.id} -->\n## 📏 ${e.id}: ${e.title}\n\n${e._body}\n<!-- /CONVENTION:${e.id} -->`;
  if (output.length > INJECT_CHAR_LIMIT) {
    let truncated = output.slice(0, INJECT_CHAR_LIMIT);
    const lastNl = truncated.lastIndexOf("\n");
    if (lastNl > INJECT_CHAR_LIMIT / 2) truncated = truncated.slice(0, lastNl);
    output = truncated + `\n\n⚠️ TRUNCATED — run \`dna convention ${e.id}\` for full text.\n<!-- /CONVENTION:${e.id} -->`;
  }
  console.log(output);
}

function cmdSearch(query: string) {
  const entries = loadEntries(CONVENTION_DIR);
  const q = query.toLowerCase();
  const results = entries.filter(e => {
    const searchable = `${e.title || ""} ${e._body || ""} ${e.tags || ""}`;
    return searchable.toLowerCase().includes(q);
  });
  if (!results.length) { console.log(`No conventions matching '${query}'`); return; }
  console.log(`🔍 ${results.length} conventions matching '${query}':\n`);
  for (const e of results) console.log(`  ${e.id}: ${e.title}`);
}

function loadLocalConventions(agentId: string): Array<Record<string, any>> {
  const workspace = resolveAgentWorkspace(agentId);
  if (!workspace) return [];
  const dnaPath = join(workspace, "dna.yaml");
  if (!existsSync(dnaPath)) return [];

  const data = loadYaml(dnaPath);
  if (!data || typeof data !== "object") return [];

  // Unwrap root
  const root = (() => {
    const firstKey = Object.keys(data)[0];
    if (firstKey && typeof data[firstKey] === "object" && !Array.isArray(data[firstKey]) &&
        !["goal", "boundary", "tools", "philosophy", "deprecated", "spec", "conventions"].includes(firstKey)) {
      return data[firstKey];
    }
    return data;
  })();

  const conventions: Array<Record<string, any>> = root?.conventions || [];
  return conventions.map((c: any) => ({ ...c, _scope: "local" }));
}

function cmdAgent(agentId: string, includeGlobal: boolean) {
  if (includeGlobal) {
    const globalEntries = loadEntries(CONVENTION_DIR);
    if (globalEntries.length) {
      console.log(`📏 Global Conventions (${globalEntries.length}):\n`);
      for (const e of globalEntries) {
        console.log(`  ${e.id}: ${e.title} (← ${e["derives-from"] || "-"})`);
      }
      console.log();
    }
  }

  const local = loadLocalConventions(agentId);
  if (local.length) {
    console.log(`📏 ${agentId} Local Conventions (${local.length}):\n`);
    for (const c of local) {
      const derives = c["derives-from"] ? ` (← ${c["derives-from"]})` : "";
      console.log(`  ${c.id}: ${c.rule || "?"}${derives}`);
    }
  } else if (!includeGlobal) {
    console.log(`No local conventions in ${agentId}'s dna.yaml`);
  }
}

// ── Main ──
const args = process.argv.slice(2);
if (!args.length || args[0] === "--help" || args[0] === "-h") { console.log(HELP); process.exit(0); }

if (args[0] === "--list") cmdList();
else if (args[0] === "--agent" && args[1]) cmdAgent(args[1], args.includes("--all"));
else if (args[0] === "--inject" && args[1]) cmdInject(args[1]);
else if (args[0] === "--search" && args[1]) cmdSearch(args[1]);
else cmdShow(args[0]);
