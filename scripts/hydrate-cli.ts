#!/usr/bin/env node --experimental-strip-types
/**
 * DNA Hydrate CLI — Pre-render {{dna ...}} directives in workspace files.
 *
 * Expands all {{dna ...}} directives and outputs the result.
 * Uses the same expand module as the openclaw-dna extension.
 *
 * Usage:
 *   dna hydrate AGENTS.md                      # Hydrate single file → .dna/AGENTS.hydrated.md
 *   dna hydrate AGENTS.md --stdio              # Hydrate single file → stdout
 *   dna hydrate --workspace /path/to/ws        # Hydrate all .md files with directives
 *   dna hydrate --agent my-agent                # Hydrate workspace by agent ID
 *   dna hydrate --all                          # Hydrate all workspaces
 *   dna hydrate --all --dry-run                # Show which files would be hydrated
 */
import * as fs from "node:fs";
import * as path from "node:path";
import {
  expandDnaDirectives,
  hasDirectives,
  countDirectives,
  clearCache,
  type Logger,
} from "../lib/expand.ts";

const logger: Logger = {
  warn: (msg: string) => console.error(`⚠️  ${msg}`),
  info: (msg: string) => console.error(`ℹ️  ${msg}`),
};

// ─── Helpers ────────────────────────────────────────────────

function resolveAgentWorkspace(agentId: string): string | null {
  const cfgPath = path.join(process.env.HOME!, ".openclaw", "openclaw.json");
  if (!fs.existsSync(cfgPath)) return null;
  const cfg = JSON.parse(fs.readFileSync(cfgPath, "utf-8"));
  for (const agent of cfg?.agents?.list ?? []) {
    if (agent.id === agentId) return agent.workspace ?? null;
  }
  return null;
}

function getAllWorkspaces(): Array<{ id: string; workspace: string }> {
  const cfgPath = path.join(process.env.HOME!, ".openclaw", "openclaw.json");
  if (!fs.existsSync(cfgPath)) return [];
  const cfg = JSON.parse(fs.readFileSync(cfgPath, "utf-8"));
  return (cfg?.agents?.list ?? [])
    .filter((a: any) => a.id && a.workspace && fs.existsSync(a.workspace))
    .map((a: any) => ({ id: a.id, workspace: a.workspace }));
}

function findDirectiveFiles(workspace: string): string[] {
  const files: string[] = [];
  try {
    for (const entry of fs.readdirSync(workspace)) {
      if (!entry.endsWith(".md")) continue;
      const fullPath = path.join(workspace, entry);
      const stat = fs.statSync(fullPath);
      if (!stat.isFile()) continue;
      try {
        const content = fs.readFileSync(fullPath, "utf-8");
        if (hasDirectives(content)) files.push(fullPath);
      } catch {}
    }
  } catch {}
  return files.sort();
}

// ─── Actions ────────────────────────────────────────────────

function hydrateFile(filepath: string, toStdio: boolean): boolean {
  const content = fs.readFileSync(filepath, "utf-8");
  if (!hasDirectives(content)) {
    if (toStdio) process.stdout.write(content);
    return false;
  }

  clearCache();
  const expanded = expandDnaDirectives(content, logger);

  if (toStdio) {
    process.stdout.write(expanded);
  } else {
    const dir = path.dirname(filepath);
    const base = path.basename(filepath);
    const name = path.basename(base, path.extname(base));
    const dnaDir = path.join(dir, ".dna");
    fs.mkdirSync(dnaDir, { recursive: true });
    const outPath = path.join(dnaDir, `${name}.hydrated.md`);

    const header = `<!-- 🧬 HYDRATED from ${base} — regenerate with: dna hydrate ${base} -->\n\n`;
    fs.writeFileSync(outPath, header + expanded);

    const count = countDirectives(content);
    console.log(`  ✅ ${base} → .dna/${name}.hydrated.md (${count} directive${count !== 1 ? "s" : ""})`);
  }
  return true;
}

function hydrateWorkspace(workspace: string, label: string, dryRun: boolean): void {
  const files = findDirectiveFiles(workspace);
  if (!files.length) {
    if (label) console.log(`  ${label}: no directives found`);
    return;
  }

  if (label) console.log(`📂 ${label} (${workspace})`);

  for (const f of files) {
    if (dryRun) {
      const base = path.basename(f);
      const content = fs.readFileSync(f, "utf-8");
      const count = countDirectives(content);
      console.log(`  📝 ${base} (${count} directives)`);
    } else {
      hydrateFile(f, false);
    }
  }
}

// ─── Main ───────────────────────────────────────────────────

function main(): void {
  const rawArgs = process.argv.slice(2);

  if (!rawArgs.length || rawArgs.includes("--help") || rawArgs.includes("-h")) {
    console.log(`DNA Hydrate — Pre-render {{dna ...}} directives in workspace files.

Usage:
  dna hydrate AGENTS.md                # → .dna/AGENTS.hydrated.md
  dna hydrate AGENTS.md --stdio        # → stdout
  dna hydrate --agent my-agent            # Hydrate agent workspace
  dna hydrate --workspace /path        # Hydrate workspace
  dna hydrate --all                    # Hydrate all workspaces
  dna hydrate --all --dry-run          # Preview only`);
    return;
  }

  const dryRun = rawArgs.includes("--dry-run");
  const toStdio = rawArgs.includes("--stdio");
  const args = rawArgs.filter((a) => !["--dry-run", "--stdio"].includes(a));

  // --all
  if (args.includes("--all")) {
    const workspaces = getAllWorkspaces();
    if (!workspaces.length) {
      console.log("No workspaces found in openclaw.json");
      return;
    }
    console.log(`🧬 Hydrating ${workspaces.length} workspaces...\n`);
    let total = 0;
    for (const { id, workspace } of workspaces) {
      const files = findDirectiveFiles(workspace);
      if (files.length) {
        total += files.length;
        hydrateWorkspace(workspace, id, dryRun);
      }
    }
    console.log(`\n${dryRun ? "Would hydrate" : "Hydrated"}: ${total} files`);
    return;
  }

  // --agent <id>
  const agentIdx = args.indexOf("--agent");
  if (agentIdx !== -1) {
    const agentId = args[agentIdx + 1];
    if (!agentId) {
      console.error("Error: --agent requires an agent ID");
      process.exit(1);
    }
    const ws = resolveAgentWorkspace(agentId);
    if (!ws) {
      console.error(`Error: workspace not found for agent '${agentId}'`);
      process.exit(1);
    }
    hydrateWorkspace(ws, agentId, dryRun);
    return;
  }

  // --workspace <path>
  const wsIdx = args.indexOf("--workspace");
  if (wsIdx !== -1) {
    const wsPath = args[wsIdx + 1];
    if (!wsPath) {
      console.error("Error: --workspace requires a path");
      process.exit(1);
    }
    const resolved = path.resolve(wsPath);
    if (!fs.existsSync(resolved) || !fs.statSync(resolved).isDirectory()) {
      console.error(`Error: not a directory: ${wsPath}`);
      process.exit(1);
    }
    hydrateWorkspace(resolved, path.basename(resolved), dryRun);
    return;
  }

  // Single file
  let filepath = args[0];
  if (!filepath) {
    console.error("Error: provide a file path, --agent, --workspace, or --all");
    process.exit(1);
  }
  if (!fs.existsSync(filepath)) {
    filepath = path.resolve(process.cwd(), filepath);
  }
  if (!fs.existsSync(filepath)) {
    console.error(`Error: file not found: ${args[0]}`);
    process.exit(1);
  }
  hydrateFile(filepath, toStdio);
}

main();
