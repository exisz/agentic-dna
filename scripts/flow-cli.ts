#!/usr/bin/env node
/**
 * DNA Flow CLI — Query global and local flows uniformly.
 *
 * Scope resolution:
 *   - `--agent <id>` targets that agent's workspace (explicit).
 *   - Otherwise, if CWD is inside a workspace, local flows are included.
 *   - Otherwise, only global flows.
 *
 * Local flows live at `<workspace>/.dna/flows/*.md` — same
 * markdown+frontmatter format as global. Legacy `dna.yaml → flows:`
 * yaml entries are still read (with a deprecation notice).
 *
 * Usage:
 *   dna flow --list [--agent <id>] [--scope global|local|all]
 *   dna flow <slug> [--agent <id>]                 # full text
 *   dna flow --inject <slug> [--agent <id>]        # injectable
 *   dna flow --search <query> [--agent <id>]
 *   dna flow --add <slug> [--agent <id>]           # local if in workspace
 *   dna flow --edit <slug> [--agent <id>]
 *   dna flow --rm <slug> [--agent <id>]
 */
import { join } from "node:path";
import { existsSync, writeFileSync, mkdirSync } from "node:fs";
import { execSync } from "node:child_process";
import {
  DNA_DATA,
  INJECT_CHAR_LIMIT,
  loadEntries,
  resolveAgentWorkspace,
  workspaceFromCwd,
  loadYaml,
} from "../lib/common.ts";
import { buildGraph, getNodesByType, nodeToEntry } from "./mesh-cli.ts";

const GLOBAL_DIR = join(DNA_DATA, "flows");

/** Load global flow entries via mesh graph. */
function loadGlobalFlows(): Array<Record<string, any>> {
  const graph = buildGraph();
  const nodes = getNodesByType(graph, "flow");
  nodes.sort((a, b) => {
    const ai = (a.fields.legacy_id || a.fields.id || '').toString() + '.md';
    const bi = (b.fields.legacy_id || b.fields.id || '').toString() + '.md';
    return ai < bi ? -1 : ai > bi ? 1 : 0;
  });
  return nodes.map(n => ({ ...nodeToEntry(n), _scope: "global" }));
}

const HELP = `🌊 DNA Flow CLI

Scope: every command respects --agent <id>, or auto-detects the workspace
from CWD. Without either, only global flows are in scope.

Usage:
  dna flow --list                          List flows in scope
  dna flow --list --scope global           Global only
  dna flow --list --scope local            Local only
  dna flow --list --scope all              Both (default when in workspace)
  dna flow <slug>                          Full markdown body
  dna flow --inject <slug>                 Injectable format
  dna flow --search <query>                Search by keyword
  dna flow --agent <id>                    Force workspace target
  dna flow --add <slug>                    Create (local if in workspace)
  dna flow --edit <slug>                   Edit in \$EDITOR
  dna flow --rm <slug>                     Trash

Local flows: <workspace>/.dna/flows/*.md  (same format as global).`;

// ─── Scope resolution ────────────────────────────────────────

interface Scope {
  global: boolean;
  local: boolean;
  workspace: string | null;
  agentId: string | null;
}

/** Match flow entry by slug — accepts legacy id, legacy_id field, or dna://flow/<slug> mesh id. */
function matchFlow(entries: Array<Record<string, any>>, slug: string): Record<string, any> | undefined {
  const want = slug.toLowerCase();
  const meshId = "dna://flow/" + want;
  return entries.find(e => {
    const id = String(e.id || "").toLowerCase();
    const legacy = String(e.legacy_id || "").toLowerCase();
    return id === want || legacy === want || id === meshId;
  });
}

function parseScope(args: string[]): Scope {
  const agentIdx = args.indexOf("--agent");
  const agentId = agentIdx >= 0 ? args[agentIdx + 1] : null;

  const scopeIdx = args.indexOf("--scope");
  const scopeFlag = scopeIdx >= 0 ? args[scopeIdx + 1] : null;

  let workspace: string | null = null;
  if (agentId) {
    workspace = resolveAgentWorkspace(agentId);
    if (!workspace) {
      console.error(`❌ Unknown agent: ${agentId}`);
      process.exit(1);
    }
  } else {
    workspace = workspaceFromCwd();
  }

  let global = true, local = workspace !== null;
  if (scopeFlag === "global") { global = true; local = false; }
  else if (scopeFlag === "local") { global = false; local = true; }
  else if (scopeFlag === "all") { global = true; local = true; }

  return { global, local, workspace, agentId };
}

// ─── Loaders ─────────────────────────────────────────────────

function loadLocalDir(workspace: string): Array<Record<string, any>> {
  const dir = join(workspace, ".dna/flows");
  const entries = loadEntries(dir);
  return entries.map((e) => ({ ...e, _scope: "local", _workspace: workspace }));
}

