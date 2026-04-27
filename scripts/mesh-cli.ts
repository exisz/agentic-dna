#!/usr/bin/env tsx
/**
 * dna mesh - graph-based mesh CLI for the DNA system.
 *
 * Scans dna.yml / dna.yaml / *.dna / *.dna.md / *.dna.yml files across known roots,
 * builds in-memory graph (no DB), provides query subcommands.
 *
 * Subcommands:
 *   dna mesh scan                  Refresh cache, print stats
 *   dna mesh ls [--type X]         List nodes
 *   dna mesh show <id>             Show one node + edges
 *   dna mesh links <id>            Outbound edges
 *   dna mesh refs <id>             Inbound edges
 *   dna mesh impact <id>           Recursive inbound walk
 *   dna mesh lint                  Surface dead links + near-miss filenames
 */
import { readFileSync, existsSync, readdirSync, statSync, writeFileSync, mkdirSync } from "node:fs";
import { execSync } from "node:child_process";
import { createHash } from "node:crypto";
import { join, basename, dirname, relative } from "node:path";
import yaml from "js-yaml";
import { HOME, DNA_DATA, parseFrontmatter } from "../lib/common.js";
import { loadConfig, getTypeDef } from "../lib/config.js";

// --- Config ---

const SCAN_ROOTS = [
  join(HOME, ".openclaw/workspace"),       // main session (claw)
  join(HOME, ".openclaw/workspaces"),      // all governors
  join(HOME, ".openclaw/realms"),          // shared realms
  join(HOME, ".openclaw/.dna"),            // entire DNA dir: nodes + governance (content-driven)
  join(HOME, ".dna"),                      // optional alt data root
];

const REMOTE_CACHE_DIR = join(DNA_DATA, ".remote-cache");
const REMOTE_CACHE_TTL_DEFAULT_H = 24;

// --- Remote URI parser & fetcher ---

interface RemoteUri {
  provider: string;   // "github.com"
  owner: string;
  repo: string;
  path: string;       // sub-path (empty = repo root)
  raw: string;        // original dna:// URI
}

/**
 * Parse a remote URI: dna://github.com/<owner>/<repo>[/<path>]
 * Returns null if not a remote URI (local dna:// passes through to existing logic).
 */
function parseRemoteUri(id: string): RemoteUri | null {
  const m = id.match(/^dna:\/\/(github\.com|gitlab\.com|bitbucket\.org)\/([^/]+)\/([^/]+)(?:\/(.*))?$/);
  if (!m) return null;
  return {
    provider: m[1],
    owner: m[2],
    repo: m[3],
    path: m[4] || "",
    raw: id,
  };
}

/** Return the cache file path for a remote URI. */
function remoteCachePath(r: RemoteUri): string {
  const suffix = r.path ? `${r.path.replace(/[\/]/g, "__")}.yml` : "dna.yml";
  return join(REMOTE_CACHE_DIR, r.provider, r.owner, `${r.repo}__${suffix}`);
}

/**
 * Fetch a remote dna.yml from GitHub.
 * Uses built-in fetch (Node 18+). Checks cache with TTL.
 */
async function fetchRemoteDna(
  uri: RemoteUri,
  opts: { ttlHours?: number; forceRefresh?: boolean } = {}
): Promise<MeshNode> {
  if (uri.provider !== "github.com") {
    throw new Error(`Provider "${uri.provider}" not yet supported (only github.com is implemented)`);
  }

  const ttlMs = (opts.ttlHours ?? REMOTE_CACHE_TTL_DEFAULT_H) * 60 * 60 * 1000;
  const cacheFile = remoteCachePath(uri);

  // Cache hit check
  if (!opts.forceRefresh && existsSync(cacheFile)) {
    try {
      const stat = statSync(cacheFile);
      const age = Date.now() - stat.mtimeMs;
      if (age < ttlMs) {
        const cached = readFileSync(cacheFile, "utf-8");
        return parseRemoteContent(uri, cached, { fromCache: true, cacheFile });
      }
    } catch {
      // Cache unreadable — fall through to fetch
    }
  }

  // Fetch from GitHub
  const ownerRepo = `${uri.owner}/${uri.repo}`;
  const dnaPath = uri.path ? `${uri.path}/dna.yml` : "dna.yml";
  const branches = ["main", "master"];
  let content: string | null = null;
  let fetchedBranch = "";

  for (const branch of branches) {
    const url = `https://raw.githubusercontent.com/${ownerRepo}/${branch}/${dnaPath}`;
    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 8000);
      const res = await fetch(url, { signal: controller.signal });
      clearTimeout(timer);
      if (res.status === 200) {
        content = await res.text();
        fetchedBranch = branch;
        break;
      }
      if (res.status === 404) continue;
      throw new Error(`HTTP ${res.status} from ${url}`);
    } catch (err: any) {
      if (err.name === "AbortError") throw new Error(`Network timeout fetching ${url}`);
      if (err.message?.startsWith("HTTP ")) throw err;
      throw new Error(`Network error fetching ${url}: ${err.message}`);
    }
  }

  if (content === null) {
    throw new Error(`No dna.yml found at upstream ${ownerRepo} (tried branches: ${branches.join(", ")})`);
  }

  // Write to cache
  try {
    mkdirSync(join(cacheFile, ".."), { recursive: true });
    writeFileSync(cacheFile, content, "utf-8");
  } catch {
    // Cache write failure is non-fatal
  }

  return parseRemoteContent(uri, content, { fromCache: false, branch: fetchedBranch });
}

/** Parse fetched YAML into a MeshNode-like object, overriding id with the remote URI. */
function parseRemoteContent(
  uri: RemoteUri,
  content: string,
  meta: { fromCache?: boolean; cacheFile?: string; branch?: string }
): MeshNode {
  let fields: Record<string, any>;
  try {
    fields = (yaml.load(content) as Record<string, any>) || {};
  } catch (err: any) {
    throw new Error(`Failed to parse dna.yml from ${uri.raw}: ${err.message}`);
  }
  if (!fields || typeof fields !== "object" || Array.isArray(fields)) {
    throw new Error(`dna.yml from ${uri.raw} is empty or not a YAML object`);
  }

  // Override id with the remote URI (local control)
  fields._remote_original_id = fields.id;
  fields.id = uri.raw;
  fields._remote_uri = uri.raw;
  fields._remote_provider = uri.provider;
  fields._remote_owner = uri.owner;
  fields._remote_repo = uri.repo;
  fields._remote_fetched_from_cache = meta.fromCache ?? false;
  if (meta.branch) fields._remote_branch = meta.branch;
  if (meta.cacheFile) fields._remote_cache_file = meta.cacheFile;

  const type: string = fields.type || "project";
  const title: string = fields.title || `${uri.owner}/${uri.repo}`;

  return {
    id: uri.raw,
    type,
    title,
    path: meta.cacheFile || remoteCachePath(uri),
    fields,
    outbound: [],
  };
}

/** List all cached remote nodes. */
function listCachedRemotes(): Array<{ uri: string; cacheFile: string; ageSec: number }> {
  const results: Array<{ uri: string; cacheFile: string; ageSec: number }> = [];
  if (!existsSync(REMOTE_CACHE_DIR)) return results;
  for (const provider of readdirSync(REMOTE_CACHE_DIR)) {
    const provDir = join(REMOTE_CACHE_DIR, provider);
    try { if (!statSync(provDir).isDirectory()) continue; } catch { continue; }
    for (const owner of readdirSync(provDir)) {
      const ownerDir = join(provDir, owner);
      try { if (!statSync(ownerDir).isDirectory()) continue; } catch { continue; }
      for (const fname of readdirSync(ownerDir)) {
        if (!fname.endsWith(".yml")) continue;
        const cacheFile = join(ownerDir, fname);
        const repo = fname.replace(/__dna\.yml$/, "").replace(/__.*$/, "");
        const uri = `dna://${provider}/${owner}/${repo}`;
        try {
          const age = Math.floor((Date.now() - statSync(cacheFile).mtimeMs) / 1000);
          results.push({ uri, cacheFile, ageSec: age });
        } catch { /* skip */ }
      }
    }
  }
  return results;
}

/** cmdLsRemote — list cached remote nodes. */
function cmdLsRemote() {
  const remotes = listCachedRemotes();
  if (remotes.length === 0) {
    console.log("(No cached remote nodes — use: dna node dna://github.com/<owner>/<repo>)");
    return;
  }
  console.log(`🌐  Cached remote nodes (${remotes.length}):`);
  for (const r of remotes) {
    const age = r.ageSec < 3600 ? `${Math.floor(r.ageSec / 60)}m` :
                r.ageSec < 86400 ? `${Math.floor(r.ageSec / 3600)}h` :
                `${Math.floor(r.ageSec / 86400)}d`;
    console.log(`  ${r.uri.padEnd(55)} (cached ${age} ago)`);
  }
  console.log(`\nCache dir: ${relPath(REMOTE_CACHE_DIR)}`);
}

/** cmdSyncRemote — refresh all cached remotes (TTL bypass). */
async function cmdSyncRemote(args: string[]) {
  const ttlHours = (() => {
    const i = args.indexOf("--ttl"); return i >= 0 ? parseFloat(args[i + 1]) : 0;
  })();
  const remotes = listCachedRemotes();
  if (remotes.length === 0) {
    console.log("(No cached remote nodes to sync)");
    return;
  }
  console.log(`🔄  Syncing ${remotes.length} cached remote node(s)...\n`);
  let ok = 0, fail = 0;
  for (const r of remotes) {
    const parsed = parseRemoteUri(r.uri);
    if (!parsed) { fail++; continue; }
    process.stdout.write(`  ${r.uri} ... `);
    try {
      await fetchRemoteDna(parsed, { forceRefresh: true, ttlHours });
      console.log(`✅`);
      ok++;
    } catch (err: any) {
      console.log(`❌ ${err.message}`);
      fail++;
    }
  }
  console.log(`\n✅  Sync complete: ${ok} updated, ${fail} failed`);
}

/** cmdPromoteRemote — fetch remote + write to local shadow file. */
async function cmdPromoteRemote(args: string[]) {
  const uriArg = args[0];
  if (!uriArg) {
    console.error("Usage: dna mesh promote-remote <dna://github.com/owner/repo>");
    process.exit(1);
  }
  const parsed = parseRemoteUri(uriArg);
  if (!parsed) {
    console.error(`❌ Not a remote URI: ${uriArg}`);
    process.exit(1);
  }
  if (parsed.provider !== "github.com") {
    console.error(`❌ Only github.com is supported for promote-remote`);
    process.exit(1);
  }
  console.log(`📥  Fetching ${uriArg} ...`);
  let node: MeshNode;
  try {
    node = await fetchRemoteDna(parsed, { forceRefresh: true });
  } catch (err: any) {
    console.error(`❌ ${err.message}`);
    process.exit(1);
  }

  const shadowDir = join(DNA_DATA, "nodes", "maintained-oss");
  const shadowFile = join(shadowDir, `${parsed.owner}-${parsed.repo}.dna.yml`);
  mkdirSync(shadowDir, { recursive: true });

  const shadowFields: Record<string, any> = {
    id: `dna://maintained-oss/${parsed.owner}-${parsed.repo}`,
    shadow: true,
    shadow_origin: `https://github.com/${parsed.owner}/${parsed.repo}`,
    shadow_fetched_at: new Date().toISOString(),
    _promoted_from: uriArg,
  };
  const COPY_FIELDS = ["type", "title", "description", "homepage", "status", "version", "tags"];
  for (const k of COPY_FIELDS) {
    if (node.fields[k] && !String(k).startsWith("_remote_")) shadowFields[k] = node.fields[k];
  }

  writeFileSync(shadowFile, yaml.dump(shadowFields, { lineWidth: 120 }), "utf-8");
  console.log(`✅  Promoted → ${relPath(shadowFile)}`);
  console.log(`   Shadow ID: ${shadowFields.id}`);
  console.log(`   Run: dna mesh scan  to index it`);
}

const SKIP_DIRS = new Set([
  "node_modules", ".git", "dist", "build", ".next", ".turbo",
  "memory", "_shots", ".cache", "logs", "tmp",
]);

const ID_REGEX = /dna:\/\/[a-z][a-z0-9-]*\/[a-zA-Z0-9_.-]+/g;
const CACHE_PATH = join(DNA_DATA, ".mesh-cache.json");
// Shadow cache removed (NEBULA-82) — upstream content lives in the shadow node file itself
const MAX_DEPTH = 8;  // safety: don't recurse forever

// --- Verb model ---

/** All typed verb pairs (forward → inverse). */
export const VERB_INVERSE: Record<string, string> = {
  managed_by:   "manages",
  manages:      "managed_by",
  governed_by:  "governs",
  governs:      "governed_by",
  runs_on:      "hosts",
  hosts:        "runs_on",
  deploys:      "deployed_by",
  deployed_by:  "deploys",
  derives_from: "derived_into",
  derived_into: "derives_from",
  built_from:   "built_into",
  built_into:   "built_from",
  depends_on:   "used_by",
  used_by:      "depends_on",
  mentions:     "mentioned_by",
  mentioned_by: "mentions",
  binds:        "bound_by",
  bound_by:     "binds",
  executes:     "executed_by",
  executed_by:  "executes",
  tracked_in:   "tracks",
  tracks:       "tracked_in",
};

/** Structural verbs that require a back-link declaration in the target node. */
export const BIDIRECTIONAL_VERBS = new Set<string>([
  "managed_by", "manages",
  "governed_by", "governs",
  "runs_on", "hosts",
  "deploys", "deployed_by",
  "built_from", "built_into",
  "depends_on", "used_by",
  "tracked_in", "tracks",
]);

/** Citation-style verbs: one-way, no back-link required. */
export const ONE_WAY_VERBS = new Set<string>([
  "derives_from", "derived_into",
  "mentions", "mentioned_by",
  "binds", "bound_by",
  "executes", "executed_by",
  // legacy citation kinds (scanCitations)
  "governance",
]);

/** All verb field names that can appear in frontmatter. */
const ALL_VERB_FIELDS = new Set<string>(Object.keys(VERB_INVERSE));

/** Canonical display order for edge kinds in show/refs output. */
const KIND_DISPLAY_ORDER = [
  // typed verbs (structural)
  "managed_by", "manages",
  "governed_by", "governs",
  "runs_on", "hosts",
  "deploys", "deployed_by",
  "depends_on", "used_by",
  // typed verbs (one-way)
  "derives_from", "derived_into",
  "mentions", "mentioned_by",
  "binds", "bound_by",
  "executes", "executed_by",
  // legacy
  "link", "governance",
];

// --- Types ---

// (lint fields added inline in MeshGraph below)

interface MeshNode {
  id: string;
  type: string;
  title?: string;
  path: string;             // absolute file path
  fields: Record<string, any>;  // raw parsed YAML/frontmatter
  outbound: MeshEdge[];     // resolved edges (deduped by target+kind)
  _body?: string;           // markdown body (for .md files only)
  synthetic_id?: boolean;   // true if id was synthesized from parent dir
}

// Edge with kind + optional source-file metadata
interface MeshEdge {
  target: string;
  // kind: verb name (typed verb or legacy "link"/"governance"/citation kinds)
  kind: string;
  sourceFile?: string;  // relative path within workspace, for citation edges
}

interface MeshGraph {
  nodes: Map<string, MeshNode>;
  // path -> id (for de-dup detection)
  pathIndex: Map<string, string>;
  // target -> set of source IDs (inbound edges, any kind)
  inbound: Map<string, Set<string>>;
  // target -> list of inbound edges with kind+source metadata
  inboundEdges: Map<string, Array<{ from: string; kind: MeshEdge["kind"]; sourceFile?: string }>>;
  // lint findings
  lint: {
    deadLinks: Array<{ from: string; to: string; field: string }>;
    nearMissFiles: string[];
    duplicateIds: Array<{ id: string; paths: string[] }>;
    missingFields: Array<{ path: string; missing: string[] }>;
    nonCanonicalExt: string[];  // dna.yaml when dna.yml is preferred
    cycles: Array<string[]>;  // each entry is a cycle (list of node IDs)
    staleShadows: Array<{ id: string; path: string; age_days: number }>;
    idPathMismatches: Array<{ id: string; path: string; expected: string }>;
    typeDirMismatches: Array<{ id: string; path: string; dir_type: string }>;
    missingBackLinks: Array<{ source: string; target: string }>;
    missingTitles: string[];
    // New: content-driven discovery lint
    implicitTypeFiles: string[];         // legacy gov files without explicit `type:` frontmatter
    extensionHintMismatches: string[];   // *.dna.md files with no frontmatter at all
    // New: shadow purity lint
    shadowContaminations: Array<{ id: string; path: string; field: string }>;  // forbidden local field
    shadowMissingOrigin: Array<{ id: string; path: string }>;                  // shadow: true but no shadow_origin
    // New: cross-agent dependency awareness
    crossAgentDeps: Array<{ kind: 'inject' | 'link'; file: string; slug?: string; sourceAgent: string; targetAgent: string; sourceId?: string; targetId?: string }>;
  };
}

// --- Scanner ---

/** Walk a root dir, collect candidate files.
 * Content-driven: picks up dna.yml/dna.yaml and ALL .md files (except common non-mesh ones).
 * parseFile decides if each .md is actually a mesh node based on frontmatter `type:` field.
 */
