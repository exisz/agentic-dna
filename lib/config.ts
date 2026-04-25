/**
 * DNA configuration loader.
 *
 * Loads `dna.config.yaml` with precedence:
 *   1. `./dna.config.yaml` (project-level, when cwd is provided)
 *   2. `~/.openclaw/.dna/dna.config.yaml` (global)
 *   3. Built-in MINIMAL defaults (just enough for DNA to work)
 *
 * Unknown types get auto-generated colors (deterministic hash) and a
 * generic icon, so a fresh `dna init` keeps working with no config.
 */
import { readFileSync, existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { homedir } from "node:os";
import yaml from "js-yaml";

export interface TypeDef {
  icon: string;
  color: string;
  label: string;
  label_zh?: string;
  category?: string;
}

export interface PresetDef {
  label: string;
  label_zh?: string;
  icon?: string;
  categories: string[];          // empty = no filter
  layout?: string;               // optional layout hint (e.g. "cluster", "empire")
  hide_fields?: string[];        // fields hidden in node detail
  types?: string[];              // explicit type allow-list (overrides categories)
}

export interface VerbDef {
  label: string;
  label_zh?: string;
  reverse?: string;
}

export interface IntegrationDef {
  base_url: string;
  field?: string;
  [key: string]: any;
}

export interface DnaConfig {
  types: Record<string, TypeDef>;
  presets: Record<string, PresetDef>;
  verbs: Record<string, VerbDef>;
  integrations: Record<string, IntegrationDef>;
}

// ─── Built-in MINIMAL defaults ────────────────────────────────────────
// Just enough to make DNA boot. Anything richer comes from user config.
const BUILTIN_DEFAULTS: DnaConfig = {
  types: {
    // No hardcoded types — every type string gets auto-colored on demand.
  },
  presets: {
    all: {
      label: "All",
      label_zh: "全部",
      icon: "🌐",
      categories: [],
    },
  },
  verbs: {
    managed_by: { label: "Managed By", label_zh: "管理者", reverse: "manages" },
    link:       { label: "Link",       label_zh: "链接" },
  },
  integrations: {},
};

// ─── Deterministic auto-color for unknown types ──────────────────────
const FALLBACK_PALETTE = [
  "#06b6d4", "#8b5cf6", "#f59e0b", "#a78bfa", "#fb7185",
  "#34d399", "#fbbf24", "#60a5fa", "#94a3b8", "#4ade80",
  "#c084fc", "#ef4444", "#2dd4bf", "#f97316", "#22d3ee",
  "#e879f9", "#fb923c", "#a3e635", "#f472b6", "#5eead4",
];

function hashStr(s: string): number {
  let h = 0;
  for (let i = 0; i < s.length; i++) {
    h = ((h << 5) - h + s.charCodeAt(i)) | 0;
  }
  return Math.abs(h);
}

export function autoTypeDef(t: string): TypeDef {
  return {
    icon: "🔹",
    color: FALLBACK_PALETTE[hashStr(t) % FALLBACK_PALETTE.length],
    label: t.charAt(0).toUpperCase() + t.slice(1),
    category: "other",
  };
}

/** Lookup a type definition; auto-generates one if not in config. */
export function getTypeDef(cfg: DnaConfig, t: string): TypeDef {
  return cfg.types[t] || autoTypeDef(t);
}

export function colorForType(cfg: DnaConfig, t: string): string {
  return getTypeDef(cfg, t).color;
}

export function iconForType(cfg: DnaConfig, t: string): string {
  return getTypeDef(cfg, t).icon;
}

// ─── Deep-merge (objects only; arrays replace) ───────────────────────
function isPlainObj(v: any): v is Record<string, any> {
  return v && typeof v === "object" && !Array.isArray(v);
}
function deepMerge<T>(base: T, over: any): T {
  if (!isPlainObj(over)) return over === undefined ? base : (over as T);
  if (!isPlainObj(base)) return over as T;
  const out: Record<string, any> = { ...base };
  for (const k of Object.keys(over)) {
    out[k] = isPlainObj(over[k]) && isPlainObj((base as any)[k])
      ? deepMerge((base as any)[k], over[k])
      : over[k];
  }
  return out as T;
}

function loadYamlSafe(path: string): any {
  try {
    if (!existsSync(path)) return null;
    return yaml.load(readFileSync(path, "utf-8")) || null;
  } catch {
    return null;
  }
}

const HOME = process.env.HOME || homedir();
export const GLOBAL_CONFIG_PATH = process.env.DNA_CONFIG ||
  join(HOME, ".openclaw", ".dna", "dna.config.yaml");
export const LOCAL_CONFIG_FILENAME = "dna.config.yaml";

let cached: DnaConfig | null = null;
let cachedKey: string | null = null;

/**
 * Load merged config (built-in defaults ⊕ global ⊕ local).
 * Cached per `cwd`. Pass `force=true` to bypass cache.
 */
export function loadConfig(cwd?: string, force = false): DnaConfig {
  const key = cwd || "<global>";
  if (!force && cached && cachedKey === key) return cached;

  let merged: DnaConfig = JSON.parse(JSON.stringify(BUILTIN_DEFAULTS));

  // 2. Global
  const global = loadYamlSafe(GLOBAL_CONFIG_PATH);
  if (global) merged = deepMerge(merged, global);

  // 1. Local (project-level) — overrides global
  if (cwd) {
    const localPath = resolve(cwd, LOCAL_CONFIG_FILENAME);
    if (localPath !== GLOBAL_CONFIG_PATH) {
      const local = loadYamlSafe(localPath);
      if (local) merged = deepMerge(merged, local);
    }
  }

  cached = merged;
  cachedKey = key;
  return merged;
}

/** Reset internal cache. Mostly for tests. */
export function resetConfigCache(): void {
  cached = null;
  cachedKey = null;
}

/** Resolve a preset's effective allowed type set (null = no filter). */
export function presetAllowedTypes(cfg: DnaConfig, presetId: string): Set<string> | null {
  const preset = cfg.presets[presetId];
  if (!preset) return null;
  // Explicit types wins
  if (preset.types && preset.types.length > 0) return new Set(preset.types);
  if (!preset.categories || preset.categories.length === 0) return null;
  const allowed = new Set<string>();
  for (const [typeName, def] of Object.entries(cfg.types)) {
    if (def.category && preset.categories.includes(def.category)) {
      allowed.add(typeName);
    }
  }
  return allowed;
}
