// Config-driven type/preset/verb/integration metadata.
// Hydrated once at boot from `GET /api/config`.

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
  categories: string[];
  layout?: string;
  hide_fields?: string[];
  types?: string[];
}
export interface VerbDef {
  label: string;
  label_zh?: string;
  reverse?: string;
}
export interface IntegrationDef {
  base_url: string;
  field?: string;
  [k: string]: any;
}
export interface DnaConfig {
  types: Record<string, TypeDef>;
  presets: Record<string, PresetDef>;
  verbs: Record<string, VerbDef>;
  integrations: Record<string, IntegrationDef>;
}

// ─── Built-in fallback (matches lib/config.ts BUILTIN_DEFAULTS) ──────
const FALLBACK_CONFIG: DnaConfig = {
  types: {},
  presets: { all: { label: "All", label_zh: "全部", icon: "🌐", categories: [] } },
  verbs: { managed_by: { label: "Managed By", reverse: "manages" }, link: { label: "Link" } },
  integrations: {},
};

const FALLBACK_PALETTE = [
  "#06b6d4", "#8b5cf6", "#f59e0b", "#a78bfa", "#fb7185",
  "#34d399", "#fbbf24", "#60a5fa", "#94a3b8", "#4ade80",
  "#c084fc", "#ef4444", "#2dd4bf", "#f97316", "#22d3ee",
  "#e879f9", "#fb923c", "#a3e635", "#f472b6", "#5eead4",
];

function hashStr(s: string): number {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = ((h << 5) - h + s.charCodeAt(i)) | 0;
  return Math.abs(h);
}

export function autoTypeDef(t: string): TypeDef {
  return {
    icon: "🔹",
    color: FALLBACK_PALETTE[hashStr(t) % FALLBACK_PALETTE.length],
    label: t ? t.charAt(0).toUpperCase() + t.slice(1) : "(unknown)",
    category: "other",
  };
}

// ─── Module-level config singleton ─────────────────────────────────
let CONFIG: DnaConfig = FALLBACK_CONFIG;

export function setConfig(cfg: DnaConfig | null | undefined): void {
  if (!cfg) return;
  CONFIG = {
    types: cfg.types || {},
    presets: cfg.presets && Object.keys(cfg.presets).length ? cfg.presets : FALLBACK_CONFIG.presets,
    verbs: cfg.verbs || {},
    integrations: cfg.integrations || {},
  };
}

export function getConfig(): DnaConfig {
  return CONFIG;
}

export function getTypeDef(t: string): TypeDef {
  return CONFIG.types[t] || autoTypeDef(t);
}

export function colorForType(t: string): string {
  return getTypeDef(t).color;
}

export function iconForType(t: string): string {
  return getTypeDef(t).icon;
}

export function labelForType(t: string, lang: "en" | "zh" = "en"): string {
  const d = getTypeDef(t);
  return (lang === "zh" && d.label_zh) || d.label;
}

/** Resolve preset's allowed type set (null = no filter). */
export function presetAllowedTypes(presetId: string): Set<string> | null {
  const preset = CONFIG.presets[presetId];
  if (!preset) return null;
  if (preset.types && preset.types.length > 0) return new Set(preset.types);
  if (!preset.categories || preset.categories.length === 0) return null;
  const allowed = new Set<string>();
  for (const [name, def] of Object.entries(CONFIG.types)) {
    if (def.category && preset.categories.includes(def.category)) allowed.add(name);
  }
  return allowed;
}

/** Hidden fields for a preset (for NodeDetail) — empty set if none. */
export function presetHiddenFields(presetId: string): Set<string> {
  const preset = CONFIG.presets[presetId];
  return new Set(preset?.hide_fields || []);
}

export function getPresetIds(): string[] {
  return Object.keys(CONFIG.presets);
}

export function getPreset(id: string): PresetDef | undefined {
  return CONFIG.presets[id];
}

// ─── Backwards-compat constants (computed from current config) ─────
// Components that already read these as values need a stable interface.
// They're now derived getters.

/** @deprecated use presetAllowedTypes(id) */
export function PRESET_TYPES_FOR(id: string): string[] {
  const s = presetAllowedTypes(id);
  return s ? Array.from(s) : [];
}

// ─── Domain types (unchanged from previous version) ───────────────
export interface NodeSummary {
  id: string;
  type: string;
  title?: string;
  outboundCount: number;
  status?: string;
  managedBy?: string;
}
export interface Edge { source: string; target: string; verb?: string; }

export interface NodeDetail {
  id: string;
  type: string;
  title?: string;
  path: string;
  outbound: string[];
  inbound: { id: string; type: string; title?: string }[];
  fields: Record<string, any>;
  body: string;
}

export interface Stats {
  generated_at: string;
  total_nodes: number;
  total_edges: number;
  dead_links: number;
  by_type: Record<string, number>;
}

// Preset id is a free string now (driven by config). Kept the type
// alias for component prop compatibility.
export type Preset = string;

// ─── Preset option helper (for the toolbar in App.tsx) ─────────────
export interface PresetOption {
  id: string;
  icon: string;
  label: string;
  label_zh?: string;
}
export function getPresetOptions(): PresetOption[] {
  return Object.entries(CONFIG.presets).map(([id, p]) => ({
    id,
    icon: p.icon || "🔹",
    label: p.label,
    label_zh: p.label_zh,
  }));
}

// ─── Integration link builder (e.g. Jira ticket URL) ───────────────
export function integrationUrl(name: string, value: string): string | null {
  const def = CONFIG.integrations[name];
  if (!def || !def.base_url) return null;
  const sep = def.base_url.endsWith("/") ? "" : "/";
  return `${def.base_url}${sep}${value}`;
}

// Async config bootstrap helper used by App.tsx.
export async function fetchConfig(): Promise<void> {
  try {
    const res = await fetch("/api/config");
    if (!res.ok) return;
    const j = await res.json();
    setConfig(j);
  } catch {
    /* fallback already in place */
  }
}