function walkForCandidates(root: string, depth = 0): string[] {
  if (!existsSync(root) || depth > MAX_DEPTH) return [];
  const out: string[] = [];
  let entries: string[] = [];
  try {
    entries = readdirSync(root);
  } catch {
    return out;
  }
  for (const name of entries) {
    if (SKIP_DIRS.has(name)) continue;
    if (name.startsWith(".") && name !== ".dna") continue;
    const full = join(root, name);
    let st;
    try { st = statSync(full); } catch { continue; }
    if (st.isDirectory()) {
      out.push(...walkForCandidates(full, depth + 1));
    } else if (st.isFile()) {
      if (name === "dna.yml" || name === "dna.yaml") {
        out.push(full);
      } else if (name.endsWith(".dna.yml")) {
        // Pure YAML shadow nodes (migrated from .dna.md)
        out.push(full);
      } else if (name.endsWith(".dna")) {
        // New unified extension: pure YAML or YAML frontmatter + markdown body
        out.push(full);
      } else if (name.endsWith(".md") && name !== "index.md" && name !== "README.md") {
        // All .md files are candidates; parseFile filters by frontmatter `type:` presence
        out.push(full);
      }
    }
  }
  return out;
}

/** Recursively walk YAML object, extracting all string values. */
function walkStrings(obj: any, fieldPath: string, visit: (s: string, fp: string) => void) {
  if (obj == null) return;
  if (typeof obj === "string") {
    visit(obj, fieldPath);
  } else if (Array.isArray(obj)) {
    for (let i = 0; i < obj.length; i++) {
      walkStrings(obj[i], `${fieldPath}[${i}]`, visit);
    }
  } else if (typeof obj === "object") {
    for (const k of Object.keys(obj)) {
      if (k.startsWith("_")) continue;  // internal fields
      walkStrings(obj[k], fieldPath ? `${fieldPath}.${k}` : k, visit);
    }
  }
}

// Legacy governance directory → type hint (used as fallback when file has no explicit `type:` frontmatter)
// ONLY used to preserve backward-compat for the 53 existing governance .md files.
// Files with explicit `type:` in frontmatter take precedence regardless of location.
const LEGACY_GOV_DIR_TYPE_HINT: Record<string, string> = {
  philosophies: "philosophy",
  conventions: "convention",
  flows: "flow",
  protocols: "protocol",
};

/** Parse one file → MeshNode (or null if not a mesh node).
 *
 * Content-driven discovery: a file is a mesh node iff:
 *   1. It has frontmatter/yaml with an explicit `type:` field, OR
 *   2. It lives in a legacy gov dir (LEGACY_GOV_DIR_TYPE_HINT) without explicit `type:`
 *      → type is inferred from dir as a backward-compat fallback + lint warning emitted.
 *
 * Files with no `type:` outside legacy gov dirs are silently skipped.
 */
