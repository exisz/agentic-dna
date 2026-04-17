#!/usr/bin/env node
/**
 * DNA Convention CLI — Query global and local conventions uniformly.
 *
 * Scope resolution:
 *   - `--agent <id>` targets that agent's workspace (explicit).
 *   - Otherwise, if CWD is inside a workspace, local conventions are included.
 *   - Otherwise, only global conventions.
 *
 * Local conventions live at `<workspace>/.dna/conventions/*.md` — same
 * markdown+frontmatter format as global. Legacy `dna.yaml → conventions:`
 * yaml entries are still read (with a deprecation notice).
 *
 * Usage:
 *   dna convention --list [--agent <id>] [--scope global|local|all]
 *   dna convention <slug> [--agent <id>]                 # full text
 *   dna convention --inject <slug> [--agent <id>]        # injectable
 *   dna convention --search <query> [--agent <id>]
 *   dna convention --add <slug> [--agent <id>]           # local if in workspace
 *   dna convention --edit <slug> [--agent <id>]
 *   dna convention --rm <slug> [--agent <id>]
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

const GLOBAL_DIR = join(DNA_DATA, "conventions");

const HELP = `📏 DNA Convention CLI

Scope: every command respects --agent <id>, or auto-detects the workspace
from CWD. Without either, only global conventions are in scope.

Usage:
  dna convention --list                          List conventions in scope
  dna convention --list --scope global           Global only
  dna convention --list --scope local            Local only
  dna convention --list --scope all              Both (default when in workspace)
  dna convention <slug>                          Full markdown body
  dna convention --inject <slug>                 Injectable format
  dna convention --search <query>                Search by keyword
  dna convention --agent <id>                    Force workspace target
  dna convention --add <slug>                    Create (local if in workspace)
  dna convention --edit <slug>                   Edit in \$EDITOR
  dna convention --rm <slug>                     Trash

Local conventions: <workspace>/.dna/conventions/*.md  (same format as global).`;

// ─── Scope resolution ────────────────────────────────────────

interface Scope {
  global: boolean;
  local: boolean;
  workspace: string | null;
  agentId: string | null;
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
  const dir = join(workspace, ".dna/conventions");
  const entries = loadEntries(dir);
  return entries.map((e) => ({ ...e, _scope: "local", _workspace: workspace }));
}

function loadLocalLegacyYaml(workspace: string): Array<Record<string, any>> {
  const dnaPath = join(workspace, "dna.yaml");
  if (!existsSync(dnaPath)) return [];
  const data = loadYaml(dnaPath);
  if (!data || typeof data !== "object") return [];
  const root = (() => {
    const firstKey = Object.keys(data)[0];
    if (firstKey && typeof data[firstKey] === "object" && !Array.isArray(data[firstKey]) &&
        !["goal", "boundary", "tools", "philosophy", "deprecated", "spec", "conventions"].includes(firstKey)) {
      return data[firstKey];
    }
    return data;
  })();
  const conventions: Array<Record<string, any>> = root?.conventions || [];
  if (!conventions.length) return [];
  // Warn once
  console.error(`⚠️  ${workspace}/dna.yaml has legacy yaml conventions — migrate to <workspace>/.dna/conventions/*.md`);
  return conventions.map((c: any) => ({
    id: c.id,
    title: c.title || c.id,
    "derives-from": c["derives-from"] || "",
    summary: (c.rule || "").toString().replace(/\s+/g, " ").trim(),
    _body: (c.rule || "").toString().trim(),
    _scope: "local-legacy",
    _workspace: workspace,
  }));
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
    for (const e of loadEntries(GLOBAL_DIR)) {
      if (!seen.has((e.id as string).toLowerCase())) {
        merged.push({ ...e, _scope: "global" });
        seen.add((e.id as string).toLowerCase());
      }
    }
  }
  return merged;
}

// ─── Commands ────────────────────────────────────────────────

function cmdList(scope: Scope) {
  const entries = loadEntriesForScope(scope);
  if (!entries.length) { console.log("No conventions in scope."); return; }
  const scopeLabel =
    scope.global && scope.local ? "Global + Local" :
    scope.local ? `Local${scope.workspace ? ` (${scope.workspace})` : ""}` :
    "Global";
  console.log(`📏 Conventions — ${scopeLabel} — ${entries.length} entries\n`);
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
  const e = entries.find(e => (e.id as string).toLowerCase() === slug.toLowerCase());
  if (!e) { console.error(`❌ Convention not found in scope: ${slug}`); process.exit(1); }
  console.log(e._body);
}

function cmdInject(slug: string, scope: Scope) {
  const entries = loadEntriesForScope(scope);
  const e = entries.find(e => (e.id as string).toLowerCase() === slug.toLowerCase());
  if (!e) { console.error(`❌ Convention not found in scope: ${slug}`); process.exit(1); }

  const scopeSuffix = e._scope && e._scope !== "global" ? ` (${e._scope})` : "";
  const derives = e["derives-from"] ? ` (← ${e["derives-from"]})` : "";

  if (e.summary) {
    console.log(`<!-- CONVENTION:${e.id}${scopeSuffix} -->\n**📏 ${e.id}** *(summary)*: ${e.summary}${derives}\n\n> 📖 *Full text*: \`dna convention ${e.id}\`\n<!-- /CONVENTION:${e.id} -->`);
    return;
  }
  let output = `<!-- CONVENTION:${e.id}${scopeSuffix} -->\n## 📏 ${e.id}: ${e.title}\n\n${e._body}\n<!-- /CONVENTION:${e.id} -->`;
  if (output.length > INJECT_CHAR_LIMIT) {
    let truncated = output.slice(0, INJECT_CHAR_LIMIT);
    const lastNl = truncated.lastIndexOf("\n");
    if (lastNl > INJECT_CHAR_LIMIT / 2) truncated = truncated.slice(0, lastNl);
    output = truncated + `\n\n⚠️ TRUNCATED — run \`dna convention ${e.id}\` for full text.\n<!-- /CONVENTION:${e.id} -->`;
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
  if (!results.length) { console.log(`No conventions matching '${query}'`); return; }
  console.log(`🔍 ${results.length} conventions matching '${query}':\n`);
  for (const e of results) console.log(`  ${e.id} [${e._scope || "global"}]: ${e.title}`);
}

function slugToTitle(slug: string): string {
  return slug.split("-").map(w => w.charAt(0).toUpperCase() + w.slice(1)).join(" ");
}

function targetDir(scope: Scope): { dir: string; scopeLabel: string } {
  if (scope.local && scope.workspace) {
    return { dir: join(scope.workspace, ".dna/conventions"), scopeLabel: "local" };
  }
  return { dir: GLOBAL_DIR, scopeLabel: "global" };
}

function cmdAdd(slug: string, scope: Scope) {
  const { dir, scopeLabel } = targetDir(scope);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  const filePath = join(dir, `${slug}.md`);
  if (existsSync(filePath)) { console.error(`❌ Convention already exists: ${slug}`); process.exit(1); }
  const template = `---\nid: ${slug}\ntitle: "${slugToTitle(slug)}"\nderives-from: ""\ntags: []\nsummary: ""\n---\n\n# ${slug}\n\n## Rule\n\n(describe the rule here)\n`;
  writeFileSync(filePath, template, "utf-8");
  const editor = process.env.EDITOR || "vi";
  execSync(`${editor} ${filePath}`, { stdio: "inherit" });
  console.log(`✅ Created (${scopeLabel}): ${filePath}`);
}

function cmdEdit(slug: string, scope: Scope) {
  const entries = loadEntriesForScope(scope);
  const e = entries.find(e => (e.id as string).toLowerCase() === slug.toLowerCase());
  if (!e || !e._path) { console.error(`❌ Convention not found in scope: ${slug}`); process.exit(1); }
  const editor = process.env.EDITOR || "vi";
  execSync(`${editor} ${e._path}`, { stdio: "inherit" });
}

function cmdRm(slug: string, scope: Scope) {
  const entries = loadEntriesForScope(scope);
  const e = entries.find(e => (e.id as string).toLowerCase() === slug.toLowerCase());
  if (!e || !e._path) { console.error(`❌ Convention not found in scope: ${slug}`); process.exit(1); }
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
  // Legacy: `dna convention --agent <id>` with no other action → list
  cmdList(scope);
}
else {
  // Positional: show by slug
  const slug = firstPositional();
  if (!slug) { console.log(HELP); process.exit(0); }
  cmdShow(slug, scope);
}