function loadLocalLegacyYaml(workspace: string): Array<Record<string, any>> {
  const dnaPath = existsSync(join(workspace, "dna.yml"))
    ? join(workspace, "dna.yml")
    : join(workspace, "dna.yaml");
  if (!existsSync(dnaPath)) return [];
  const data = loadYaml(dnaPath);
  if (!data || typeof data !== "object") return [];
  const root = (() => {
    const firstKey = Object.keys(data)[0];
    if (firstKey && typeof data[firstKey] === "object" && !Array.isArray(data[firstKey]) &&
        !["goal", "boundary", "tools", "philosophy", "deprecated", "spec", "flows"].includes(firstKey)) {
      return data[firstKey];
    }
    return data;
  })();
  const flows: Array<any> = root?.flows || [];
  if (!flows.length) return [];
  // Warn once
  console.error(`⚠️  ${workspace}/dna.yaml has legacy yaml flows — migrate to <workspace>/.dna/flows/*.md`);
  const results: Array<Record<string, any>> = [];
  for (const c of flows) {
    if (typeof c === "string") {
      results.push({ id: c, title: c, "derives-from": "", summary: "", _body: "", _scope: "local-legacy-ref", _workspace: workspace });
      continue;
    }
    if (!c || typeof c !== "object" || !c.id) {
      console.warn(`⚠️  Skipping malformed flow entry in ${workspace}/dna.yaml (missing id):`, JSON.stringify(c));
      continue;
    }
    results.push({
      id: c.id,
      title: c.title || c.id,
      "derives-from": c["derives-from"] || "",
      summary: (c.rule || "").toString().replace(/\s+/g, " ").trim(),
      _body: (c.rule || "").toString().trim(),
      _scope: "local-legacy",
      _workspace: workspace,
    });
  }
  return results;
}

function loadEntriesForScope(scope: Scope): Array<Record<string, any>> {
  const merged: Array<Record<string, any>> = [];
  const seen = new Set<string>();

  if (scope.local && scope.workspace) {
    for (const e of loadLocalDir(scope.workspace)) {
      merged.push(e);
      seen.add((e.id as string).toLowerCase());
    }
    for (const e of loadLocalLegacyYaml(scope.workspace)) {
      if (!seen.has((e.id as string).toLowerCase())) {
        merged.push(e);
        seen.add((e.id as string).toLowerCase());
      }
    }
  }
  if (scope.global) {
    for (const e of loadGlobalFlows()) {
      if (!seen.has((e.id as string).toLowerCase())) {
        merged.push(e);
        seen.add((e.id as string).toLowerCase());
      }
    }
  }
  return merged;
}

// ─── Commands ────────────────────────────────────────────────

function cmdList(scope: Scope) {
  const entries = loadEntriesForScope(scope);
  if (!entries.length) { console.log("No flows in scope."); return; }
  const scopeLabel =
    scope.global && scope.local ? "Global + Local" :
    scope.local ? `Local${scope.workspace ? ` (${scope.workspace})` : ""}` :
    "Global";
  console.log(`🌊 Flows — ${scopeLabel} — ${entries.length} entries\n`);
  const col = Math.max(...entries.map(e => (e.id as string).length)) + 2;
  console.log(`${"ID".padEnd(col)} ${"Scope".padEnd(14)} ${"Title".padEnd(45)} Derives From`);
  console.log("-".repeat(col + 75));
  for (const e of entries) {
    const scopeTag = e._scope || "global";
    console.log(`${(e.id as string).padEnd(col)} ${scopeTag.padEnd(14)} ${(e.title || "?").toString().slice(0, 44).padEnd(45)} ${e["derives-from"] || "-"}`);
  }
}

function cmdShow(slug: string, scope: Scope) {
  const entries = loadEntriesForScope(scope);
  const e = matchFlow(entries, slug);
  if (!e) { console.error(`❌ Flow not found in scope: ${slug}`); process.exit(1); }
  console.log(e._body);
}

function cmdInject(slug: string, scope: Scope) {
  const entries = loadEntriesForScope(scope);
  const e = matchFlow(entries, slug);
  if (!e) { console.error(`❌ Flow not found in scope: ${slug}`); process.exit(1); }

  const scopeSuffix = e._scope && e._scope !== "global" ? ` (${e._scope})` : "";
  const derives = e["derives-from"] ? ` (← ${e["derives-from"]})` : "";

  if (e.summary) {
    console.log(`<!-- FLOW:${e.id}${scopeSuffix} -->\n**🌊 ${e.id}** *(summary)*: ${e.summary}${derives}\n\n> 📖 *Full text*: \`dna flow ${e.id}\`\n<!-- /FLOW:${e.id} -->`);
    return;
  }
  let output = `<!-- FLOW:${e.id}${scopeSuffix} -->\n## 🌊 ${e.id}: ${e.title}\n\n${e._body}\n<!-- /FLOW:${e.id} -->`;
  if (output.length > INJECT_CHAR_LIMIT) {
    let truncated = output.slice(0, INJECT_CHAR_LIMIT);
    const lastNl = truncated.lastIndexOf("\n");
    if (lastNl > INJECT_CHAR_LIMIT / 2) truncated = truncated.slice(0, lastNl);
    output = truncated + `\n\n⚠️ TRUNCATED — run \`dna flow ${e.id}\` for full text.\n<!-- /FLOW:${e.id} -->`;
  }
  console.log(output);
}