function parseFile(path: string, lint: MeshGraph["lint"]): MeshNode | null {
  let raw: string;
  try { raw = readFileSync(path, "utf-8"); } catch { return null; }
  const isMd = path.endsWith(".md");
  // .dna files: pure YAML OR frontmatter+markdown (auto-detect by leading `---`)
  const isDna = path.endsWith(".dna");
  const isDnaFrontmatter = isDna && raw.startsWith("---");
  let fields: Record<string, any>;
  let _body: string | undefined;
  if (isMd || isDnaFrontmatter) {
    const { meta, body } = parseFrontmatter(raw);
    fields = meta || {};
    _body = body || undefined;
  } else {
    try {
      fields = (yaml.load(raw) as Record<string, any>) || {};
    } catch (e: any) {
      // YAML parse error - skip
      return null;
    }
  }
  if (!fields || typeof fields !== "object" || Array.isArray(fields)) return null;

  // Content-driven type: prefer explicit `type:` in frontmatter/yaml
  let type: string = fields.type;
  let synthetic_id = false;

  // Global legacy governance dir: .openclaw/.dna/{philosophies,conventions,flows,protocols}
  const GLOBAL_DNA_DIR = join(HOME, ".openclaw/.dna");
  const isInGlobalLegacyGovDir = path.startsWith(GLOBAL_DNA_DIR);

  // If no explicit type, check if file is in a GLOBAL legacy gov dir for backward-compat fallback
  if (!type) {
    const parentDir = basename(dirname(path));
    const inferredType = isInGlobalLegacyGovDir ? LEGACY_GOV_DIR_TYPE_HINT[parentDir] : null;
    if (inferredType) {
      // Legacy gov file without explicit type: still index it, emit lint warning
      type = inferredType;
      lint.implicitTypeFiles.push(path);
    } else if (fields.shadow === true && fields.id) {
      // Pure-pointer shadow with no type yet (pending_sync) - infer from parent dir or use "shadow"
      type = basename(dirname(path));  // e.g. "tool", "repo", "site"
      if (!type || type === "nodes" || type === ".dna") type = "shadow";
    } else {
      // No type, not a legacy gov dir → not a mesh node
      // Exception: *.dna.md files with no frontmatter at all get a hint mismatch warning
      if (path.endsWith(".dna.md") && Object.keys(fields).length === 0) {
        lint.extensionHintMismatches.push(path);
      }
      return null;
    }
  }

  let id: string = fields.id;

  // Synthetic id: if id exists but lacks dna:// prefix, infer type from parent dir (global only) or explicit type
  if (id && typeof id === "string" && !id.startsWith("dna://")) {
    const parentDir = basename(dirname(path));
    const legacyHint = isInGlobalLegacyGovDir ? LEGACY_GOV_DIR_TYPE_HINT[parentDir] : null;
    const inferredType = legacyHint || type;
    if (inferredType) {
      id = `dna://${inferredType}/${fields.id}`;
      synthetic_id = true;
    } else {
      return null;
    }
  }

  if (!id || typeof id !== "string" || !id.startsWith("dna://")) {
    // Has dna file but no mesh id - flag near-miss for canonical DNA file types
    if (path.endsWith("dna.yaml") || path.endsWith("dna.yml") || path.endsWith(".dna.md") || path.endsWith(".dna.yml") || path.endsWith(".dna")) {
      lint.missingFields.push({ path, missing: ["id"] });
    }
    return null;
  }
  // Collect outbound link-kind edges from all string values in frontmatter
  // BUT skip verb fields (they are parsed separately below to preserve kind)
  const outboundEdges: MeshEdge[] = [];
  const outboundSet = new Set<string>();

  // 1. Parse typed verb fields first (each verb: string | string[])
  for (const verb of ALL_VERB_FIELDS) {
    const raw = fields[verb];
    if (raw == null) continue;
    const targets: string[] = Array.isArray(raw) ? raw : [raw];
    for (const t of targets) {
      if (typeof t !== "string") continue;
      // Accept full dna:// ids or bare type/slug
      const target = t.startsWith("dna://") ? t : (t.includes("/") ? `dna://${t}` : null);
      if (!target || target === id) continue;
      const edgeKey = `${verb}:${target}`;
      if (!outboundSet.has(edgeKey)) {
        outboundSet.add(edgeKey);
        outboundEdges.push({ target, kind: verb });
      }
    }
  }

  // 2. Walk remaining frontmatter strings for legacy link/governance edges
  //    Skip verb field keys so we don't double-count
  walkStrings(fields, "", (s, fp) => {
    // Skip if this string came from a verb field
    const topKey = fp.split(".")[0].split("[")[0];
    if (ALL_VERB_FIELDS.has(topKey)) return;
    if (s.includes("dna://")) {
      const matches = s.match(ID_REGEX);
      if (matches) {
        for (const m of matches) {
          if (m !== id && !outboundSet.has(`link:${m}`)) {
            outboundSet.add(`link:${m}`);
            outboundEdges.push({ target: m, kind: "link" });
          }
        }
      }
    }
  });

  // Parse governance: array - slug shorthand like "artifact-is-the-test" or full dna:// ids
  const governanceRaw = fields.governance;
  if (Array.isArray(governanceRaw)) {
    for (const entry of governanceRaw) {
      if (typeof entry !== "string") continue;
      const govTarget2 = (!entry.startsWith("dna://") && entry.includes("/"))
        ? `dna://${entry}` : null;
      const finalTarget = entry.startsWith("dna://") ? entry : govTarget2;
      if (finalTarget && finalTarget !== id && !outboundSet.has(`governance:${finalTarget}`)) {
        outboundSet.add(`governance:${finalTarget}`);
        outboundEdges.push({ target: finalTarget, kind: "governance" });
      }
    }
  }

  // --- Shadow: upstream fields are stored directly in the node file (no central cache) ---
  if (fields.shadow === true && typeof fields.shadow_origin === "string" && fields.shadow_origin) {
    // Update type from upstream fields already in the node file
    if (!type && fields.type) type = fields.type;
  }

  // --- Title fallback chain ---
  // 1. Explicit title: field
  // 2. First H1 in body (strip 'DNA - ' prefix if present)
  // 3. id basename capitalized
  let resolvedTitle: string | undefined = fields.title;
  if (!resolvedTitle && _body) {
    const h1Match = _body.match(/^#\s+(.+)$/m);
    if (h1Match) {
      let h1 = h1Match[1].trim();
      // Strip 'DNA - ' or 'DNA - ' prefix (case-insensitive)
      h1 = h1.replace(/^DNA\s*[\u2014\-]\s*/i, "").trim();
      if (h1) resolvedTitle = h1;
    }
  }
  if (!resolvedTitle && !isMd && !fields.title) {
    // YAML files: also scan for a comment-based heading like '# DNA — MeTuber'
    const commentH1 = raw.match(/^#\s+(.+)$/m);
    if (commentH1) {
      let h1 = commentH1[1].trim();
      h1 = h1.replace(/^DNA\s*[\u2014\-]\s*/i, "").trim();
      if (h1) resolvedTitle = h1;
    }
  }
  if (!resolvedTitle) {
    // Fallback: capitalize id basename
    const base = id.split("/").pop() || "";
    if (base) resolvedTitle = base.charAt(0).toUpperCase() + base.slice(1);
  }

  return {
    id,
    type: type || "unknown",
    title: resolvedTitle,
    path,
    fields,
    outbound: outboundEdges,
    _body,
    synthetic_id: synthetic_id || undefined,
  };
}

// --- Public helpers for typed CLIs ---

/** Get all nodes of a given type from the graph. */
export function getNodesByType(graph: MeshGraph, type: string): MeshNode[] {
  return [...graph.nodes.values()].filter(n => n.type === type);
}

/**
 * Convert a MeshNode to the legacy entry shape used by typed CLIs.
 * Preserves all frontmatter fields, adds _body, _path, _scope.
 */
export function nodeToEntry(node: MeshNode): Record<string, any> {
  const scope = node.path.includes("/.openclaw/.dna/") ? "global" : "workspace";
  const entry: Record<string, any> = {
    ...node.fields,
    _body: node._body ?? "",
    _path: node.path,
    _scope: scope,
  };
  // For synthetic id nodes, the fields.id is the short slug - mesh id is the full dna:// id
  // Typed CLIs look up by legacy short slug, so set id to the short form
  if (node.synthetic_id) {
    entry.id = node.fields.id;  // keep short slug as id
  }
  return entry;
}

// --- Citation scanner ---

// File globs for agent scope (identity/config files in workspace root)
const AGENT_SCOPE_FILES = new Set([
  "AGENTS.md", "SOUL.md", "IDENTITY.md", "USER.md", "TOOLS.md", "MEMORY.md", "HEARTBEAT.md",
]);

// Regex: {{dna <type> --inject <slug>}} or {{dna convention --inject ticket-before-work}}
const RE_INJECT = /\{\{\s*dna\s+(\S+)\s+--inject\s+(\S+?)\s*\}\}/g;
// Regex: exec: dna <type> <slug> (in cron/pod files)
const RE_EXEC   = /\bexec:\s*dna\s+(\S+)\s+(\S+)/g;
// Regex: inline backtick `dna <type> <slug>` (NOT inside ``` fences)
const RE_INLINE = /`dna\s+(\S+)\s+(\S+?)`/g;

/** Strip code-fence blocks from markdown to avoid false inline matches. */
function stripCodeFences(src: string): string {
  return src.replace(/```[\s\S]*?```/g, (m) => " ".repeat(m.length));
}

/** Valid slug: lowercase letters, digits, hyphens; starts with letter; min 1 char. */
const SLUG_RE = /^[a-z][a-z0-9-]*[a-z0-9]$|^[a-z]$/;
function isValidSlug(slug: string): boolean {
  // Reject placeholders like <args>, <slug>, flags like --list/--agent, etc.
  if (slug.startsWith("--") || slug.includes("<") || slug.includes(">")) return false;
  return SLUG_RE.test(slug);
}

/** Resolve `dna <type> <slug>` into a mesh ID, handling common shorthand. */
function resolveRef(type: string, slug: string): string | null {
  // dna convention X → dna://convention/X
  // dna philosophy X → dna://philosophy/X
  // etc.
  const typeMap: Record<string, string> = {
    convention: "convention", philosophy: "philosophy", flow: "flow",
    protocol: "protocol", tool: "tool", agent: "agent", realm: "realm",
  };
  const t = typeMap[type.toLowerCase()];
  if (!t) return null;
  if (!isValidSlug(slug)) return null;
  return `dna://${t}/${slug}`;
}

/** Walk a workspace dir, collect citation edges, auto-create cron nodes.
 *
 * NOTE (2026-04): Auto-discovery of workspace markdown files (CRON_ENTRYPOINT*.md,
 * POD*.md, memory/*.md, AGENTS.md, SOUL.md, IDENTITY.md, USER.md, TOOLS.md, MEMORY.md,
 * HEARTBEAT.md, pods/*.md) is DISABLED. These files have no .dna extension and no
 * frontmatter, so they shouldn't be auto-recognized as DNA shards. To bring a pod
 * into the mesh, create an explicit .dna file (e.g. CRON_ENTRYPOINT.dna).
 *
 * The scanCitations function now does nothing. Citation edges are only emitted from
 * proper .dna / .dna.yml / .dna.yaml / .dna.md files via the regular candidate scan.
 */
function scanCitations(
  _graph: MeshGraph,
  _addEdge: (from: string, edge: MeshEdge) => void,
) {
  return;
}

// eslint-disable-next-line @typescript-eslint/no-unused-vars
function _scanCitations_DISABLED(
  graph: MeshGraph,
  addEdge: (from: string, edge: MeshEdge) => void,
) {
  // Dedupe set: prevents same (source, target, kind, sourceFile) edge from being added twice
  const edgeDedupeSet = new Set<string>();
  const dedupedAddEdge = (from: string, edge: MeshEdge) => {
    const key = `${from}\0${edge.target}\0${edge.kind}\0${edge.sourceFile ?? ""}`;
    if (edgeDedupeSet.has(key)) return;
    edgeDedupeSet.add(key);
    addEdge(from, edge);
  };
  // Find workspace dirs: .openclaw/workspace + .openclaw/workspaces/*
  const wsBase = join(HOME, ".openclaw/workspaces");
  const wsDirs: Array<{ agentName: string; dir: string }> = [];

  // Main session workspace (agent name = claw)
  const mainWs = join(HOME, ".openclaw/workspace");
  if (existsSync(mainWs)) wsDirs.push({ agentName: "claw", dir: mainWs });

  // Named workspaces
  if (existsSync(wsBase)) {
    for (const name of readdirSync(wsBase)) {
      const d = join(wsBase, name);
      try { if (statSync(d).isDirectory()) wsDirs.push({ agentName: name, dir: d }); } catch { /* skip */ }
    }
  }

  for (const { agentName, dir } of wsDirs) {
    const agentId = `dna://agent/${agentName}`;
    if (!graph.nodes.has(agentId)) continue;  // only process known mesh agents

    // --- Agent-scope files ---
    const memoryDir = join(dir, "memory");
    const agentFiles: string[] = [];
    for (const f of AGENT_SCOPE_FILES) {
      const fp = join(dir, f);
      if (existsSync(fp)) agentFiles.push(fp);
    }
    // memory/*.md
    if (existsSync(memoryDir)) {
      try {
        for (const f of readdirSync(memoryDir)) {
          if (f.endsWith(".md")) agentFiles.push(join(memoryDir, f));
        }
      } catch { /* skip */ }
    }

    for (const fp of agentFiles) {
      let src: string;
      try { src = readFileSync(fp, "utf-8"); } catch { continue; }
      const srcRel = relative(HOME, fp);
      const stripped = stripCodeFences(src);

      // {{dna X --inject Y}} → binds (was agent-binding)
      for (const m of src.matchAll(RE_INJECT)) {
        const ref = resolveRef(m[1], m[2]);
        if (ref && ref !== agentId) dedupedAddEdge(agentId, { target: ref, kind: "binds", sourceFile: srcRel });
      }
      // inline `dna X Y` → mentions (was doc-reference, code-fence stripped)
      for (const m of stripped.matchAll(RE_INLINE)) {
        const ref = resolveRef(m[1], m[2]);
        if (ref && ref !== agentId) dedupedAddEdge(agentId, { target: ref, kind: "mentions", sourceFile: srcRel });
      }
    }

    // --- Cron-scope files ---
    const cronFiles: Array<{ fp: string; baseName: string }> = [];

    // CRON_ENTRYPOINT*.md
    try {
      for (const f of readdirSync(dir)) {
        if (f.match(/^CRON_ENTRYPOINT.*\.md$/)) cronFiles.push({ fp: join(dir, f), baseName: f.replace(/\.md$/, "").replace(/^CRON_ENTRYPOINT/, "cron-entrypoint").toLowerCase() });
        if (f.match(/POD.*\.md$/i) || f.match(/.*POD\.md$/i)) cronFiles.push({ fp: join(dir, f), baseName: f.replace(/\.md$/, "").toLowerCase().replace(/_/g, "-") });
      }
    } catch { /* skip */ }

    // pods/*.md
    const podsDir = join(dir, "pods");
    if (existsSync(podsDir)) {
      try {
        for (const f of readdirSync(podsDir)) {
          if (f.endsWith(".md")) cronFiles.push({ fp: join(podsDir, f), baseName: f.replace(/\.md$/, "").toLowerCase().replace(/_/g, "-") });
        }
      } catch { /* skip */ }
    }

    for (const { fp, baseName } of cronFiles) {
      const cronId = `dna://cron/${agentName}-${baseName}`;
      let src: string;
      try { src = readFileSync(fp, "utf-8"); } catch { continue; }
      const srcRel = relative(HOME, fp);
      const stripped = stripCodeFences(src);

      // Auto-create cron node if it doesn't exist
      if (!graph.nodes.has(cronId)) {
        const cronNode: MeshNode = {
          id: cronId,
          type: "cron",
          title: baseName,
          path: fp,
          fields: { id: cronId, type: "cron", title: baseName },
          outbound: [],
        };
        graph.nodes.set(cronId, cronNode);
        // Bidirectional ownership: cron → agent, agent → cron
        dedupedAddEdge(cronId, { target: agentId, kind: "link", sourceFile: srcRel });
        // Patch agent outbound too (in-memory only)
        const agentNode = graph.nodes.get(agentId)!;
        if (!agentNode.outbound.find(e => e.target === cronId)) {
          agentNode.outbound.push({ target: cronId, kind: "link" });
          dedupedAddEdge(agentId, { target: cronId, kind: "link" });
        }
      }

      // exec: dna X Y → executes (was runtime-binding)
      for (const m of src.matchAll(RE_EXEC)) {
        const ref = resolveRef(m[1], m[2]);
        if (ref && ref !== cronId) dedupedAddEdge(cronId, { target: ref, kind: "executes", sourceFile: srcRel });
      }
      // inline `dna X Y` → mentions (was doc-reference)
      for (const m of stripped.matchAll(RE_INLINE)) {
        const ref = resolveRef(m[1], m[2]);
        if (ref && ref !== cronId) dedupedAddEdge(cronId, { target: ref, kind: "mentions", sourceFile: srcRel });
      }
      // {{dna X --inject Y}} → executes in cron files = runtime intent
      for (const m of src.matchAll(RE_INJECT)) {
        const ref = resolveRef(m[1], m[2]);
        if (ref && ref !== cronId) dedupedAddEdge(cronId, { target: ref, kind: "executes", sourceFile: srcRel });
      }
    }
  }
}

/** Build the full graph by scanning. */
export function buildGraph(): MeshGraph {
  const graph: MeshGraph = {
    nodes: new Map(),
    pathIndex: new Map(),
    inbound: new Map(),
    inboundEdges: new Map(),
    lint: {
      deadLinks: [],
      nearMissFiles: [],
      duplicateIds: [],
      missingFields: [],
      nonCanonicalExt: [],
      cycles: [],
      staleShadows: [],
      idPathMismatches: [],
      typeDirMismatches: [],
      missingBackLinks: [],
      missingTitles: [],
      implicitTypeFiles: [],
      extensionHintMismatches: [],
      shadowContaminations: [],
      shadowMissingOrigin: [],
      crossAgentDeps: [],
    },
  };

  const candidates: string[] = [];
  for (const root of SCAN_ROOTS) {
    const found = walkForCandidates(root, 0);
    if (process.env.DEBUG_MESH) console.error(`[mesh] root=${root} found=${found.length}`);
    candidates.push(...found);
  }
  // Dedupe paths (in case of overlapping roots)
  const uniquePaths = [...new Set(candidates)];
  // Priority sort: when both `foo.dna` and `foo.dna.yml` exist for the same id,
  // the new `.dna` format should win. Since graph.nodes uses last-wins below,
  // process `.dna` files LAST.
  const extPriority = (p: string): number => {
    if (p.endsWith(".dna")) return 2;       // highest priority — processed last
    if (p.endsWith(".dna.yml")) return 1;
    if (p.endsWith(".dna.yaml")) return 1;
    return 0;
  };
  uniquePaths.sort((a, b) => extPriority(a) - extPriority(b));

  // Track duplicate ids
  const idsSeen = new Map<string, string[]>();

  for (const path of uniquePaths) {
    const node = parseFile(path, graph.lint);
    if (!node) continue;
    graph.pathIndex.set(path, node.id);
    if (idsSeen.has(node.id)) {
      idsSeen.get(node.id)!.push(path);
    } else {
      idsSeen.set(node.id, [path]);
    }
    graph.nodes.set(node.id, node);  // last wins; duplicates flagged below
    // Only flag *.dna.yaml (shadow nodes with non-canonical extension).
    // Workspace-root dna.yaml (basename is exactly "dna.yaml") is accepted as valid.
    if (path.endsWith(".dna.yaml")) {
      graph.lint.nonCanonicalExt.push(path);
    }
  }

  // Duplicate id lint
  for (const [id, paths] of idsSeen) {
    if (paths.length > 1) {
      graph.lint.duplicateIds.push({ id, paths });
    }
  }

  // Build inbound + dead-link detection
  function addEdge(from: string, edge: MeshEdge) {
    const { target, kind, sourceFile } = edge;
    if (!graph.inbound.has(target)) graph.inbound.set(target, new Set());
    graph.inbound.get(target)!.add(from);
    if (!graph.inboundEdges.has(target)) graph.inboundEdges.set(target, []);
    graph.inboundEdges.get(target)!.push({ from, kind, sourceFile });
    if (!graph.nodes.has(target)) {
      graph.lint.deadLinks.push({ from, to: target, field: sourceFile || "<various>" });
    }
  }

  // --- Citation scanner: walk workspace dirs for agent + cron citation edges ---
  // Must run BEFORE the dead-link detection loop so cron nodes are registered
  // in graph.nodes before agent dna.yml link: edges are checked.
  scanCitations(graph, addEdge);

  for (const node of graph.nodes.values()) {
    for (const edge of node.outbound) {
      addEdge(node.id, edge);
      // Generate virtual inverse edge in inbound index (structural verbs only)
      // The actual file may or may not declare the inverse - we track it virtually
      const inverseVerb = VERB_INVERSE[edge.kind];
      if (inverseVerb) {
        // Register target→source with inverse kind in inboundEdges
        if (!graph.inbound.has(node.id)) graph.inbound.set(node.id, new Set());
        // (inbound from target's perspective on this node - already handled by addEdge above)
        // What we want: target gets virtual inbound edge showing inverse verb
        // This is stored under a separate virtual key to avoid double-counting
        if (!graph.inboundEdges.has(node.id)) graph.inboundEdges.set(node.id, []);
        // The virtual inverse is: "target claims to <verb> node.id, so node.id receives <inverseVerb> from target"
        // But this is only for the inbound display - we don't want to duplicate the lint dead-link check
        // So this is handled implicitly by the forward edge already in inboundEdges
      }
    }
  }

  // Cache
  try {
    const cache = {
      generated_at: new Date().toISOString(),
      stats: {
        nodes: graph.nodes.size,
        edges: [...graph.nodes.values()].reduce((a, n) => a + n.outbound.length, 0),
        deadLinks: graph.lint.deadLinks.length,
      },
      nodes: [...graph.nodes.values()].map(n => ({
        id: n.id, type: n.type, title: n.title, path: n.path,
        status: typeof n.fields?.status === "string" ? n.fields.status : undefined,
        managed_by: typeof n.fields?.managed_by === "string" ? n.fields.managed_by : undefined,
        outbound: n.outbound.map(e => ({ target: e.target, kind: e.kind })),
      })),
    };
    writeFileSync(CACHE_PATH, JSON.stringify(cache, null, 2));
  } catch {
    // cache failure is non-fatal
  }

  return graph;
}

// --- Output helpers ---

function relPath(p: string): string {
  return relative(HOME, p);
}

function fmt(node: MeshNode, withTitle = true): string {
  const t = withTitle && node.title ? ` - ${node.title}` : "";
  return `${node.id}${t}`;
}

// --- Known structural fields (not shown in 'Other fields' dump) ---
const KNOWN_STRUCTURAL_FIELDS = new Set([
  "id", "type", "title", "links",
  "manages", "managed_by", "governed_by", "governs",
  "runs_on", "hosts", "deploys", "deployed_by",
  "depends_on", "used_by", "derives_from", "derived_into",
  "mentions", "binds", "executes",
  "tracked_in", "tracks",
  "shadow", "shadow_origin", "shadow_fetched_at", "shadow_etag", "shadow_sha",
  "pending_sync", "pending_upstream", "wrapper_for",
  // project-specific (shown in project section)
  "goal", "boundary", "tools", "spec", "repo", "members",
  // agent-specific
  "workspace", "description",
]);

/** Render project-specific section. filePath is the node's file path (for resolving spec). */
function renderProjectSection(fields: Record<string, any>, filePath: string): void {
  const goal = fields.goal;
  const boundary = fields.boundary;
  const tools = fields.tools;
  const spec = fields.spec;
  const repo = fields.repo;
  const builtFrom = fields.built_from;
  const members = fields.members;

  // Suppress TODO placeholders — stubs with built_from reference the repo instead
  const isGoalTodo = !goal || String(goal).startsWith("TODO");
  const isBoundaryTodo = !boundary || (Array.isArray(boundary) && boundary.length > 0 && String(boundary[0]).startsWith("TODO"));

  const hasAny = (goal && !isGoalTodo) || (boundary && !isBoundaryTodo && boundary.length) ||
    (tools && tools.length) || spec || repo || builtFrom || members;
  if (!hasAny) return;

  console.log(`📋  Project Details`);

  if (builtFrom) {
    console.log(`   📦 Code repo: ${builtFrom}`);
    console.log(`      (See repo dna.yml for canonical goal/boundary)`);
  }

  if (goal && !isGoalTodo) {
    console.log(`   Goal:`);
    const lines = String(goal).trim().split("\n");
    for (const line of lines) {
      console.log(`      ${line}`);
    }
  }

  if (boundary && Array.isArray(boundary) && boundary.length > 0 && !isBoundaryTodo) {
    console.log(`   Boundary:`);
    for (const item of boundary) {
      console.log(`      • ${item}`);
    }
  }

  if (tools && Array.isArray(tools) && tools.length > 0) {
    console.log(`   Tools:`);
    for (const item of tools) {
      console.log(`      • ${item}`);
    }
  }

  if (spec) {
    const specPath = join(dirname(filePath), String(spec));
    console.log(`   Spec:    ${specPath}`);
  }

  if (repo) {
    const repoStr = String(repo);
    // If it's owner/repo form, render as github URL
    const repoUrl = /^[^/]+\/[^/]+$/.test(repoStr) ? `https://github.com/${repoStr}` : repoStr;
    console.log(`   Repo:    ${repoUrl}`);
  }

  if (members && Array.isArray(members) && members.length > 0) {
    console.log(`   Members:`);
    for (const m of members) {
      console.log(`      • ${m}`);
    }
  }

  console.log("");
}

/** Render generic 'Other fields' dump for non-structural frontmatter keys. */
function renderOtherFields(fields: Record<string, any>): void {
  const extras: Array<[string, any]> = [];
  for (const [k, v] of Object.entries(fields)) {
    if (KNOWN_STRUCTURAL_FIELDS.has(k)) continue;
    if (k.startsWith("_")) continue;  // internal
    extras.push([k, v]);
  }
  if (extras.length === 0) return;
  console.log(`📦  Other fields`);
  for (const [k, v] of extras) {
    let rendered: string;
    if (Array.isArray(v)) {
      // Array: join simple values; skip complex objects
      const simpleItems = v.filter(x => typeof x === "string" || typeof x === "number" || typeof x === "boolean");
      const complexCount = v.length - simpleItems.length;
      rendered = simpleItems.map(String).join(", ");
      if (complexCount > 0) rendered += (rendered ? " " : "") + `(+${complexCount} nested)`;
    } else if (v !== null && typeof v === "object") {
      rendered = `(nested object)`;
    } else {
      rendered = String(v);
    }
    console.log(`   ${k}: ${rendered}`);
  }
  console.log("");
}

// --- Subcommands ---

function cmdScan() {
  const t0 = Date.now();
  const g = buildGraph();
  const elapsed = Date.now() - t0;
  const types = new Map<string, number>();
  for (const n of g.nodes.values()) {
    types.set(n.type, (types.get(n.type) || 0) + 1);
  }
  console.log(`🕸️  Mesh scan complete in ${elapsed}ms`);
  console.log(`   Nodes: ${g.nodes.size}`);
  console.log(`   Edges: ${[...g.nodes.values()].reduce((a, n) => a + n.outbound.length, 0)}`);
  console.log(`   Dead links: ${g.lint.deadLinks.length}`);
  console.log(`   Duplicate IDs: ${g.lint.duplicateIds.length}`);
  console.log(`   Missing fields: ${g.lint.missingFields.length}`);
  console.log(`   Non-canonical .yaml: ${g.lint.nonCanonicalExt.length} (prefer .yml)`);
  console.log("");
  console.log("By type:");
  for (const [t, n] of [...types.entries()].sort((a, b) => b[1] - a[1])) {
    console.log(`   ${t.padEnd(15)} ${n}`);
  }
  console.log(`\nCache: ${relPath(CACHE_PATH)}`);
}

function cmdLs(args: string[]) {
  const g = buildGraph();
  let typeFilter: string | null = null;
  let prefixFilter: string | null = null;
  let managedByFilter: string | null = null;
  const positionals: string[] = [];
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--type" || args[i] === "-t") {
      typeFilter = args[i + 1];
      i++;
    } else if (args[i] === "--managed-by") {
      managedByFilter = args[i + 1];
      i++;
    } else if (!args[i].startsWith("-")) {
      positionals.push(args[i]);
    }
  }
  // Positional arg: type name, type prefix, or full dna:// prefix
  if (positionals.length > 0) {
    const pos = positionals[0];
    if (pos.startsWith("dna://")) {
      // e.g. "dna://philosophy" or "dna://project/metuber"
      prefixFilter = pos;
    } else {
      // treat as type prefix - exact or prefix match on type
      prefixFilter = pos;
    }
  }

  // Normalize managed-by filter into expected dna://agent/<slug> form
  let managedByExpected: string | null = null;
  if (managedByFilter) {
    managedByExpected = managedByFilter.startsWith("dna://")
      ? managedByFilter
      : `dna://agent/${managedByFilter}`;
  }

  const nodes = [...g.nodes.values()]
    .filter(n => {
      if (typeFilter && n.type !== typeFilter) return false;
      if (prefixFilter) {
        const p = prefixFilter.toLowerCase();
        if (p.startsWith("dna://")) {
          // match by full id prefix
          if (!n.id.toLowerCase().startsWith(p)) return false;
        } else {
          // match by type prefix
          if (!n.type.toLowerCase().startsWith(p)) return false;
        }
      }
      if (managedByExpected) {
        const mb = n.fields.managed_by;
        const list = Array.isArray(mb) ? mb : (mb ? [mb] : []);
        if (!list.some((v: any) => String(v).toLowerCase() === managedByExpected!.toLowerCase())) return false;
      }
      return true;
    })
    .sort((a, b) => a.id.localeCompare(b.id));
  for (const n of nodes) {
    console.log(`  ${n.id.padEnd(45)} ${n.title || ""}`);
  }
  const filterParts: string[] = [];
  if (typeFilter) filterParts.push(`type=${typeFilter}`);
  if (prefixFilter) filterParts.push(`prefix=${prefixFilter}`);
  if (managedByExpected) filterParts.push(`managed_by=${managedByExpected}`);
  const filterDesc = filterParts.length ? ` (${filterParts.join(", ")})` : "";
  console.log(`\n${nodes.length} node${nodes.length === 1 ? "" : "s"}${filterDesc}`);
}

function cmdFind(args: string[]) {
  const pattern = args[0];
  if (!pattern) { console.error("Usage: dna mesh find <pattern>"); process.exit(1); }
  const g = buildGraph();
  const q = pattern.toLowerCase();
  const nodes = [...g.nodes.values()]
    .filter(n => n.id.toLowerCase().includes(q) || (n.title || "").toLowerCase().includes(q))
    .sort((a, b) => a.id.localeCompare(b.id));
  for (const n of nodes) {
    console.log(`  ${n.id.padEnd(45)} ${n.title || ""}`);
  }
  console.log(`\n${nodes.length} match${nodes.length === 1 ? "" : "es"} for "${pattern}"`);
}

