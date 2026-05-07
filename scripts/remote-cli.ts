#!/usr/bin/env tsx
/**
 * DNA Remote — manage remote Markdown URL registry.
 *
 * Remotes are named references to external Markdown files (e.g. official
 * OpenClaw workspace templates on GitHub raw). Once registered, they can be
 * injected into workspace files via the standard DNA directive syntax:
 *
 *   {{dna remote --inject <id>}}
 *   {{dna remote --inject <id>#<section>}}
 *
 * Registry file: ~/.openclaw/.dna/remotes.yaml (or DNA_DATA/remotes.yaml)
 * Cache dir:     ~/.openclaw/.dna/.remote-cache/
 *
 * Commands:
 *   dna remote add <id> <url>         Register a remote
 *   dna remote list                   List registered remotes
 *   dna remote fetch [<id>]           Re-fetch and update cache
 *   dna remote remove <id>            Unregister
 *   dna remote --inject <id>          Print full content (for {{dna remote}} directive)
 *   dna remote --inject <id>#<sec>    Print a single H2/H3 section by slug
 */
import {
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import yaml from "js-yaml";

// ─── Paths ───────────────────────────────────────────────────────────────────

const DNA_DATA = process.env.DNA_DATA ||
  (() => {
    const home = process.env.HOME || "";
    if (existsSync(join(home, ".dna"))) return join(home, ".dna");
    if (existsSync(join(home, ".openclaw", ".dna"))) return join(home, ".openclaw", ".dna");
    return join(home, ".agentic-dna");
  })();

const REGISTRY_PATH = join(DNA_DATA, "remotes.yaml");
const CACHE_DIR = join(DNA_DATA, ".remote-cache");

// ─── Types ───────────────────────────────────────────────────────────────────

interface RemoteEntry {
  id: string;
  url: string;
  description?: string;
  added_at: string;
}

interface Registry {
  remotes: RemoteEntry[];
}

// ─── Registry helpers ─────────────────────────────────────────────────────────

function loadRegistry(): Registry {
  if (!existsSync(REGISTRY_PATH)) return { remotes: [] };
  try {
    const parsed = yaml.load(readFileSync(REGISTRY_PATH, "utf-8")) as any;
    return { remotes: Array.isArray(parsed?.remotes) ? parsed.remotes : [] };
  } catch {
    return { remotes: [] };
  }
}

function saveRegistry(reg: Registry): void {
  mkdirSync(DNA_DATA, { recursive: true });
  writeFileSync(REGISTRY_PATH, yaml.dump(reg, { lineWidth: 120 }), "utf-8");
}

function findEntry(reg: Registry, id: string): RemoteEntry | undefined {
  return reg.remotes.find((r) => r.id === id);
}

// ─── Cache helpers ────────────────────────────────────────────────────────────

function cachePathFor(id: string): string {
  return join(CACHE_DIR, id.replace(/[^a-zA-Z0-9_-]/g, "_") + ".md");
}

async function fetchUrl(url: string): Promise<string> {
  const res = await fetch(url);
  if (!res.ok) throw new Error("HTTP " + res.status + " for " + url);
  return res.text();
}

async function ensureCached(entry: RemoteEntry, force = false): Promise<string> {
  mkdirSync(CACHE_DIR, { recursive: true });
  const cachePath = cachePathFor(entry.id);
  if (!force && existsSync(cachePath)) {
    return readFileSync(cachePath, "utf-8");
  }
  const content = await fetchUrl(entry.url);
  writeFileSync(cachePath, content, "utf-8");
  return content;
}

// ─── Section extraction ───────────────────────────────────────────────────────

function slugify(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9\u4e00-\u9fff]+/g, "-").replace(/^-+|-+$/g, "");
}