function cmdSearch(query: string, scope: Scope) {
  const entries = loadEntriesForScope(scope);
  const q = query.toLowerCase();
  const results = entries.filter(e => {
    const searchable = `${e.title || ""} ${e._body || ""} ${e.tags || ""}`;
    return searchable.toLowerCase().includes(q);
  });
  if (!results.length) { console.log(`No flows matching '${query}'`); return; }
  console.log(`🔍 ${results.length} flows matching '${query}':\n`);
  for (const e of results) console.log(`  ${e.id} [${e._scope || "global"}]: ${e.title}`);
}

function slugToTitle(slug: string): string {
  return slug.split("-").map(w => w.charAt(0).toUpperCase() + w.slice(1)).join(" ");
}

function targetDir(scope: Scope): { dir: string; scopeLabel: string } {
  if (scope.local && scope.workspace) {
    return { dir: join(scope.workspace, ".dna/flows"), scopeLabel: "local" };
  }
  return { dir: GLOBAL_DIR, scopeLabel: "global" };
}

function cmdAdd(slug: string, scope: Scope) {
  const { dir, scopeLabel } = targetDir(scope);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  const filePath = join(dir, `${slug}.dna`);
  const legacyPath = join(dir, `${slug}.md`);
  if (existsSync(filePath) || existsSync(legacyPath)) { console.error(`❌ Flow already exists: ${slug}`); process.exit(1); }
  const template = `---\nid: ${slug}\ntitle: "${slugToTitle(slug)}"\nderives-from: ""\ntags: []\nsummary: ""\n---\n\n# ${slug}\n\n## Rule\n\n(describe the rule here)\n`;
  writeFileSync(filePath, template, "utf-8");
  const editor = process.env.EDITOR || "vi";
  execSync(`${editor} ${filePath}`, { stdio: "inherit" });
  console.log(`✅ Created (${scopeLabel}): ${filePath}`);
}

function cmdEdit(slug: string, scope: Scope) {
  const entries = loadEntriesForScope(scope);
  const e = matchFlow(entries, slug);
  if (!e || !e._path) { console.error(`❌ Flow not found in scope: ${slug}`); process.exit(1); }
  const editor = process.env.EDITOR || "vi";
  execSync(`${editor} ${e._path}`, { stdio: "inherit" });
}

function cmdRm(slug: string, scope: Scope) {
  const entries = loadEntriesForScope(scope);
  const e = matchFlow(entries, slug);
  if (!e || !e._path) { console.error(`❌ Flow not found in scope: ${slug}`); process.exit(1); }
  const filePath = e._path;
  try {
    execSync(`which trash`, { stdio: "ignore" });
    execSync(`trash ${filePath}`, { stdio: "inherit" });
  } catch {
    execSync(`mv ${filePath} ~/.Trash/`, { stdio: "inherit" });
  }
  console.log(`🗑️  Trashed: ${slug}`);
}

// ─── Main ─────────────────────────────────────────────────────

const args = process.argv.slice(2);
if (!args.length || args[0] === "--help" || args[0] === "-h") { console.log(HELP); process.exit(0); }

const scope = parseScope(args);

// Strip scope flags from positional parsing
function firstPositional(): string | null {
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === "--agent" || a === "--scope") { i++; continue; }
    if (a.startsWith("--")) continue;
    return a;
  }
  return null;
}

function flagArg(flag: string): string | null {
  const idx = args.indexOf(flag);
  if (idx < 0) return null;
  return args[idx + 1] || null;
}

if (args.includes("--list")) cmdList(scope);
else if (args.includes("--inject")) {
  const slug = flagArg("--inject");
  if (!slug) { console.error("❌ --inject requires a slug"); process.exit(1); }
  cmdInject(slug, scope);
}
else if (args.includes("--search")) {
  const q = flagArg("--search");
  if (!q) { console.error("❌ --search requires a query"); process.exit(1); }
  cmdSearch(q, scope);
}
else if (args.includes("--add")) {
  const slug = flagArg("--add");
  if (!slug) { console.error("❌ --add requires a slug"); process.exit(1); }
  cmdAdd(slug, scope);
}
else if (args.includes("--edit")) {
  const slug = flagArg("--edit");
  if (!slug) { console.error("❌ --edit requires a slug"); process.exit(1); }
  cmdEdit(slug, scope);
}
else if (args.includes("--rm")) {
  const slug = flagArg("--rm");
  if (!slug) { console.error("❌ --rm requires a slug"); process.exit(1); }
  cmdRm(slug, scope);
}
else if (args[0] === "--agent" && args.length === 2) {
  // Legacy: `dna flow --agent <id>` with no other action → list
  cmdList(scope);
}
else {
  // Positional: show by slug
  const slug = firstPositional();
  if (!slug) { console.log(HELP); process.exit(0); }
  cmdShow(slug, scope);
}