/** Resolve "main" / "me" / "dna://agent/main" to the current agent's id.
 * Detection priority:
 *   1. Env var DNA_AGENT_ID
 *   2. Walk up from cwd looking for dna.yml/dna.yaml with type: agent
 *   3. Error
 * Returns { id, path, source } or throws.
 */
function resolveAgentMain(): { id: string; path: string; source: string } {
  // 1. Env var
  if (process.env.DNA_AGENT_ID) {
    return { id: process.env.DNA_AGENT_ID, path: "(env)", source: "DNA_AGENT_ID env var" };
  }
  // 2. Walk up from cwd
  let dir = process.cwd();
  for (let i = 0; i < 20; i++) {
    for (const fname of ["dna.yml", "dna.yaml"]) {
      const fpath = join(dir, fname);
      if (existsSync(fpath)) {
        try {
          const raw = readFileSync(fpath, "utf-8");
          const fields = (yaml.load(raw) as Record<string, any>) || {};
          if (fields.type === "agent" && fields.id) {
            const id = fields.id.startsWith("dna://") ? fields.id : `dna://agent/${fields.id}`;
            return { id, path: fpath, source: "cwd walk" };
          }
        } catch { /* skip */ }
      }
    }
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  throw new Error("Cannot resolve dna://agent/main - set DNA_AGENT_ID or run from an agent workspace");
}

/** Expand magic aliases: "main", "me", "dna://agent/main" → actual agent id */
function expandId(id: string): string {
  if (id === "main" || id === "me" || id === "dna://agent/main") {
    return resolveAgentMain().id;
  }
  return id;
}

function cmdWhoami() {
  try {
    const { id, path, source } = resolveAgentMain();
    console.log(`🧬 dna://agent/main → ${id}`);
    console.log(`   Path:   ${path}`);
    console.log(`   Source: ${source}`);
  } catch (e: any) {
    console.error(`❌ ${e.message}`);
    process.exit(1);
  }
}

async function cmdShow(args: string[]) {
  const id = expandId(args[0]);
  if (!id) { console.error("Usage: dna mesh show <id>"); process.exit(1); }
  const g = buildGraph();
  let n = g.nodes.get(id);
  if (!n) {
    // Try remote resolution
    const remoteUri = parseRemoteUri(id);
    if (remoteUri) {
      try {
        n = await fetchRemoteDna(remoteUri);
      } catch (err: any) {
        console.error(`❌ ${err.message}`);
        process.exit(1);
      }
    } else {
      console.error(`❌ Node not found: ${id}`);
      // Suggest near matches
      const near = [...g.nodes.keys()].filter(k => k.includes(id.replace("dna://", "")));
      if (near.length) {
        console.error(`Did you mean: ${near.slice(0, 5).join(", ")}`);
      }
      process.exit(1);
    }
  }
  console.log(`🧬 ${n.id}`);
  console.log(`   Type:    ${n.type}`);
  if (n.title) console.log(`   Title:   ${n.title}`);
  console.log(`   File:    ${relPath(n.path)}`);
  // Remote node: show origin info
  if (n.fields._remote_owner) {
    const fromCache = n.fields._remote_fetched_from_cache ? " (from cache)" : " (fresh fetch)";
    console.log(`   🌐  Remote: github.com/${n.fields._remote_owner}/${n.fields._remote_repo}${fromCache}`);
    if (n.fields._remote_original_id) console.log(`   Original id: ${n.fields._remote_original_id}`);
    if (n.fields._remote_branch) console.log(`   Branch: ${n.fields._remote_branch}`);
    if (n.fields._remote_cache_file) console.log(`   Cache: ${relPath(n.fields._remote_cache_file)}`);
  }
  console.log("");

  // Project-specific section
  if (n.type === "project") {
    renderProjectSection(n.fields, n.path);
  }

  // Generic other fields
  renderOtherFields(n.fields);

  // Body content (markdown body for .md or .dna frontmatter files)
  if (n._body && n._body.trim()) {
    console.log("");
    console.log("   ── Content ──");
    for (const line of n._body.split("\n")) {
      console.log(`   ${line}`);
    }
    console.log("");
  }

  console.log(`   Outbound (${n.outbound.length}):`);
  const kindGroups = new Map<string, MeshEdge[]>();
  for (const edge of n.outbound) {
    if (!kindGroups.has(edge.kind)) kindGroups.set(edge.kind, []);
    kindGroups.get(edge.kind)!.push(edge);
  }
  // Print in canonical order, then any remaining kinds not in order list
  const seenKinds = new Set<string>();
  const displayOrder = [...KIND_DISPLAY_ORDER, ...[...kindGroups.keys()].filter(k => !KIND_DISPLAY_ORDER.includes(k))];
  for (const k of displayOrder) {
    const edges = kindGroups.get(k);
    if (!edges) continue;
    seenKinds.add(k);
    console.log(`     [${k}] (${edges.length})`);
    for (const edge of edges) {
      const targetNode = g.nodes.get(edge.target);
      const dead = targetNode ? "" : " ⚠️ dead link";
      const fileSuffix = edge.sourceFile ? ` (${edge.sourceFile})` : "";
      console.log(`       → ${edge.target}${targetNode?.title ? ` - ${targetNode.title}` : ""}${dead}${fileSuffix}`);
    }
  }
  const inb = g.inbound.get(n.id);
  const inbEdges = g.inboundEdges.get(n.id) || [];
  console.log("");
  console.log(`   Inbound (${inb?.size || 0}):`);
  if (inbEdges.length) {
    const kindGroups2 = new Map<string, typeof inbEdges>();
    for (const e of inbEdges) {
      if (!kindGroups2.has(e.kind)) kindGroups2.set(e.kind, []);
      kindGroups2.get(e.kind)!.push(e);
    }
    const inbDisplayOrder = [...KIND_DISPLAY_ORDER, ...[...kindGroups2.keys()].filter(k => !KIND_DISPLAY_ORDER.includes(k))];
    for (const k of inbDisplayOrder) {
      const edges = kindGroups2.get(k);
      if (!edges) continue;
      console.log(`     [${k}] (${edges.length})`);
      for (const e of edges) {
        const srcNode = g.nodes.get(e.from);
        const fileSuffix = e.sourceFile ? ` (${e.sourceFile})` : "";
        console.log(`       ← ${e.from}${srcNode?.title ? ` - ${srcNode.title}` : ""}${fileSuffix}`);
      }
    }
  }
}

function cmdLinks(args: string[]) {
  const id = expandId(args[0]);
  if (!id) { console.error("Usage: dna mesh links <id>"); process.exit(1); }
  const g = buildGraph();
  const n = g.nodes.get(id);
  if (!n) { console.error(`❌ Node not found: ${id}`); process.exit(1); }
  for (const edge of n.outbound) {
    const t = g.nodes.get(edge.target);
    console.log(`[${edge.kind}] ${edge.target}${t?.title ? ` - ${t.title}` : " (unresolved)"}`);
  }
}

function cmdRefs(args: string[]) {
  // --verb and --kind are aliases (--verb preferred for typed verbs, --kind kept for compat)
  const verbFilter = (() => {
    const vi = args.indexOf("--verb"); if (vi >= 0) return args[vi+1];
    const ki = args.indexOf("--kind"); if (ki >= 0) return args[ki+1];
    return null;
  })();
  const rawId = args.find(a => !a.startsWith("--") && a !== verbFilter);
  const id = rawId ? expandId(rawId) : undefined;
  if (!id) { console.error("Usage: dna mesh refs [--verb <verb>] <id>"); process.exit(1); }
  const g = buildGraph();
  const inbEdges = g.inboundEdges.get(id) || [];
  const filtered = verbFilter ? inbEdges.filter(e => e.kind === verbFilter) : inbEdges;
  if (filtered.length === 0) {
    console.log(`(No inbound references to ${id}${verbFilter ? ` of verb=${verbFilter}` : ""})`);
    return;
  }
  const kindGroups = new Map<string, typeof filtered>();
  for (const e of filtered) {
    if (!kindGroups.has(e.kind)) kindGroups.set(e.kind, []);
    kindGroups.get(e.kind)!.push(e);
  }
  const displayOrder = [...KIND_DISPLAY_ORDER, ...[...kindGroups.keys()].filter(k => !KIND_DISPLAY_ORDER.includes(k))];
  for (const k of displayOrder) {
    const edges = kindGroups.get(k);
    if (!edges) continue;
    console.log(`[${k}] (${edges.length})`);
    for (const e of edges) {
      const s = g.nodes.get(e.from);
      const fileSuffix = e.sourceFile ? ` (${e.sourceFile})` : "";
      console.log(`  ← ${e.from}${s?.title ? ` - ${s.title}` : ""}${fileSuffix}`);
    }
  }
}

function cmdImpact(args: string[]) {
  const id = expandId(args[0]);
  if (!id) { console.error("Usage: dna mesh impact <id>"); process.exit(1); }
  const g = buildGraph();
  // BFS over inbound edges
  const visited = new Set<string>();
  const layers: Array<Array<{ id: string; from: string }>> = [];
  let frontier: Array<{ id: string; from: string }> = [{ id, from: "" }];
  visited.add(id);
  while (frontier.length) {
    const nextFrontier: Array<{ id: string; from: string }> = [];
    for (const item of frontier) {
      const inb = g.inbound.get(item.id);
      if (!inb) continue;
      for (const src of inb) {
        if (visited.has(src)) continue;
        visited.add(src);
        nextFrontier.push({ id: src, from: item.id });
      }
    }
    if (nextFrontier.length) layers.push(nextFrontier);
    frontier = nextFrontier;
  }
  console.log(`🌊 Impact of changing ${id}:`);
  if (layers.length === 0) {
    console.log("   (no nodes affected)");
    return;
  }
  layers.forEach((layer, i) => {
    console.log(`\n  Layer ${i + 1} (${layer.length}):`);
    for (const item of layer) {
      const n = g.nodes.get(item.id);
      console.log(`    ${item.id}${n?.title ? ` - ${n.title}` : ""}`);
    }
  });
  console.log(`\n  Total affected: ${visited.size - 1}`);
}

/** Scan for cross-agent dependencies:
 * 1. Inject patterns in .md files that resolve to another agent's local DNA
 * 2. Mesh link edges where source and target belong to different agents
 */
function scanCrossAgentDeps(graph: MeshGraph): void {
  const workspacesDir = join(HOME, ".openclaw/workspaces");
  const globalDnaDir = join(HOME, ".openclaw/.dna");

  // Helper: extract agent name from a file path under workspaces/<agent>/
  function agentFromPath(p: string): string | null {
    if (!p.startsWith(workspacesDir + "/")) return null;
    const rel = p.slice(workspacesDir.length + 1);
    const slash = rel.indexOf("/");
    return slash === -1 ? rel : rel.slice(0, slash);
  }

  // ---- Part 1: inject references ----
  // Find all .md files under ~/.openclaw/workspaces/*/
  function walkMd(dir: string, out: string[] = []): string[] {
    if (!existsSync(dir)) return out;
    let entries: string[];
    try { entries = readdirSync(dir); } catch { return out; }
    for (const name of entries) {
      if (name.startsWith(".")) continue;
      const full = join(dir, name);
      let st;
      try { st = statSync(full); } catch { continue; }
      if (st.isDirectory()) walkMd(full, out);
      else if (st.isFile() && name.endsWith(".md")) out.push(full);
    }
    return out;
  }

  const mdFiles = walkMd(workspacesDir);
  // Pattern: «dna (convention|philosophy|protocol|flow) --inject <slug>»  or  {{dna ... --inject <slug>}}
  // Also handles colon variant: «dna:convention --inject <slug>»
  const injectRe = /[«{]{1,2}dna[:\s]+(?:convention|philosophy|protocol|flow)\s+--inject\s+([\w-]+)[»}]{1,2}/g;

  for (const mdFile of mdFiles) {
    const sourceAgent = agentFromPath(mdFile);
    if (!sourceAgent) continue;
    let content: string;
    try { content = readFileSync(mdFile, "utf-8"); } catch { continue; }

    let m: RegExpExecArray | null;
    injectRe.lastIndex = 0;
    while ((m = injectRe.exec(content)) !== null) {
      const slug = m[1];
      // Check if this slug lives in another agent's local .dna (not global)
      // Walk workspaces to find if any agent other than sourceAgent has this slug
      let ownerAgent: string | null = null;
      if (existsSync(workspacesDir)) {
        let agents: string[];
        try { agents = readdirSync(workspacesDir); } catch { agents = []; }
        for (const ag of agents) {
          if (ag === sourceAgent) continue;
          const agDna = join(workspacesDir, ag, ".dna");
          if (!existsSync(agDna)) continue;
          // Check subdirs: conventions, philosophies, protocols, flows (+ root)
          const dirsToCheck = [agDna, ...[
            "conventions", "philosophies", "protocols", "flows",
          ].map(d => join(agDna, d))];
          for (const d of dirsToCheck) {
            if (!existsSync(d)) continue;
            // Look for <slug>.md, <slug>.dna, <slug>.dna.yml, <slug>.yml
            for (const ext of [".md", ".dna", ".dna.yml", ".yml", ".yaml"]) {
              if (existsSync(join(d, slug + ext))) {
                ownerAgent = ag;
                break;
              }
            }
            if (ownerAgent) break;
          }
          if (ownerAgent) break;
        }
      }
      if (!ownerAgent) {
        // Also check if it lives in global .dna — if so, skip (not cross-agent)
        // If not found anywhere, also skip (can't determine ownership)
        continue;
      }
      graph.lint.crossAgentDeps.push({
        kind: "inject",
        file: mdFile,
        slug,
        sourceAgent,
        targetAgent: ownerAgent,
      });
    }
  }

  // ---- Part 2: mesh link cross-agent edges ----
  for (const node of graph.nodes.values()) {
    const srcAgent = agentFromPath(node.path);
    if (!srcAgent) continue;  // not a workspace node
    for (const edge of node.outbound) {
      const targetNode = graph.nodes.get(edge.target);
      if (!targetNode) continue;
      // Skip global DNA nodes — neutral
      if (targetNode.path.startsWith(globalDnaDir + "/")) continue;
      const tgtAgent = agentFromPath(targetNode.path);
      if (!tgtAgent) continue;
      if (tgtAgent === srcAgent) continue;
      graph.lint.crossAgentDeps.push({
        kind: "link",
        file: node.path,
        sourceId: node.id,
        targetId: edge.target,
        sourceAgent: srcAgent,
        targetAgent: tgtAgent,
      });
    }
  }
}

/** Tarjan SCC - returns all SCCs with size > 1, plus self-loops. */
function detectCycles(g: MeshGraph): Array<string[]> {
  const ids = [...g.nodes.keys()];
  const index: Map<string, number> = new Map();
  const lowlink: Map<string, number> = new Map();
  const onStack: Map<string, boolean> = new Map();
  const stack: string[] = [];
  const sccs: Array<string[]> = [];
  let counter = 0;

  function strongconnect(v: string) {
    index.set(v, counter);
    lowlink.set(v, counter);
    counter++;
    stack.push(v);
    onStack.set(v, true);
    const node = g.nodes.get(v);
    if (node) {
      for (const w of node.outbound.map(e => e.target)) {
        if (!g.nodes.has(w)) continue;  // skip dead links
        if (!index.has(w)) {
          strongconnect(w);
          lowlink.set(v, Math.min(lowlink.get(v)!, lowlink.get(w)!));
        } else if (onStack.get(w)) {
          lowlink.set(v, Math.min(lowlink.get(v)!, index.get(w)!));
        }
      }
    }
    if (lowlink.get(v) === index.get(v)) {
      const scc: string[] = [];
      let w: string;
      do {
        w = stack.pop()!;
        onStack.set(w, false);
        scc.push(w);
      } while (w !== v);
      // Self-loop: size 1 but node references itself
      const selfLoop = scc.length === 1 && (g.nodes.get(scc[0])?.outbound.some(e => e.target === scc[0]) ?? false);
      if (scc.length > 1 || selfLoop) sccs.push(scc);
    }
  }

  for (const id of ids) {
    if (!index.has(id)) strongconnect(id);
  }
  return sccs;
}

function cmdLint(args: string[]) {
  const strict = args.includes("--strict");
  const showCycles = args.includes("--show-cycles");
  const g = buildGraph();

  // --- Check 1: Cycles (Tarjan SCC, only stored when --show-cycles requested) ---
  if (showCycles) g.lint.cycles = detectCycles(g);

  // --- Check 2: Stale shadows ---
  const now = Date.now();
  const THIRTY_DAYS_MS = 30 * 24 * 60 * 60 * 1000;
  for (const node of g.nodes.values()) {
    if (node.fields.shadow === true && node.fields.shadow_fetched_at) {
      const fetched = new Date(node.fields.shadow_fetched_at).getTime();
      if (!isNaN(fetched)) {
        const age_days = Math.floor((now - fetched) / (24 * 60 * 60 * 1000));
        if (age_days > 30) {
          g.lint.staleShadows.push({ id: node.id, path: node.path, age_days });
        }
      }
    }
  }

  // --- Check 2b: Shadow purity checks ---
  const FORBIDDEN_SHADOW_FIELDS = new Set([
    "type", "title", "description", "command", "homepage", "status", "version", "tags",
    "links", "manages", "managed_by", "governed_by", "governs",
    "runs_on", "hosts", "deploys", "deployed_by", "depends_on", "used_by",
    "derives_from", "derived_into", "mentions", "mentioned_by", "binds", "bound_by",
    "executes", "executed_by",
  ]);
  const PACKAGE_PREFIX = "package_";
  const SEVEN_DAYS_MS = 7 * 24 * 60 * 60 * 1000;
  for (const node of g.nodes.values()) {
    if (node.fields.shadow !== true) continue;
    const origin = node.fields.shadow_origin;
    // Missing origin
    if (!origin || (typeof origin === "string" && !origin.trim())) {
      g.lint.shadowMissingOrigin.push({ id: node.id, path: node.path });
      continue;
    }
    // Contamination: forbidden local fields - re-read file to check pre-merge frontmatter
    try {
      const rawFile = readFileSync(node.path, "utf-8");
      const { meta: localMeta } = parseFrontmatter(rawFile);
      for (const [k] of Object.entries(localMeta)) {
        if (FORBIDDEN_SHADOW_FIELDS.has(k) || k.startsWith(PACKAGE_PREFIX)) {
          g.lint.shadowContaminations.push({ id: node.id, path: node.path, field: k });
        }
      }
    } catch { /* skip */ }

    // Stale cache (7 days)
    if (node.fields.shadow_fetched_at && typeof node.fields.shadow_fetched_at === "string" && node.fields.shadow_fetched_at.trim()) {
      const fetched = new Date(node.fields.shadow_fetched_at).getTime();
      if (!isNaN(fetched)) {
        const age_days = Math.floor((now - fetched) / (24 * 60 * 60 * 1000));
        if (age_days > 7) {
          g.lint.staleShadows.push({ id: node.id, path: node.path, age_days });
        }
      }
    }
  }

  // --- Check 3: ID-vs-path mismatch ---
  for (const node of g.nodes.values()) {
    const m = node.id.match(/^dna:\/\/(agent|realm)\/([^/]+)$/);
    if (!m) continue;
    const [, nodeType, name] = m;
    const p = node.path;
    let expectedPaths: string[];
    if (nodeType === "agent") {
      expectedPaths = [
        join(HOME, `.openclaw/workspaces/${name}/dna.yml`),
        join(HOME, `.openclaw/workspaces/${name}/dna.yaml`),
        join(HOME, `.openclaw/workspace/dna.yml`),  // claw special
        join(HOME, `.openclaw/workspace/dna.yaml`),
      ];
    } else {  // realm
      expectedPaths = [
        join(HOME, `.openclaw/realms/${name}/dna.yml`),
        join(HOME, `.openclaw/realms/${name}/dna.yaml`),
      ];
    }
    if (!expectedPaths.some(ep => p === ep)) {
      g.lint.idPathMismatches.push({
        id: node.id,
        path: node.path,
        expected: expectedPaths[0].replace(HOME + "/", ""),
      });
    }
  }

  // --- Check 4: Type-vs-directory mismatch ---
  const nodesDnaDir = join(HOME, ".openclaw/.dna/nodes");
  for (const node of g.nodes.values()) {
    if (!node.path.startsWith(nodesDnaDir)) continue;
    const rel = node.path.slice(nodesDnaDir.length + 1);  // e.g. "agent/nebula/dna.yml"
    const dirType = rel.split("/")[0];
    if (dirType && node.type !== dirType) {
      g.lint.typeDirMismatches.push({ id: node.id, path: node.path, dir_type: dirType });
    }
  }

  // --- Check 5: Bidirectional link check (structural pairs) ---
  // These relationships REQUIRE back-links in both directions.
  const STRUCTURAL_PAIRS: Array<[string, string]> = [
    ["agent", "realm"],
    ["agent", "maintained-oss"],
    ["agent", "tool"],
    ["agent", "site"],
    ["host", "middleware"],
    ["site", "maintained-oss"],
    ["realm", "middleware"],
    ["flow", "agent"],
  ];
  // Build a set for O(1) lookup: "typeA:typeB" (canonicalised so A <= B)
  const structuralSet = new Set<string>();
  for (const [a, b] of STRUCTURAL_PAIRS) {
    const key = [a, b].sort().join(":");
    structuralSet.add(key);
  }
  // Self-loop detection (separate from back-link check)
  for (const node of g.nodes.values()) {
    if (node.outbound.some(e => e.target === node.id)) {
      g.lint.missingBackLinks.push({ source: node.id, target: node.id });
    }
  }
  // Back-link enforcement:
  // 1. Legacy structural pairs (links: with no verb) - same as before
  // 2. Typed BIDIRECTIONAL_VERBS - if X has managed_by:Y, then Y must have manages:X
  const SKIP_BACK_LINK_KINDS = new Set(["governance", ...ONE_WAY_VERBS]);
  // Collect links: (generic) that need back-link check
  for (const node of g.nodes.values()) {
    for (const edge of node.outbound) {
      const target = edge.target;
      if (target === node.id) continue;
      const targetNode = g.nodes.get(target);
      if (!targetNode) continue;

      if (edge.kind === "link") {
        // Legacy back-link: only enforce for known structural type-pairs
        const pairKey = [node.type, targetNode.type].sort().join(":");
        if (!structuralSet.has(pairKey)) continue;
        if (!targetNode.outbound.some(e => e.target === node.id)) {
          g.lint.missingBackLinks.push({ source: node.id, target: targetNode.id });
        }
      } else if (BIDIRECTIONAL_VERBS.has(edge.kind)) {
        // Typed verb back-link: target must declare the inverse verb pointing back
        const inverseVerb = VERB_INVERSE[edge.kind]!;
        const hasInverse = targetNode.outbound.some(e => e.target === node.id && e.kind === inverseVerb);
        if (!hasInverse) {
          g.lint.missingBackLinks.push({ source: node.id, target: targetNode.id });
        }
      } else if (SKIP_BACK_LINK_KINDS.has(edge.kind)) {
        // one-way / citation - no back-link required
        continue;
      }
    }
  }

  // Lint NOTICE: links: entries should be upgraded to typed verbs
  const linksNoticeCount = [...g.nodes.values()].reduce((sum, n) => {
    const linksEdges = n.outbound.filter(e => e.kind === "link");
    return sum + linksEdges.length;
  }, 0);
  if (linksNoticeCount > 0) {
    console.log(`\ni️  NOTICE: ${linksNoticeCount} generic \`links:\` edge(s) found. Run \`dna mesh migrate-verbs\` to upgrade to typed verbs.`);
  }

  // --- Check 6: Title presence ---
  for (const node of g.nodes.values()) {
    if (!node.title) g.lint.missingTitles.push(node.id);
  }

  // --- Check 7: Cross-agent dependencies (informational only) ---
  scanCrossAgentDeps(g);

  // --- Output ---
  const { deadLinks, duplicateIds, missingFields, nonCanonicalExt, cycles,
          staleShadows, idPathMismatches, typeDirMismatches, missingBackLinks, missingTitles,
          shadowContaminations, shadowMissingOrigin, crossAgentDeps } = g.lint;
  let hasErrors = false;

  if (deadLinks.length) {
    hasErrors = true;
    console.log(`\n⚠️  Dead links (${deadLinks.length}):`);
    for (const dl of deadLinks) {
      console.log(`   ${dl.from} → ${dl.to}`);
    }
  }
  if (duplicateIds.length) {
    hasErrors = true;
    console.log(`\n⚠️  Duplicate IDs (${duplicateIds.length}):`);
    for (const d of duplicateIds) {
      console.log(`   ${d.id}`);
      for (const p of d.paths) console.log(`     ${relPath(p)}`);
    }
  }
  if (missingFields.length) {
    console.log(`\n⚠️  Files with mesh-shape but missing required fields (${missingFields.length}):`);
    for (const m of missingFields.slice(0, 20)) {
      console.log(`   ${relPath(m.path)} (missing: ${m.missing.join(", ")})`);
    }
    if (missingFields.length > 20) console.log(`   ... and ${missingFields.length - 20} more`);
  }
  if (showCycles) {
    if (cycles.length) {
      console.log(`\n🔄  Cycles (${cycles.length} SCC - debug only, bidirectional back-links are expected):`);
      for (const scc of cycles) {
        console.log(`   [${scc.join(" → ")}]`);
      }
    } else {
      console.log(`\n✅  No cycles detected`);
    }
  }
  if (staleShadows.length) {
    console.log(`\n⏰  Stale shadows (>7 days, ${staleShadows.length}):`);
    for (const s of staleShadows) {
      console.log(`   ${s.id}  (${s.age_days} days old)  ${relPath(s.path)}`);
    }
  } else {
    console.log(`✅  No stale shadows`);
  }
  if (shadowMissingOrigin.length) {
    hasErrors = true;
    console.log(`\n❌  Shadow missing origin (${shadowMissingOrigin.length} ERROR):`);
    for (const s of shadowMissingOrigin) {
      console.log(`   ${s.id}  ${relPath(s.path)}`);
    }
  }
  if (shadowContaminations.length) {
    hasErrors = true;
    console.log(`\n❌  Shadow contamination - forbidden local fields (${shadowContaminations.length} ERROR):`);
    for (const s of shadowContaminations) {
      console.log(`   ${s.id}  field=${s.field}  ${relPath(s.path)}`);
    }
  }

  if (idPathMismatches.length) {
    console.log(`\n📍  ID-vs-path mismatches (${idPathMismatches.length}):`);
    for (const m of idPathMismatches) {
      console.log(`   ${m.id}`);
      console.log(`     actual:   ${relPath(m.path)}`);
      console.log(`     expected: ${m.expected}`);
    }
  } else {
    console.log(`✅  No ID-vs-path mismatches`);
  }
  if (typeDirMismatches.length) {
    console.log(`\n📁  Type-vs-directory mismatches (${typeDirMismatches.length}):`);
    for (const m of typeDirMismatches) {
      console.log(`   ${m.id}  (dir_type=${m.dir_type}, node_type=${g.nodes.get(m.id)?.type})  ${relPath(m.path)}`);
    }
  } else {
    console.log(`✅  No type-vs-directory mismatches`);
  }
  // Separate self-loops from missing back-links
  const selfLoops = missingBackLinks.filter(bl => bl.source === bl.target);
  const realMissingBackLinks = missingBackLinks.filter(bl => bl.source !== bl.target);

  if (realMissingBackLinks.length) {
    hasErrors = true;
    // Group by target for suggested patches
    const byTarget = new Map<string, string[]>();
    for (const bl of realMissingBackLinks) {
      if (!byTarget.has(bl.target)) byTarget.set(bl.target, []);
      byTarget.get(bl.target)!.push(bl.source);
    }
    console.log(`\n🔗  Missing back-links (${realMissingBackLinks.length}):`);
    for (const bl of realMissingBackLinks) {
      console.log(`   ${bl.source} → ${bl.target}  (back-link missing in ${bl.target})`);
    }
    for (const [target, sources] of byTarget) {
      const targetNode = g.nodes.get(target);
      const rel = targetNode ? relPath(targetNode.path) : target;
      console.log(`\n   Suggested patch for ${target}:`);
      console.log(`     File: ${rel}`);
      for (const src of sources) {
        console.log(`     Add to links: ${src}`);
      }
    }
  } else {
    console.log(`✅  No missing back-links`);
  }
  if (selfLoops.length) {
    hasErrors = true;
    console.log(`\n⚠️  Self-loops (${selfLoops.length}):`);
    for (const sl of selfLoops) {
      console.log(`   ${sl.source} links to itself`);
    }
  }
  if (nonCanonicalExt.length) {
    console.log(`\ni️  Non-canonical extension (.yaml; .yml is canonical) - ${nonCanonicalExt.length} files`);
    console.log("   (backward-compat OK; rename batch is a future task)");
  }
  if (missingTitles.length) {
    console.log(`\n📝  Missing titles (${missingTitles.length} nodes):`);
    for (const id of missingTitles.slice(0, 20)) console.log(`   ${id}`);
    if (missingTitles.length > 20) console.log(`   ... and ${missingTitles.length - 20} more`);
  } else {
    console.log(`✅  All nodes have titles`);
  }

  // --- New: implicit type (legacy gov files without explicit `type:` in frontmatter) ---
  const { implicitTypeFiles, extensionHintMismatches } = g.lint;
  if (implicitTypeFiles.length) {
    console.log(`\n⚠️  Files with implicit type (legacy gov layout, ${implicitTypeFiles.length} files - add explicit \`type:\` to frontmatter):`);
    for (const p of implicitTypeFiles.slice(0, 30)) {
      const parentDir = basename(dirname(p));
      const hint = LEGACY_GOV_DIR_TYPE_HINT[parentDir] || "?";
      console.log(`   [${hint}] ${relPath(p)}`);
    }
    if (implicitTypeFiles.length > 30) console.log(`   ... and ${implicitTypeFiles.length - 30} more`);
    console.log(`   Run: dna mesh upgrade-legacy --apply  to auto-inject type: frontmatter`);
  } else {
    console.log(`✅  All governance files have explicit type: in frontmatter`);
  }
  if (extensionHintMismatches.length) {
    console.log(`\n⚠️  Extension hint mismatches (*.dna.md with no frontmatter, ${extensionHintMismatches.length} files):`);
    for (const p of extensionHintMismatches) console.log(`   ${relPath(p)}`);
  }
  // Orphan governance: philosophy/convention/flow with no inbound
  // Nodes with `scope: global` or any `governs` outbound edge are not orphans.
  const govTypes = new Set(["philosophy", "convention", "flow", "protocol"]);
  const orphans = [...g.nodes.values()].filter(n =>
    govTypes.has(n.type) &&
    !(g.inbound.get(n.id)?.size) &&
    n.fields.scope !== "global" &&
    !n.outbound.some(e => e.kind === "governs")
  );
  if (orphans.length) {
    console.log(`\ni️  Orphan governance nodes (${orphans.length}, no inbound refs):`);
    for (const o of orphans.slice(0, 20)) console.log(`   ${o.id}`);
    if (orphans.length > 20) console.log(`   ... and ${orphans.length - 20} more`);
  }
  if (crossAgentDeps.length) {
    console.log(`\nℹ️  Cross-agent dependencies (${crossAgentDeps.length}):`);
    for (const dep of crossAgentDeps) {
      const fileRel = dep.file.replace(HOME + "/", "");
      if (dep.kind === "inject") {
        console.log(`   [inject] ${fileRel} \u2192 ${dep.slug} (owned by: ${dep.targetAgent})`);
      } else {
        const src = dep.sourceId ?? fileRel;
        const tgt = dep.targetId ?? `(agent: ${dep.targetAgent})`;
        console.log(`   [link]   ${src} \u2192 ${tgt}`);
      }
    }
  }
  if (!hasErrors && !deadLinks.length && !duplicateIds.length) {
    console.log("\n✅ Lint clean (no errors).");
  }
  if (strict && (deadLinks.length || duplicateIds.length || hasErrors)) {
    console.log("\n❌ --strict: exiting 1 (errors found)");
    process.exit(1);
  }
}

async function cmdHeal(args: string[]) {
  // --shadows is an alias for sync-shadows --apply
  if (args.includes("--shadows")) {
    const rest = args.filter(a => a !== "--shadows");
    await cmdSyncShadows(["--apply", ...rest]);
    return;
  }

  const backLinks = args.includes("--back-links");
  const apply = args.includes("--apply");

  if (!backLinks) {
    console.error("Usage: dna mesh heal --back-links [--apply]  |  dna mesh heal --shadows");
    process.exit(1);
  }

  const g = buildGraph();

  // Reuse same structural pair logic from lint
  const STRUCTURAL_PAIRS: Array<[string, string]> = [
    ["agent", "realm"],
    ["agent", "maintained-oss"],
    ["agent", "tool"],
    ["agent", "site"],
    ["host", "middleware"],
    ["site", "maintained-oss"],
    ["realm", "middleware"],
    ["flow", "agent"],
  ];
  const structuralSet = new Set<string>();
  for (const [a, b] of STRUCTURAL_PAIRS) {
    structuralSet.add([a, b].sort().join(":"));
  }

  // Collect missing back-links
  const missing = new Map<string, Array<{ source: string; inverseVerb: string }>>(); // target id -> patches
  const SKIP_HEAL_KINDS = new Set(["governance", ...ONE_WAY_VERBS]);
  for (const node of g.nodes.values()) {
    for (const edge of node.outbound) {
      const target = edge.target;
      if (target === node.id) continue;
      if (SKIP_HEAL_KINDS.has(edge.kind)) continue;
      const targetNode = g.nodes.get(target);
      if (!targetNode) continue;

      if (edge.kind === "link") {
        // Legacy: structural type-pair check
        const pairKey = [node.type, targetNode.type].sort().join(":");
        if (!structuralSet.has(pairKey)) continue;
        if (!targetNode.outbound.some(e => e.target === node.id)) {
          if (!missing.has(target)) missing.set(target, []);
          missing.get(target)!.push({ source: node.id, inverseVerb: "links" });
        }
      } else if (BIDIRECTIONAL_VERBS.has(edge.kind)) {
        const inverseVerb = VERB_INVERSE[edge.kind]!;
        const hasInverse = targetNode.outbound.some(e => e.target === node.id && e.kind === inverseVerb);
        if (!hasInverse) {
          if (!missing.has(target)) missing.set(target, []);
          missing.get(target)!.push({ source: node.id, inverseVerb });
        }
      }
    }
  }

  if (missing.size === 0) {
    console.log("✅  No missing back-links - nothing to heal.");
    return;
  }

  if (!apply) {
    console.log(`🔗  Dry-run: would add back-links to ${missing.size} node(s):\n`);
  } else {
    console.log("⚠️  WARNING: js-yaml dump will lose inline comments. Proceeding with --apply.\n");
  }

  for (const [targetId, patches] of missing) {
    const targetNode = g.nodes.get(targetId)!;
    const filePath = targetNode.path;
    const isMd = filePath.endsWith(".md");
    console.log(`  → ${targetId}  (${relPath(filePath)})`);
    for (const p of patches) {
      console.log(`     + ${p.inverseVerb}: ${p.source}`);
    }

    if (!apply) continue;

    // Read & patch
    const raw = readFileSync(filePath, "utf-8");

    function applyPatches(fm: Record<string, any>) {
      for (const p of patches) {
        if (p.inverseVerb === "links") {
          if (!Array.isArray(fm.links)) fm.links = [];
          if (!fm.links.includes(p.source)) fm.links.push(p.source);
        } else {
          // typed verb field
          const existing = fm[p.inverseVerb];
          if (existing == null) {
            fm[p.inverseVerb] = p.source;
          } else if (Array.isArray(existing)) {
            if (!existing.includes(p.source)) existing.push(p.source);
          } else if (typeof existing === "string") {
            if (existing !== p.source) fm[p.inverseVerb] = [existing, p.source];
          }
        }
      }
    }

    if (isMd) {
      const fmMatch = raw.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n([\s\S]*)$/);
      if (!fmMatch) { console.log(`     ❌ Cannot parse frontmatter in ${filePath}`); continue; }
      const [, fmRaw, body] = fmMatch;
      let fm: Record<string, any>;
      try { fm = (yaml.load(fmRaw) as Record<string, any>) || {}; } catch { console.log(`     ❌ YAML parse error`); continue; }
      applyPatches(fm);
      writeFileSync(filePath, `---\n${yaml.dump(fm, { lineWidth: 120, noRefs: true })}---\n${body}`, "utf-8");
    } else {
      let fields: Record<string, any>;
      try { fields = (yaml.load(raw) as Record<string, any>) || {}; } catch { console.log(`     ❌ YAML parse error`); continue; }
      applyPatches(fields);
      writeFileSync(filePath, yaml.dump(fields, { lineWidth: 120, noRefs: true }), "utf-8");
    }
    console.log(`     ✅ Written`);
  }

  if (!apply) {
    console.log(`\nRe-run with --apply to write changes.`);
  } else {
    console.log(`\n✅  Heal complete.`);
  }
}

