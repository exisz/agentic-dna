/**
 * DNA CLI shared utilities.
 */
import { readFileSync, existsSync, readdirSync, statSync } from "node:fs";
import { join, normalize, resolve, isAbsolute } from "node:path";
import yaml from "js-yaml";

export const HOME = process.env.HOME!;
export const DNA_DATA = process.env.DNA_DATA || join(HOME, ".openclaw/.dna");

export const WORKSPACE_ROOTS = [
  join(HOME, ".openclaw/workspaces"),
  join(HOME, ".openclaw/workspaces-hq"),
  join(HOME, ".openclaw/workspaces-personal"),
];

// Optional agent registry for workspace resolution (set DNA_AGENT_REGISTRY env or defaults to empty)
export const AGENT_REGISTRY = process.env.DNA_AGENT_REGISTRY || "";
export const INJECT_CHAR_LIMIT = 2000;

/**
 * Parse YAML-ish frontmatter from markdown using js-yaml.
 */
export function parseFrontmatter(content: string): { meta: Record<string, any>; body: string } {
  if (!content.startsWith("---")) return { meta: {}, body: content };
  const end = content.indexOf("---", 3);
  if (end === -1) return { meta: {}, body: content };
  const fmText = content.slice(3, end).trim();
  let meta: Record<string, any> = {};
  try {
    meta = (yaml.load(fmText) as Record<string, any>) || {};
  } catch {
    meta = {};
  }
  return { meta, body: content.slice(end + 3).trim() };
}

/**
 * Load all .md entries from a directory, parsing frontmatter.
 */
export function loadEntries(dir: string): Array<Record<string, any>> {
  if (!existsSync(dir)) return [];
  const entries: Array<Record<string, any>> = [];
  for (const file of readdirSync(dir).sort()) {
    if (!file.endsWith(".md") || file === "index.md") continue;
    // Skip directories (e.g. case-studies/)
    const fullPath = join(dir, file);
    if (statSync(fullPath).isDirectory()) continue;
    const content = readFileSync(fullPath, "utf-8");
    const { meta, body } = parseFrontmatter(content);
    if (!meta.id) continue;
    entries.push({ ...meta, _body: body, _path: fullPath, _filename: file });
  }
  return entries;
}

/**
 * Resolve agent workspace from OpenClaw config.
 */
export function resolveAgentWorkspace(agentId: string): string | null {
  const cfgPath = join(HOME, ".openclaw/openclaw.json");
  if (!existsSync(cfgPath)) return null;
  const cfg = JSON.parse(readFileSync(cfgPath, "utf-8"));
  for (const agent of cfg?.agents?.list || []) {
    if (agent.id === agentId) return agent.workspace || null;
  }
  if (agentId === "main") return cfg?.agents?.workspace || null;
  return null;
}

/**
 * Walk up from CWD to find an OpenClaw workspace root (a directory
 * directly under one of WORKSPACE_ROOTS, or any directory containing
 * a `dna.yaml` file). Returns the absolute path or null.
 */
export function workspaceFromCwd(startDir?: string): string | null {
  let dir = resolve(startDir || process.cwd());
  const root = "/";
  while (dir && dir !== root) {
    // Direct child of a known WORKSPACE_ROOTS entry
    for (const wsRoot of WORKSPACE_ROOTS) {
      try {
        const rel = dir.startsWith(wsRoot + "/") ? dir.slice(wsRoot.length + 1) : null;
        if (rel && !rel.includes("/")) return dir;
      } catch {}
    }
    // Fallback: any dir with dna.yml / dna.yaml is a workspace
    if (existsSync(join(dir, "dna.yml")) || existsSync(join(dir, "dna.yaml"))) return dir;
    const parent = resolve(dir, "..");
    if (parent === dir) break;
    dir = parent;
  }
  return null;
}

/**
 * Load and parse a YAML file. Returns null if file doesn't exist.
 */
export function loadYaml(path: string): any {
  if (!existsSync(path)) return null;
  return yaml.load(readFileSync(path, "utf-8"));
}

export { existsSync, readFileSync, statSync, join, normalize, resolve, isAbsolute };