function extractSection(content: string, section: string): string | null {
  const lines = content.split(/\r?\n/);
  const targetSlug = slugify(section);
  let inside = false;
  let depth = 0;
  const out: string[] = [];

  for (const line of lines) {
    const hm = line.match(/^(#{1,6})\s+(.+)$/);
    if (hm) {
      const lvl = hm[1].length;
      const slug = slugify(hm[2]);
      if (!inside) {
        if (slug === targetSlug) {
          inside = true;
          depth = lvl;
          out.push(line);
        }
      } else {
        if (lvl <= depth) break;
        out.push(line);
      }
    } else if (inside) {
      out.push(line);
    }
  }

  return out.length ? out.join("\n").trimEnd() : null;
}

// ─── Commands ─────────────────────────────────────────────────────────────────

function cmdAdd(args: string[]): void {
  const [id, url, description] = args;
  if (!id || !url) {
    console.error("Usage: dna remote add <id> <url> [description]");
    process.exit(1);
  }
  if (!url.startsWith("http://") && !url.startsWith("https://")) {
    console.error("Error: url must start with http:// or https://");
    process.exit(1);
  }
  const reg = loadRegistry();
  const existing = findEntry(reg, id);
  if (existing) {
    existing.url = url;
    if (description) existing.description = description;
    saveRegistry(reg);
    console.log("Updated remote: " + id + " -> " + url);
  } else {
    reg.remotes.push({ id, url, description, added_at: new Date().toISOString() });
    saveRegistry(reg);
    console.log("Added remote: " + id + " -> " + url);
  }
}

function cmdList(): void {
  const reg = loadRegistry();
  if (!reg.remotes.length) {
    console.log("No remotes registered. Use: dna remote add <id> <url>");
    return;
  }
  console.log("Registered remotes:\n");
  for (const r of reg.remotes) {
    const cached = existsSync(cachePathFor(r.id)) ? " (cached)" : " (not fetched)";
    console.log("  " + r.id + cached);
    console.log("    " + r.url);
    if (r.description) console.log("    " + r.description);
    console.log("");
  }
}

async function cmdFetch(args: string[]): Promise<void> {
  const reg = loadRegistry();
  const targets = args[0] ? [args[0]] : reg.remotes.map((r) => r.id);
  if (!targets.length) {
    console.log("No remotes to fetch.");
    return;
  }
  for (const id of targets) {
    const entry = findEntry(reg, id);
    if (!entry) {
      console.error("Remote not found: " + id);
      continue;
    }
    process.stderr.write("Fetching " + id + " from " + entry.url + " ... ");
    try {
      await ensureCached(entry, true);
      process.stderr.write("done\n");
    } catch (e: any) {
      process.stderr.write("FAILED: " + e.message + "\n");
    }
  }
}

function cmdRemove(args: string[]): void {
  const [id] = args;
  if (!id) {
    console.error("Usage: dna remote remove <id>");
    process.exit(1);
  }
  const reg = loadRegistry();
  const before = reg.remotes.length;
  reg.remotes = reg.remotes.filter((r) => r.id !== id);
  if (reg.remotes.length === before) {
    console.error("Remote not found: " + id);
    process.exit(1);
  }
  saveRegistry(reg);
  console.log("Removed: " + id);
}

async function cmdInject(args: string[]): Promise<void> {
  const raw = args[0];
  if (!raw) {
    console.error("Usage: dna remote --inject <id>[#section]");
    process.exit(1);
  }
  const hashIdx = raw.indexOf("#");
  const id = hashIdx >= 0 ? raw.slice(0, hashIdx) : raw;
  const section = hashIdx >= 0 ? raw.slice(hashIdx + 1) : null;

  const reg = loadRegistry();
  const entry = findEntry(reg, id);
  if (!entry) {
    console.error("Remote not found: " + id + ". Register with: dna remote add " + id + " <url>");
    process.exit(1);
  }

  let content: string;
  try {
    content = await ensureCached(entry);
  } catch (e: any) {
    console.error("Failed to fetch " + id + ": " + e.message);
    process.exit(1);
  }

  if (section) {
    const extracted = extractSection(content, section);
    if (!extracted) {
      console.error("Section '" + section + "' not found in remote '" + id + "'");
      process.exit(1);
    }
    process.stdout.write(extracted + "\n");
  } else {
    process.stdout.write(content + "\n");
  }
}

function printHelp(): void {
  console.log(`DNA Remote — manage remote Markdown URL registry

Usage:
  dna remote add <id> <url> [desc]   Register a remote Markdown URL
  dna remote list                    List registered remotes
  dna remote fetch [<id>]            Re-fetch and update cache (all if no id)
  dna remote remove <id>             Unregister a remote
  dna remote --inject <id>           Print full content (used in directives)
  dna remote --inject <id>#<section> Print a single section by heading slug

Directive usage in workspace files:
  {{dna remote --inject openclaw-agents}}
  {{dna remote --inject openclaw-agents#safety}}

Registry: ${REGISTRY_PATH}
Cache:     ${CACHE_DIR}/

Example — register OpenClaw official workspace templates:
  dna remote add openclaw-agents https://raw.githubusercontent.com/openclaw/openclaw/main/docs/reference/templates/AGENTS.md
  dna remote add openclaw-soul   https://raw.githubusercontent.com/openclaw/openclaw/main/docs/reference/templates/SOUL.md
`);
}

// ─── Main ─────────────────────────────────────────────────────────────────────

const isMain = (() => {
  const base = (process.argv[1] || "").split("/").pop() || "";
  return base === "remote-cli.ts" || base === "remote-cli.js";
})();

if (isMain) {
  const [subcmd, ...rest] = process.argv.slice(2);
  (async () => {
    switch (subcmd) {
      case "add":    cmdAdd(rest); break;
      case "list":   cmdList(); break;
      case "fetch":  await cmdFetch(rest); break;
      case "remove":
      case "rm":     cmdRemove(rest); break;
      case "--inject": await cmdInject(rest); break;
      case "help":
      case "--help":
      case "-h":
      case undefined: printHelp(); break;
      default:
        console.error("Unknown subcommand: " + subcmd);
        printHelp();
        process.exit(1);
    }
  })().catch((e) => {
    console.error("Error:", e?.message || e);
    process.exit(1);
  });
}