// --- sync-shadows ---

/** Parse GitHub owner/repo from a github.com URL. Returns null if not parseable. */
function parseGithubOwnerRepo(url: string): string | null {
  // github.com URLs
  const m = url.match(/github\.com[/:]([^/]+\/[^/?#.]+)/);
  if (m) return m[1].replace(/\.git$/, "");
  // raw.githubusercontent.com URLs
  const r = url.match(/raw\.githubusercontent\.com\/([^/]+\/[^/]+)/);
  if (r) return r[1].replace(/\.git$/, "");
  return null;
}

/** Convert GitHub blob URL to raw.githubusercontent.com URL. */
function toRawGithubUrl(url: string): string {
  return url.replace(
    /https:\/\/github\.com\/([^/]+)\/([^/]+)\/blob\/([^/]+)\/(.*)/,
    "https://raw.githubusercontent.com/$1/$2/$3/$4"
  );
}

/** Fetch URL content with 5s timeout using built-in fetch. Returns null on error/non-200. */
async function fetchUrl(url: string): Promise<string | null> {
  const rawUrl = toRawGithubUrl(url);
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 5000);
    const res = await fetch(rawUrl, { signal: controller.signal, redirect: "follow" });
    clearTimeout(timer);
    if (res.status === 200) return await res.text();
    if (res.status === 304) return null;  // not modified
    return null;
  } catch {
    return null;
  }
}

/** Fetch file content from a GitHub repo - tries fetch first, falls back to gh api. Returns null if not found or error. */
async function ghFetchFileContent(ownerRepo: string, filePath: string): Promise<string | null> {
  // Try native fetch first (raw URL)
  const rawUrl = `https://raw.githubusercontent.com/${ownerRepo}/main/${filePath}`;
  const result = await fetchUrl(rawUrl);
  if (result) return result;
  // fallback: try master branch
  const rawUrlMaster = `https://raw.githubusercontent.com/${ownerRepo}/master/${filePath}`;
  const result2 = await fetchUrl(rawUrlMaster);
  if (result2) return result2;
  // fallback: gh api (for private repos)
  try {
    const raw = execSync(
      `gh api repos/${ownerRepo}/contents/${filePath} --jq .content 2>/dev/null`,
      { encoding: "utf-8", timeout: 15000 }
    ).trim();
    if (!raw || raw === "null" || raw === "") return null;
    return Buffer.from(raw.replace(/\n/g, ""), "base64").toString("utf-8");
  } catch {
    return null;
  }
}

/** Simple line-set diff for display. */
function simpleDiff(oldStr: string, newStr: string): string {
  const oldLines = oldStr.split("\n");
  const newLines = newStr.split("\n");
  const oldSet = new Set(oldLines);
  const newSet = new Set(newLines);
  const lines: string[] = [];
  for (const l of oldLines) { if (!newSet.has(l)) lines.push(`- ${l}`); }
  for (const l of newLines) { if (!oldSet.has(l)) lines.push(`+ ${l}`); }
  return lines.join("\n");
}

// Fields that belong to the local shadow - never overwritten from upstream
const SHADOW_LOCAL_FIELDS = new Set([
  "shadow", "shadow_origin", "shadow_repo_path", "shadow_fetched_at", "shadow_source",
]);

async function cmdSyncShadows(args: string[]) {
  const applyMode = args.includes("--apply");
  const filterIdx = args.indexOf("--filter");
  const filterStr = filterIdx !== -1 ? args[filterIdx + 1] : null;

  if (!applyMode) {
    console.log("🔍  DRY-RUN mode (use --apply to write changes)\n");
  } else {
    console.log("✍️   APPLY mode - shadow files will be rewritten\n");
  }

  const g = buildGraph();
  let shadows = [...g.nodes.values()].filter(n =>
    n.fields.shadow === true && typeof n.fields.shadow_origin === "string"
  );

  if (filterStr) {
    const before = shadows.length;
    shadows = shadows.filter(n => n.id.includes(filterStr));
    console.log(`Filter "${filterStr}" → ${shadows.length}/${before} shadow(s)\n`);
  } else {
    console.log(`Found ${shadows.length} shadow node(s) with shadow_origin\n`);
  }

  let checked = 0, updated = 0, skipped = 0, errors = 0;

  for (const shadow of shadows) {
    checked++;
    const originUrl: string = shadow.fields.shadow_origin;
    const ownerRepo = parseGithubOwnerRepo(originUrl);

    console.log(`🔄  ${shadow.id}`);
    console.log(`    origin: ${originUrl}`);

    if (!ownerRepo) {
      console.log(`   ⚠️  shadow_origin not parseable as GitHub URL - skip`);
      errors++;
      continue;
    }

    // Try dna.yml first, fall back to dna.yaml
    let upstreamContent: string | null = null;
    let upstreamFile = "dna.yml";
    try {
      upstreamContent = await ghFetchFileContent(ownerRepo, "dna.yml");
      if (!upstreamContent) {
        upstreamFile = "dna.yaml";
        upstreamContent = await ghFetchFileContent(ownerRepo, "dna.yaml");
      }
    } catch (err: any) {
      console.log(`   ❌ gh api error: ${err.message}`);
      errors++;
      continue;
    }

    if (!upstreamContent) {
      console.log(`   i️  No upstream DNA found (no dna.yml / dna.yaml in ${ownerRepo})\n`);
      skipped++;
      continue;
    }

    // Parse upstream YAML
    let upstreamFields: Record<string, any>;
    try {
      upstreamFields = (yaml.load(upstreamContent) as Record<string, any>) || {};
    } catch (err: any) {
      console.log(`   ❌ Failed to parse upstream ${upstreamFile}: ${err.message}\n`);
      errors++;
      continue;
    }

    // Must have id: dna://... to qualify as a mesh node
    if (!upstreamFields.id || !String(upstreamFields.id).startsWith("dna://")) {
      console.log(`   i️  No upstream DNA found (${upstreamFile} has no id: dna://... field)\n`);
      skipped++;
      continue;
    }

    // Read the current shadow file
    let shadowRaw: string;
    try {
      shadowRaw = readFileSync(shadow.path, "utf-8");
    } catch (err: any) {
      console.log(`   ❌ Cannot read shadow file: ${err.message}\n`);
      errors++;
      continue;
    }

    // Read existing metadata: try frontmatter first, then plain YAML (for *.dna.yml)
    let existingMeta: Record<string, any> = parseFrontmatter(shadowRaw).meta;
    if (!existingMeta || Object.keys(existingMeta).length === 0) {
      try {
        const parsed = yaml.load(shadowRaw) as Record<string, any>;
        if (parsed && typeof parsed === "object") existingMeta = parsed;
      } catch { /* leave as empty */ }
    }
    // Fall back to the in-memory shadow node id (always set by buildGraph) when
    // existing file lacks an id field for any reason.
    if (!existingMeta.id) existingMeta.id = shadow.id;

    const sha256 = createHash("sha256").update(upstreamContent).digest("hex");

    // Merge upstream fields into the shadow node file directly (no central cache)
    const parsedUpstream = (yaml.load(upstreamContent) as Record<string, any>) || {};
    const POINTER_FIELDS = new Set(["shadow", "shadow_origin", "shadow_fetched_at", "shadow_etag", "shadow_sha", "id", "pending_upstream"]);
    const newMeta: Record<string, any> = {
      id: existingMeta.id,
      shadow: true,
      shadow_origin: originUrl,
      shadow_fetched_at: new Date().toISOString(),
      shadow_sha: sha256,
    };
    if (existingMeta.shadow_etag) newMeta.shadow_etag = existingMeta.shadow_etag;
    if (existingMeta.pending_upstream) newMeta.pending_upstream = existingMeta.pending_upstream;
    // Merge upstream content fields into the node file
    for (const [k, v] of Object.entries(parsedUpstream)) {
      if (!POINTER_FIELDS.has(k)) {
        newMeta[k] = v;
      }
    }

    const pointerBody = `Pointer to ${originUrl}\n`;
    const newFm = yaml.dump(newMeta, { lineWidth: 120, quotingType: '"', forceQuotes: false }).trimEnd();
    // For *.dna.yml files, write plain YAML (no frontmatter delimiters) so the
    // file remains parseable as a YAML doc with id:. Frontmatter style is only
    // valid for *.dna.md and breaks .dna.yml parsing (NEBULA-65 fix).
    const isPureYaml = shadow.path.endsWith(".dna.yml");
    const newFileContent = isPureYaml
      ? `${newFm}\n`
      : `---\n${newFm}\n---\n\n${pointerBody}`;

    if (newFileContent === shadowRaw) {
      console.log(`   ✅  No change\n`);
      skipped++;
      continue;
    }

    // Show diff
    const oldFm = yaml.dump(existingMeta, { lineWidth: 120 }).trimEnd();
    const diffStr = simpleDiff(oldFm, newFm);
    if (diffStr) {
      console.log(`   📝  Diff (frontmatter):`);
      for (const line of diffStr.split("\n")) {
        const pfx = line.startsWith("+") ? "\x1b[32m" : line.startsWith("-") ? "\x1b[31m" : "";
        const rst = pfx ? "\x1b[0m" : "";
        console.log(`       ${pfx}${line}${rst}`);
      }
    }

    if (applyMode) {
      try {
        writeFileSync(shadow.path, newFileContent, "utf-8");
        console.log(`   ✅  Written → ${relPath(shadow.path)}\n`);
        updated++;
      } catch (err: any) {
        console.log(`   ❌ Write failed: ${err.message}\n`);
        errors++;
      }
    } else {
      console.log(`   i️  Would update (dry-run). Use --apply to write.\n`);
      updated++;  // counts as "would update"
    }
  }

  console.log("─".repeat(60));
  if (applyMode) {
    console.log(`✅  ${checked} shadows checked - ${updated} updated, ${skipped} skipped, ${errors} errors`);
  } else {
    console.log(`🔍  ${checked} shadows checked - ${updated} would update, ${skipped} skipped, ${errors} errors`);
    if (updated > 0) console.log(`    Run with --apply to write changes.`);
  }
}

function cmdUpgradeLegacy(args: string[]) {
  const apply = args.includes("--apply");
  const g = buildGraph();
  const { implicitTypeFiles } = g.lint;

  if (implicitTypeFiles.length === 0) {
    console.log("✅  No legacy governance files need upgrading.");
    return;
  }

  if (!apply) {
    console.log(`🔍  Dry-run: would add explicit type: frontmatter to ${implicitTypeFiles.length} file(s):\n`);
  } else {
    console.log(`✍️   Applying upgrade to ${implicitTypeFiles.length} file(s):\n`);
  }

  let updated = 0, skipped = 0, errors = 0;

  for (const filePath of implicitTypeFiles) {
    const parentDir = basename(dirname(filePath));
    const typeHint = LEGACY_GOV_DIR_TYPE_HINT[parentDir];
    if (!typeHint) { skipped++; continue; }

    let raw: string;
    try { raw = readFileSync(filePath, "utf-8"); } catch {
      console.log(`   ❌ Cannot read: ${relPath(filePath)}`);
      errors++;
      continue;
    }

    const { meta, body } = parseFrontmatter(raw);
    const fields = meta || {};

    if (fields.type) {
      // Already has type (shouldn't be in implicitTypeFiles, but guard anyway)
      skipped++;
      continue;
    }

    fields.type = typeHint;
    // Preserve key order: put type near the top
    const ordered: Record<string, any> = { id: fields.id, type: fields.type };
    for (const k of Object.keys(fields)) {
      if (k !== "id" && k !== "type") ordered[k] = fields[k];
    }

    const newFm = yaml.dump(ordered, { lineWidth: 120, noRefs: true }).trimEnd();
    const newContent = `---\n${newFm}\n---\n${body}`;

    console.log(`   ${apply ? "✅" : "→"} [${typeHint}] ${relPath(filePath)}`);

    if (apply) {
      try {
        writeFileSync(filePath, newContent, "utf-8");
        updated++;
      } catch {
        console.log(`      ❌ Write failed`);
        errors++;
      }
    } else {
      updated++;
    }
  }

  console.log(`\n${apply ? "✅  Done" : "Run with --apply to write changes"}. ${updated} to update, ${skipped} skipped, ${errors} errors.`);
}

function cmdMigrateVerbs(args: string[]) {
  const apply = args.includes("--apply");

  if (!apply) {
    console.log("🔍  DRY-RUN: migrate-verbs (use --apply to write)\n");
    console.warn("⚠️  WARNING: js-yaml dump will lose inline comments in modified files.");
    console.log("");
  } else {
    console.log("✍️   APPLY mode - files will be rewritten");
    console.warn("⚠️  WARNING: js-yaml dump will lose inline comments in modified files.");
    console.log("");
  }

  const g = buildGraph();

  /**
   * Classify a `links:` entry from sourceNode to targetNode into the correct typed verb.
   * Returns the verb to use on the SOURCE side.
   */
  function classifyLink(
    sourceType: string,
    targetType: string,
    sourceId: string,
    targetId: string,
  ): string {
    // Citation kinds emitted by scanCitations are already typed now (binds/mentions/executes)
    // This handles only frontmatter links: array entries.
    const pair = `${sourceType}→${targetType}`;
    switch (pair) {
      case "tool→agent":       return "managed_by";
      case "site→agent":       return "deployed_by";
      case "middleware→host":  return "runs_on";
      case "host→middleware":  return "hosts";
      case "agent→tool":       return "manages";
      case "agent→site":       return "deploys";   // or manages - default deploys for agent→site
      case "agent→realm":      return "manages";
      case "agent→repo":       return "manages";
      case "agent→flow":       return "manages";
      case "agent→middleware": return "manages";
      case "realm→middleware": return "manages";
      case "site→repo":        return "depends_on";
      case "flow→agent":       return "managed_by";
      default:                 return "link";  // can't classify - leave as generic
    }
  }

  let totalNodes = 0;
  let totalLinksFound = 0;
  let totalClassified = 0;
  let totalUnclassified = 0;
  let totalFilesChanged = 0;

  for (const node of g.nodes.values()) {
    const linksEdges = node.outbound.filter(e => e.kind === "link");
    if (linksEdges.length === 0) continue;

    totalNodes++;
    totalLinksFound += linksEdges.length;

    // Plan migrations: group by target verb
    const migrations: Array<{ targetId: string; verb: string }> = [];
    for (const edge of linksEdges) {
      const targetNode = g.nodes.get(edge.target);
      const verb = classifyLink(
        node.type,
        targetNode?.type ?? "unknown",
        node.id,
        edge.target,
      );
      migrations.push({ targetId: edge.target, verb });
      if (verb === "link") totalUnclassified++;
      else totalClassified++;
    }

    const hasChanges = migrations.some(m => m.verb !== "link");
    if (!hasChanges) continue;  // all unclassified - nothing to migrate

    console.log(`  ${node.id}  (${relPath(node.path)})`);
    for (const m of migrations) {
      const label = m.verb === "link" ? "[skip - unclassified]" : `→ ${m.verb}:`;
      console.log(`     ${label} ${m.targetId}`);
    }
    console.log("");

    if (!apply) continue;

    // Apply: read file, patch frontmatter, write
    const filePath = node.path;
    const isMd = filePath.endsWith(".md");
    let raw: string;
    try { raw = readFileSync(filePath, "utf-8"); } catch { console.log(`     ❌ Cannot read file`); continue; }

    function patchFields(fm: Record<string, any>) {
      const newLinks: string[] = [];
      for (const m of migrations) {
        if (m.verb === "link") {
          // Keep as links: if unclassified
          newLinks.push(m.targetId);
        } else {
          // Move to typed verb field
          const existing = fm[m.verb];
          if (existing == null) {
            fm[m.verb] = m.targetId;
          } else if (Array.isArray(existing)) {
            if (!existing.includes(m.targetId)) existing.push(m.targetId);
          } else if (typeof existing === "string") {
            if (existing !== m.targetId) fm[m.verb] = [existing, m.targetId];
          }
          // Remove from links if present
        }
      }
      if (newLinks.length > 0) {
        fm.links = newLinks;
      } else {
        delete fm.links;
      }
    }

    try {
      if (isMd) {
        const fmMatch = raw.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n([\s\S]*)$/);
        if (!fmMatch) { console.log(`     ❌ Cannot parse frontmatter`); continue; }
        const [, fmRaw, body] = fmMatch;
        let fm: Record<string, any>;
        try { fm = (yaml.load(fmRaw) as Record<string, any>) || {}; } catch { console.log(`     ❌ YAML parse error`); continue; }
        patchFields(fm);
        writeFileSync(filePath, `---\n${yaml.dump(fm, { lineWidth: 120, noRefs: true })}---\n${body}`, "utf-8");
      } else {
        let fields: Record<string, any>;
        try { fields = (yaml.load(raw) as Record<string, any>) || {}; } catch { console.log(`     ❌ YAML parse error`); continue; }
        patchFields(fields);
        writeFileSync(filePath, yaml.dump(fields, { lineWidth: 120, noRefs: true }), "utf-8");
      }
      totalFilesChanged++;
      console.log(`     ✅ Written`);
    } catch (err: any) {
      console.log(`     ❌ Write error: ${err.message}`);
    }
  }

  console.log("─".repeat(60));
  console.log(`📊  Migration summary:`);
  console.log(`   Nodes with links::  ${totalNodes}`);
  console.log(`   Total links: edges: ${totalLinksFound}`);
  console.log(`   Classified:         ${totalClassified}`);
  console.log(`   Unclassified:       ${totalUnclassified} (kept as links:)`);
  if (apply) {
    console.log(`   Files written:      ${totalFilesChanged}`);
    console.log("\n✅  Migration complete. Run \`dna mesh scan && dna mesh lint\` to verify.");
  } else {
    console.log("\n   Re-run with --apply to write changes.");
  }
}

// --- Tour command ---

const GOVERNANCE_TYPES = new Set(["philosophy", "convention", "protocol", "flow"]);
const GOVERNANCE_EDGE_KINDS = new Set(["governed_by", "governance", "binds"]);

function isGovernanceNode(id: string): boolean {
  const m = id.match(/^dna:\/\/([^/]+)/);
  return !!m && GOVERNANCE_TYPES.has(m[1]);
}

async function cmdTour(args: string[]) {
  const id = args[0] ? expandId(args[0]) : undefined;
  const g = buildGraph();

  if (!id) {
    // --- Overview mode ---
    const types = new Map<string, number>();
    for (const n of g.nodes.values()) {
      types.set(n.type, (types.get(n.type) || 0) + 1);
    }
    // Split projects into active vs shadow stubs
    const projectNodes = [...g.nodes.values()].filter(n => n.type === "project");
    const activeProjects = projectNodes.filter(n => n.fields.shadow !== true).length;
    const shadowProjects = projectNodes.filter(n => n.fields.shadow === true).length;
    const agents = [...g.nodes.values()].filter(n => n.type === "agent");
    const realms = [...g.nodes.values()].filter(n => n.type === "realm");

    console.log(`\n🌐  Empire Mesh Overview\n`);
    console.log(`   Total nodes: ${g.nodes.size}`);
    const allEdgeKinds = new Set([...g.nodes.values()].flatMap(n => n.outbound.map(e => e.kind)));
    console.log(`   Total edge types: ${allEdgeKinds.size}\n`);
    const cfg = loadConfig(process.cwd());
    console.log(`📊  Node counts by type:`);
    for (const [t, n] of [...types.entries()].sort((a, b) => b[1] - a[1])) {
      const td = getTypeDef(cfg, t);
      const label = `${td.icon} ${td.label}`;
      if (t === "project" && (activeProjects + shadowProjects) > 0) {
        console.log(`   ${label.padEnd(22)} ${n}  (${activeProjects} active + ${shadowProjects} shadow stub${shadowProjects === 1 ? "" : "s"})`);
      } else {
        console.log(`   ${label.padEnd(22)} ${n}`);
      }
    }
    console.log(`\n🤖  Agents (${agents.length}):`);
    for (const a of agents.sort((x, y) => x.id.localeCompare(y.id))) {
      console.log(`   ${a.id.padEnd(42)} ${a.title || ""}`);
    }
    if (realms.length) {
      console.log(`\n🏰  Realms (${realms.length}):`);
      for (const r of realms) {
        console.log(`   ${r.id.padEnd(42)} ${r.title || ""}`);
      }
    } else {
      console.log(`\n🏰  Realms: (none)`);
    }
    console.log(`\n🚀  Recommended start:`);
    console.log(`   dna mesh tour dna://agent/nebula`);
    console.log(`\n💡  Command cheatsheet:`);
    console.log(`   dna mesh tour <id>       Guided walkthrough of any node`);
    console.log(`   dna mesh show <id>       Raw node view (all edges)`);
    console.log(`   dna mesh refs <id>       Who references this node?`);
    console.log(`   dna mesh impact <id>     Recursive inbound walk`);
    console.log(`   dna mesh ls --type X     List nodes by type`);
    console.log(`   dna mesh lint            Audit graph health`);
    return;
  }

  // --- Node tour mode ---
  let n = g.nodes.get(id);
  if (!n) {
    // Try remote resolution
    const remoteUri = parseRemoteUri(id);
    if (remoteUri) {
      try {
        n = await fetchRemoteDna(remoteUri);
      } catch (err: any) {
        console.error(`❌ ${err.message}`);
        process.exit(1);
      }
    } else {
      console.error(`❌ Node not found: ${id}`);
      const near = [...g.nodes.keys()].filter(k => k.includes(id.replace("dna://", "")));
      if (near.length) console.error(`   Did you mean: ${near.slice(0, 5).join(", ")}`);
      process.exit(1);
    }
  }

  const slug = id.split("/").pop() || id;
  console.log(`\n🧭  ${id} - ${n.title || slug}\n`);

  // --- Identity ---
  console.log(`📍  Identity`);
  console.log(`   Type:   ${n.type}`);
  if (n.title) console.log(`   Title:  ${n.title}`);
  console.log(`   File:   ${relPath(n.path)}`);
  if (n.fields.workspace) console.log(`   Workspace: ${n.fields.workspace}`);
  if (n.fields.description) console.log(`   Desc:   ${n.fields.description}`);
  // Show tracked_in boards for project/agent nodes
  if (n.type === "project" || n.type === "agent") {
    const boardEdges = n.outbound.filter(e => e.kind === "tracked_in");
    if (boardEdges.length > 0) {
      console.log(`   📋  Tracked in:`);
      for (const e of boardEdges) {
        const bn = g.nodes.get(e.target);
        const boardUrl = bn?.fields?.url ? `  → ${bn.fields.url}` : "";
        console.log(`      • ${e.target}${boardUrl}`);
      }
    }
  }
  console.log("");

  // Project-specific section
  if (n.type === "project") {
    renderProjectSection(n.fields, n.path);
  }

  // Generic other fields
  renderOtherFields(n.fields);

  // --- Governance edges ---
  const govEdges: MeshEdge[] = n.outbound.filter(e =>
    GOVERNANCE_EDGE_KINDS.has(e.kind) || isGovernanceNode(e.target)
  );
  // Dedupe by target
  const govTargets = new Map<string, MeshEdge>();
  for (const e of govEdges) govTargets.set(e.target, e);

  const govList = [...govTargets.values()].filter(e => g.nodes.has(e.target));

  if (govList.length === 0) {
    console.log(`🏛️   Governed by`);
    console.log(`   ⚠️  (no governance - orphan agent?)\n`);
  } else {
    const MAX_GOV = 12;
    const shown = govList.slice(0, MAX_GOV);
    const more = govList.length - MAX_GOV;
    console.log(`🏛️   Governed by (${govList.length})`);
    for (const e of shown) {
      const t = g.nodes.get(e.target);
      console.log(`   • ${e.target.padEnd(55)} ${t?.title || ""}`);
    }
    if (more > 0) console.log(`   ... (${more} more)`);
    console.log("");
  }

  // --- Manages ---
  // Non-governance, non-depends_on outbound edges
  const managesEdges = n.outbound.filter(e =>
    !GOVERNANCE_EDGE_KINDS.has(e.kind) &&
    !isGovernanceNode(e.target) &&
    e.kind !== "depends_on" &&
    e.kind !== "governed_by"
  );
  // Dedupe by target
  const manageTargets = new Map<string, MeshNode | undefined>();
  for (const e of managesEdges) {
    if (!manageTargets.has(e.target)) manageTargets.set(e.target, g.nodes.get(e.target));
  }
  // Group by node type
  const managesByType = new Map<string, Array<{ id: string; title?: string }>>();
  for (const [tid, tn] of manageTargets) {
    const t = tn?.type || "unknown";
    if (!managesByType.has(t)) managesByType.set(t, []);
    managesByType.get(t)!.push({ id: tid, title: tn?.title });
  }

  console.log(`🔧  Manages`);
  if (managesByType.size === 0) {
    console.log(`   (none)\n`);
  } else {
    for (const [type, items] of [...managesByType.entries()].sort((a, b) => a[0].localeCompare(b[0]))) {
      const MAX_PER_TYPE = 8;
      const shown2 = items.slice(0, MAX_PER_TYPE);
      const more2 = items.length - MAX_PER_TYPE;
      const slugs = shown2.map(x => x.id.split("/").pop()).join(", ");
      const moreStr = more2 > 0 ? `, ... +${more2}` : "";
      console.log(`   ${type.padEnd(12)} (${items.length}): ${slugs}${moreStr}`);
    }
    console.log("");
  }

  // --- Depends on ---
  const depsEdges = n.outbound.filter(e => e.kind === "depends_on");
  console.log(`📥  Depends on`);
  if (depsEdges.length === 0) {
    console.log(`   (none)\n`);
  } else {
    for (const e of depsEdges) {
      const t = g.nodes.get(e.target);
      console.log(`   • ${e.target.padEnd(45)} ${t?.title || ""}`);
    }
    console.log("");
  }

  // --- Inbound ---
  const inbEdges = g.inboundEdges.get(id) || [];
  const inbByKind = new Map<string, Array<{ from: string; title?: string }>>();
  for (const e of inbEdges) {
    if (!inbByKind.has(e.kind)) inbByKind.set(e.kind, []);
    const srcNode = g.nodes.get(e.from);
    inbByKind.get(e.kind)!.push({ from: e.from, title: srcNode?.title });
  }

  console.log(`📤  Referenced by (inbound)`);
  if (inbByKind.size === 0) {
    console.log(`   (none)\n`);
  } else {
    const MAX_PER_KIND = 10;
    for (const [kind, items] of [...inbByKind.entries()].sort((a, b) => a[0].localeCompare(b[0]))) {
      const shown3 = items.slice(0, MAX_PER_KIND);
      const more3 = items.length - MAX_PER_KIND;
      console.log(`   [${kind}]`);
      for (const item of shown3) {
        console.log(`     ← ${item.from.padEnd(50)} ${item.title || ""}`);
      }
      if (more3 > 0) console.log(`     ... (${more3} more)`);
    }
    console.log("");
  }

  // --- Footer ---
  console.log(`🚪  Drill in:`);
  console.log(`   dna mesh tour <id-of-anything-above>`);
  console.log(`   dna mesh show ${id}  (raw view)`);
  console.log(`   dna mesh impact ${id}  (recursive what-depends-on-me)`);
  console.log("");
}

/**
 * cmdDiscoverProjects — walks all agent workspace projects/ dirs, finds candidates
 * without dna.yml, creates stub dna.yml files (with --apply), and updates
 * the owning agent's manages: list.
 */
function cmdDiscoverProjects(args: string[]) {
  const apply = args.includes("--apply");
  const workspacesRoot = join(HOME, ".openclaw/workspaces");

  if (!existsSync(workspacesRoot)) {
    console.error(`❌ Workspaces root not found: ${workspacesRoot}`);
    process.exit(1);
  }

  interface Candidate {
    dir: string;
    basename: string;
    agentName: string;
    agentDnaPath: string;
    repo?: string;
  }

  const candidates: Candidate[] = [];

  // Walk each agent workspace
  for (const agentEntry of readdirSync(workspacesRoot)) {
    const agentDir = join(workspacesRoot, agentEntry);
    if (!statSync(agentDir).isDirectory()) continue;

    // Walk projects/ and sites/ subdirs
    for (const subdir of ["projects", "sites"]) {
      const projectsDir = join(agentDir, subdir);
      if (!existsSync(projectsDir)) continue;

      for (const projEntry of readdirSync(projectsDir)) {
        const projDir = join(projectsDir, projEntry);
        const st = statSync(projDir);
        if (!st.isDirectory() && !st.isSymbolicLink()) continue;

        // Already has dna.yml or dna.yaml?
        if (existsSync(join(projDir, "dna.yml")) || existsSync(join(projDir, "dna.yaml"))) continue;

        // Determine git remote for repo: field
        let repo: string | undefined;
        try {
          const remote = execSync(`git -C ${JSON.stringify(projDir)} remote get-url origin 2>/dev/null`, { encoding: "utf-8" }).trim();
          if (remote) {
            // Parse git@github.com:owner/repo.git or https://github.com/owner/repo.git
            const m = remote.match(/github\.com[:/]([^/]+\/[^/.]+)(\.git)?$/);
            if (m) repo = m[1];
          }
        } catch { /* no remote */ }

        // Find agent dna.yml
        const agentDnaPath = existsSync(join(agentDir, "dna.yml")) ? join(agentDir, "dna.yml")
          : existsSync(join(agentDir, "dna.yaml")) ? join(agentDir, "dna.yaml") : "";

        candidates.push({ dir: projDir, basename: projEntry, agentName: agentEntry, agentDnaPath, repo });
      }
    }
  }

  if (candidates.length === 0) {
    console.log("✅ No candidates — all project dirs already have dna.yml");
    return;
  }

  console.log(`🔍 Found ${candidates.length} candidate(s) without dna.yml:\n`);
  for (const c of candidates) {
    const repoStr = c.repo ? `  repo: ${c.repo}` : "";
    console.log(`  ${c.agentName}/projects/${c.basename}${repoStr ? ` (${c.repo})` : ""}`);
  }

  if (!apply) {
    console.log(`\nDry-run complete. Run with --apply to create stubs.`);
    return;
  }

  console.log(`\n📝 Creating stubs...\n`);
  const byAgent = new Map<string, string[]>(); // agentDnaPath → new project IDs

  for (const c of candidates) {
    const stubPath = join(c.dir, "dna.yml");
    const projectId = `dna://project/${c.basename}`;
    const stub: Record<string, unknown> = {
      id: projectId,
      type: "project",
      managed_by: `dna://agent/${c.agentName}`,
      goal: "TODO — fill in project goal",
      boundary: ["TODO — fill in boundary"],
      status: "stub",
    };
    if (c.repo) stub.repo = c.repo;

    writeFileSync(stubPath, yaml.dump(stub, { lineWidth: 120 }), "utf-8");
    console.log(`  ✅ Created: ${relative(HOME, stubPath)}`);

    if (c.agentDnaPath) {
      if (!byAgent.has(c.agentDnaPath)) byAgent.set(c.agentDnaPath, []);
      byAgent.get(c.agentDnaPath)!.push(projectId);
    }
  }

  // Update agent dna.yml manages: lists
  console.log(`\n📎 Updating agent manages: lists...\n`);
  for (const [agentDnaPath, newIds] of byAgent) {
    try {
      const raw = readFileSync(agentDnaPath, "utf-8");
      const doc = yaml.load(raw) as any;
      if (!doc || typeof doc !== "object") { console.warn(`  ⚠️ Skipping ${agentDnaPath} — could not parse`); continue; }
      const manages: string[] = Array.isArray(doc.manages) ? doc.manages : [];
      let changed = false;
      for (const id of newIds) {
        if (!manages.includes(id)) { manages.push(id); changed = true; }
      }
      if (changed) {
        doc.manages = manages;
        writeFileSync(agentDnaPath, yaml.dump(doc, { lineWidth: 120 }), "utf-8");
        console.log(`  ✅ ${relative(HOME, agentDnaPath)} — added ${newIds.length} project(s)`);
      }
    } catch (e: any) {
      console.error(`  ❌ Error updating ${agentDnaPath}: ${e.message}`);
    }
  }

  console.log(`\n✅ Done. Run 'dna mesh scan' to refresh.`);
}

/**
 * cmdLinkProjectsToRepos — for each type:project stub node that has status:stub and no built_from,
 * check if a repo shadow exists in .dna/nodes/maintained-oss/<owner>-<basename>.dna.yml.
 * If found, add built_from to the project and built_into to the repo shadow.
 */
async function cmdLinkProjectsToRepos(args: string[]) {
  const apply = args.includes("--apply");
  const nodesRoot = join(HOME, ".openclaw/.dna/nodes");
  const workspacesRoot = join(HOME, ".openclaw/workspaces");
  const repoNodesDir = join(nodesRoot, "maintained-oss");

  interface LinkCandidate {
    projectFile: string;
    projectId: string;
    repoFile: string;
    repoId: string;
  }

  const candidates: LinkCandidate[] = [];

  // Walk all project dirs across all agent workspaces
  if (!existsSync(workspacesRoot)) {
    console.error(`❌ Workspaces root not found: ${workspacesRoot}`);
    process.exit(1);
  }

  for (const agentEntry of readdirSync(workspacesRoot)) {
    const projectsDir = join(workspacesRoot, agentEntry, "projects");
    if (!existsSync(projectsDir)) continue;

    for (const projEntry of readdirSync(projectsDir)) {
      const projDnaPath = join(projectsDir, projEntry, "dna.yml");
      if (!existsSync(projDnaPath)) continue;

      let doc: any;
      try { doc = yaml.load(readFileSync(projDnaPath, "utf-8")); } catch { continue; }
      if (!doc || doc.type !== "project") continue;
      if (doc.status !== "stub") continue;  // only touch stubs
      if (doc.built_from) continue;  // already linked

      const basename = projEntry;

      // Find matching repo shadow: try exisz-<name> first, then any <owner>-<name>
      let repoFile: string | undefined;
      let repoId: string | undefined;

      if (existsSync(repoNodesDir)) {
        const repoFiles = readdirSync(repoNodesDir);
        // prefer exisz-<name> match
        const exact = repoFiles.find(f => f === `exisz-${basename}.dna.yml`);
        if (exact) {
          repoFile = join(repoNodesDir, exact);
          repoId = `dna://maintained-oss/exisz-${basename}`;
        } else {
          // try any <owner>-<name>
          const fuzzy = repoFiles.find(f => f.endsWith(`-${basename}.dna.yml`));
          if (fuzzy) {
            repoFile = join(repoNodesDir, fuzzy);
            repoId = `dna://maintained-oss/${fuzzy.replace(".dna.yml", "")}`;
          }
        }
      }

      if (!repoFile || !repoId) continue;

      const projectId = doc.id || `dna://project/${basename}`;
      candidates.push({ projectFile: projDnaPath, projectId, repoFile, repoId });
    }
  }

  if (candidates.length === 0) {
    console.log("✅ No candidates — all stub projects already have built_from or no matching repo shadow");
    return;
  }

  console.log(`🔍 Found ${candidates.length} candidate(s):\n`);
  for (const c of candidates) {
    console.log(`  ${c.projectId}`);
    console.log(`    built_from: ${c.repoId}`);
    console.log(`    back-link:  ${c.repoId} → built_into: ${c.projectId}`);
    console.log();
  }

  if (!apply) {
    console.log(`ℹ️  Dry-run. Pass --apply to write changes.`);
    return;
  }

  let applied = 0;
  for (const c of candidates) {
    // Update project: add built_from
    try {
      const projDoc: any = yaml.load(readFileSync(c.projectFile, "utf-8"));
      projDoc.built_from = c.repoId;
      writeFileSync(c.projectFile, yaml.dump(projDoc, { lineWidth: 120 }), "utf-8");
      console.log(`  ✅ ${relative(HOME, c.projectFile)} — added built_from: ${c.repoId}`);
    } catch (e: any) {
      console.error(`  ❌ Error updating ${c.projectFile}: ${e.message}`);
      continue;
    }

    // Update repo shadow: add built_into
    try {
      const repoDoc: any = yaml.load(readFileSync(c.repoFile, "utf-8")) || {};
      if (!repoDoc.built_into) {
        repoDoc.built_into = c.projectId;
        writeFileSync(c.repoFile, yaml.dump(repoDoc, { lineWidth: 120 }), "utf-8");
        console.log(`  ✅ ${relative(HOME, c.repoFile)} — added built_into: ${c.projectId}`);
      } else {
        console.log(`  ℹ️  ${relative(HOME, c.repoFile)} — built_into already set`);
      }
    } catch (e: any) {
      console.error(`  ❌ Error updating ${c.repoFile}: ${e.message}`);
    }

    applied++;
  }

  console.log(`\n✅ Applied ${applied}/${candidates.length} link(s). Run 'dna mesh scan' to refresh.`);
}

/**
 * cmdDiscoverStarmap — inventory ~/starmap/* site dirs, write local shadow
 * nodes under .dna/nodes/site/, and write upstream dna.yml into each repo root.
 * Optionally git push.
 *
 * Default: dry-run (print inventory only)
 * --apply : write local shadows + upstream dna.yml (no push)
 * --push  : after --apply, also git push (sequential, 0.5s gap)
 *
 * NEBULA-65 — bulk-shadows starmap's 200+ deployed sites in mesh.
 */
function cmdDiscoverStarmap(args: string[]) {
  const apply = args.includes("--apply");
  const push = args.includes("--push");
  const limitIdx = args.indexOf("--limit");
  const limit = limitIdx !== -1 ? parseInt(args[limitIdx + 1], 10) : Infinity;

  const STARMAP = join(HOME, "starmap");
  if (!existsSync(STARMAP)) {
    console.error(`❌ Not found: ${STARMAP}`);
    process.exit(1);
  }

  const SHADOW_DIR = join(HOME, ".openclaw/.dna/nodes/site");
  const SKIP = new Set(["_data", "scripts", "evidence", "memory", "repos"]);

  interface Site { slug: string; dir: string; remote?: string; ownerRepo?: string; canonical?: string; ticket?: any; }

  // Phase 1 — inventory
  const sites: Site[] = [];
  for (const slug of readdirSync(STARMAP)) {
    const dir = join(STARMAP, slug);
    let st;
    try { st = statSync(dir); } catch { continue; }
    if (!st.isDirectory()) continue;
    if (slug.startsWith("_") || SKIP.has(slug)) continue;
    const hasGit = existsSync(join(dir, ".git"));
    const hasPkg = existsSync(join(dir, "package.json"));
    if (!hasGit && !hasPkg) continue;
    let remote: string | undefined;
    if (hasGit) {
      try {
        remote = execSync(`git -C ${JSON.stringify(dir)} remote get-url origin 2>/dev/null`, { encoding: "utf-8" }).trim();
      } catch { /* no remote */ }
    }
    let ownerRepo: string | undefined;
    if (remote) {
      const m = remote.match(/github\.com[:/]+([^/]+)\/([^/.]+?)(?:\.git)?$/);
      if (m) ownerRepo = `${m[1]}/${m[2]}`;
    }
    sites.push({ slug, dir, remote, ownerRepo });
    if (sites.length >= limit) break;
  }

  console.log(`🔭  Starmap inventory: ${sites.length} site dir(s) under ${STARMAP}`);
  const withRemote = sites.filter(s => s.ownerRepo).length;
  console.log(`   - with git remote: ${withRemote}`);
  console.log(`   - without remote (local-only): ${sites.length - withRemote}`);

  if (!apply) {
    console.log(`\nDry-run. Use --apply to write local shadows + upstream dna.yml.`);
    console.log(`Then re-run with --push to git push the upstream files.`);
    return;
  }

  // Phase 2 — resolve canonical owner via gh api (handles renames/redirects)
  console.log(`\n🔎  Resolving canonical GitHub owner for ${withRemote} repo(s)...`);
  let renamed = 0;
  for (let i = 0; i < sites.length; i++) {
    const s = sites[i];
    s.canonical = s.ownerRepo;
    if (s.ownerRepo) {
      try {
        const r = execSync(`gh api repos/${s.ownerRepo} -q '.full_name' 2>/dev/null`, { encoding: "utf-8", timeout: 10000 }).trim();
        if (r && r !== s.ownerRepo) { s.canonical = r; renamed++; }
      } catch { /* repo missing or auth issue — keep original */ }
    }
    if ((i + 1) % 25 === 0) console.log(`   ${i + 1}/${sites.length}`);
  }
  console.log(`   - canonical-renamed: ${renamed}`);

  // Phase 3 — write local shadows + upstream dna.yml
  mkdirSync(SHADOW_DIR, { recursive: true });
  let localWritten = 0, upstreamWritten = 0;
  const upstreamPaths: Array<{ slug: string; dir: string }> = [];
  for (const s of sites) {
    const id = `dna://site/${s.slug}`;
    const localPath = join(SHADOW_DIR, `${s.slug}.dna.yml`);
    if (s.canonical) {
      const local = `id: ${id}\nshadow: true\nshadow_origin: https://raw.githubusercontent.com/${s.canonical}/main/dna.yml\nshadow_repo_path: ${s.dir}\nshadow_fetched_at: ''\nshadow_sha: ''\ndeployed_by: dna://agent/starmap\n`;
      // Don't clobber a pre-existing hand-curated shadow
      if (!existsSync(localPath) || readFileSync(localPath, "utf-8").includes("shadow: true")) {
        writeFileSync(localPath, local, "utf-8");
        localWritten++;
      }
      const upstreamPath = join(s.dir, "dna.yml");
      if (!existsSync(upstreamPath)) {
        const safeTitle = JSON.stringify(s.slug);
        const upstream = `id: ${id}\ntype: site\ntitle: ${safeTitle}\nurl: https://${s.slug}.starmap.quest\nrepo: ${s.canonical}\nmanaged_by: dna://agent/starmap\ndeployed_by: dna://agent/starmap\nstatus: deployed\n`;
        writeFileSync(upstreamPath, upstream, "utf-8");
        upstreamWritten++;
        upstreamPaths.push({ slug: s.slug, dir: s.dir });
      }
    } else {
      // No remote: local-only stub
      const local = `id: ${id}\ntype: site\ntitle: ${JSON.stringify(s.slug)}\nurl: https://${s.slug}.starmap.quest\nmanaged_by: dna://agent/starmap\ndeployed_by: dna://agent/starmap\nstatus: dev\npending_upstream: true\nshadow_repo_path: ${s.dir}\n`;
      if (!existsSync(localPath)) {
        writeFileSync(localPath, local, "utf-8");
        localWritten++;
      }
    }
  }
  console.log(`\n✍️   Wrote ${localWritten} local shadow(s), ${upstreamWritten} upstream dna.yml file(s).`);

  if (!push) {
    console.log(`\n📌 Upstream files staged but NOT pushed. Re-run with --push to git push (rate-limited).`);
    return;
  }

  // Phase 4 — git push the upstream files (sequential)
  console.log(`\n🚀 Pushing ${upstreamPaths.length} upstream dna.yml file(s)...`);
  let pushed = 0, failed = 0;
  for (const u of upstreamPaths) {
    try {
      execSync(`git -C ${JSON.stringify(u.dir)} add dna.yml`, { stdio: "pipe" });
      execSync(`git -C ${JSON.stringify(u.dir)} commit -m "chore(dna): seed dna.yml — Starmap site mesh registration"`, { stdio: "pipe" });
      const branch = execSync(`git -C ${JSON.stringify(u.dir)} branch --show-current`, { encoding: "utf-8" }).trim();
      execSync(`git -C ${JSON.stringify(u.dir)} push origin ${branch}`, { stdio: "pipe" });
      pushed++;
      console.log(`   ✅ ${u.slug}`);
    } catch (e: any) {
      failed++;
      console.log(`   ❌ ${u.slug}: ${e.message?.split("\n")[0] || e}`);
    }
    // Be gentle: 500ms between pushes
    execSync("sleep 0.5");
  }
  console.log(`\n✅ Pushed ${pushed}/${upstreamPaths.length} (failed: ${failed}).`);
  console.log(`   Run 'dna mesh sync-shadows --apply' to hydrate caches from upstream.`);
}

function cmdHelp() {
  console.log(`🕸️  DNA Mesh - graph queries over distributed dna.yml/dna.yaml/*.dna.md/*.dna.yml files

Usage: dna mesh <subcommand> [args]

Subcommands:
  scan                 Refresh cache, print stats
  ls [--type X]        List nodes (filter by type)
  show <id>            Node details + outbound + inbound edges (grouped by kind)
  links <id>           Outbound edges (X references...)
  refs [--verb <verb>] <id>  Inbound edges grouped by verb
  impact <id>          Recursive inbound walk (what depends on X)
  tour [id]            Guided walkthrough of a node (or empire overview if no id)
  lint [--strict] [--show-cycles]  Dead links, self-loops, missing back-links, shadows, path mismatches, titles, orphans
  upgrade-legacy [--apply]         Add explicit type: frontmatter to legacy governance files (dry-run by default)
  heal --back-links [--apply]      Add missing structural back-links using typed verb inverses (dry-run by default)
  heal --shadows                   Sync all shadow nodes from upstream (alias for sync-shadows --apply)
  sync-remote [--ttl <h>]          Refresh all cached remote nodes (bypass TTL)
  promote-remote <uri>             Fetch remote + write to local shadow file
  ls remote                        List all cached remote nodes
  sync-shadows [--apply] [--filter <substr>]  Refresh shadows from upstream GitHub dna.yml
  migrate-verbs [--apply]          Migrate links: entries to typed verb fields (dry-run by default)
  discover-projects [--apply]      Find project dirs without dna.yml + seed stubs (dry-run by default)
  discover-starmap [--apply] [--push] [--limit N]  Bulk-shadow ~/starmap/* sites + seed upstream dna.yml (NEBULA-65)
  link-projects-to-repos [--apply] Link type:project stubs to their sibling repo shadows via built_from/built_into

Verb fields (typed edges):
  managed_by / manages       Tool managed by agent; site managed by agent
  governed_by / governs      Agent governed by philosophy/convention/protocol
  runs_on / hosts            Middleware runs_on host
  deploys / deployed_by      Agent deploys site
  derives_from / derived_into  Flow/ticket derivation
  depends_on / used_by       Tool/agent dependencies
  mentions / mentioned_by    Inline citation (was doc-reference)
  binds / bound_by           {{inject}} binding (was agent-binding)
  executes / executed_by     exec: dna ... in cron files (was runtime-binding)

Legacy edge kinds (still parsed for backward compat):
  link             Frontmatter links: array (generic catch-all - upgrade with migrate-verbs)
  governance       Frontmatter governance: array (one-way)

ID format: dna://<type>/<id>  (e.g. dna://agent/nebula)

Examples:
  dna mesh scan
  dna mesh ls --type agent
  dna mesh show dna://agent/claw
  dna mesh refs dna://agent/claw
  dna mesh impact dna://realm/empire-middleware
  dna mesh sync-shadows
  dna mesh sync-shadows --filter repo/exisz-agentic-dna --apply`);
}

// --- Entry ---

if (process.argv[1]?.endsWith("mesh-cli.ts") || process.argv[1]?.endsWith("mesh-cli.js")) {
  const [, , subcmd, ...rest] = process.argv;
switch (subcmd) {
  case "scan":            cmdScan(); break;
  case "ls":              rest[0] === "remote" ? cmdLsRemote() : cmdLs(rest); break;
  case "find":            cmdFind(rest); break;
  case "whoami":          cmdWhoami(); break;
  case "show":            await cmdShow(rest); break;
  case "links":           cmdLinks(rest); break;
  case "refs":            cmdRefs(rest); break;
  case "impact":          cmdImpact(rest); break;
  case "lint":            cmdLint(rest); break;
  case "upgrade-legacy":  cmdUpgradeLegacy(rest); break;
  case "heal":            await cmdHeal(rest); break;
  case "sync-shadows":    await cmdSyncShadows(rest); break;
  case "sync-remote":     await cmdSyncRemote(rest); break;
  case "promote-remote":  await cmdPromoteRemote(rest); break;
  case "migrate-verbs":   cmdMigrateVerbs(rest); break;
  case "discover-projects":        cmdDiscoverProjects(rest); break;
  case "discover-starmap":         cmdDiscoverStarmap(rest); break;
  case "link-projects-to-repos":   await cmdLinkProjectsToRepos(rest); break;
  case "tour":            await cmdTour(rest); break;
  case "help":
  case "--help":
  case "-h":
  case undefined:
    cmdHelp();
    break;
  default:
    console.error(`Unknown mesh subcommand: ${subcmd}`);
    cmdHelp();
    process.exit(1);
}
} // end CLI import guard
