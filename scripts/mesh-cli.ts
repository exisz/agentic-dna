#!/usr/bin/env tsx
/**
 * dna mesh — graph-based mesh CLI for the DNA system.
 *
 * Scans dna.yml / dna.yaml / *.dna.md files across known roots,
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
import { readFileSync, existsSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { execSync } from "node:child_process";
import { join, basename, relative } from "node:path";
import yaml from "js-yaml";
import { HOME, DNA_DATA, parseFrontmatter } from "../lib/common.js";

// --- Config ---

const SCAN_ROOTS = [
  join(HOME, ".openclaw/workspace"),       // main session (claw)
  join(HOME, ".openclaw/workspaces"),      // all governors
  join(HOME, ".openclaw/realms"),          // shared realms
  join(HOME, ".openclaw/.dna/nodes"),      // shadows + governance
  join(HOME, ".openclaw/.dna/philosophies"), // existing governance (will become .dna.md)
  join(HOME, ".openclaw/.dna/conventions"),
  join(HOME, ".openclaw/.dna/flows"),
  join(HOME, ".openclaw/.dna/protocols"),
  join(HOME, ".dna"),                      // optional alt data root
];

const SKIP_DIRS = new Set([
  "node_modules", ".git", "dist", "build", ".next", ".turbo",
  "memory", "_shots", ".cache", "logs", "tmp",
]);

const ID_REGEX = /dna:\/\/[a-z][a-z0-9-]*\/[a-zA-Z0-9_.-]+/g;
const CACHE_PATH = join(DNA_DATA, ".mesh-cache.json");
const MAX_DEPTH = 8;  // safety: don't recurse forever

// --- Types ---

interface MeshNode {
  id: string;
  type: string;
  title?: string;
  path: string;             // absolute file path
  fields: Record<string, any>;  // raw parsed YAML/frontmatter
  outbound: string[];       // resolved edge target IDs (deduped)
}

interface MeshGraph {
  nodes: Map<string, MeshNode>;
  // path -> id (for de-dup detection)
  pathIndex: Map<string, string>;
  // target -> set of source IDs (inbound edges)
  inbound: Map<string, Set<string>>;
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
  };
}

// --- Scanner ---

/** Walk a root dir, collect candidate files. */
function walkForCandidates(root: string, depth = 0, looseMd = false): string[] {
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
      out.push(...walkForCandidates(full, depth + 1, looseMd));
    } else if (st.isFile()) {
      // Match dna.yml, dna.yaml, *.dna.md
      // In looseMd roots (governance dirs), also match any *.md with frontmatter
      if (name === "dna.yml" || name === "dna.yaml" || name.endsWith(".dna.md")) {
        out.push(full);
      } else if (looseMd && name.endsWith(".md") && name !== "index.md" && name !== "README.md") {
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

/** Parse one file → MeshNode (or null if malformed/no id). */
function parseFile(path: string, lint: MeshGraph["lint"]): MeshNode | null {
  let raw: string;
  try { raw = readFileSync(path, "utf-8"); } catch { return null; }
  const isMd = path.endsWith(".md");  // any .md uses frontmatter parsing (.dna.md OR loose-md governance)
  let fields: Record<string, any>;
  if (isMd) {
    const { meta } = parseFrontmatter(raw);
    fields = meta || {};
  } else {
    try {
      fields = (yaml.load(raw) as Record<string, any>) || {};
    } catch (e: any) {
      // YAML parse error — skip
      return null;
    }
  }
  if (!fields || typeof fields !== "object" || Array.isArray(fields)) return null;
  const id = fields.id;
  const type = fields.type;
  if (!id || typeof id !== "string" || !id.startsWith("dna://")) {
    // Has dna file but no mesh id — flag near-miss
    if (path.endsWith("dna.yaml") || path.endsWith("dna.yml") || path.endsWith(".dna.md")) {
      lint.missingFields.push({ path, missing: ["id"] });
    }
    return null;
  }
  if (!type) {
    lint.missingFields.push({ path, missing: ["type"] });
  }
  // Collect outbound edges from all string values
  const outboundSet = new Set<string>();
  walkStrings(fields, "", (s) => {
    if (s.includes("dna://")) {
      const matches = s.match(ID_REGEX);
      if (matches) {
        for (const m of matches) {
          if (m !== id) outboundSet.add(m);
        }
      }
    }
  });
  return {
    id,
    type: type || "unknown",
    title: fields.title,
    path,
    fields,
    outbound: [...outboundSet].sort(),
  };
}

/** Build the full graph by scanning. */
export function buildGraph(): MeshGraph {
  const graph: MeshGraph = {
    nodes: new Map(),
    pathIndex: new Map(),
    inbound: new Map(),
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
    },
  };

  const candidates: string[] = [];
  for (const root of SCAN_ROOTS) {
    // Governance dirs allow loose .md (existing philosophies/conventions/flows/protocols)
    const looseMd = root.includes("/.dna/philosophies") || root.includes("/.dna/conventions")
      || root.includes("/.dna/flows") || root.includes("/.dna/protocols");
    const found = walkForCandidates(root, 0, looseMd);
    if (process.env.DEBUG_MESH) console.error(`[mesh] root=${root} looseMd=${looseMd} found=${found.length}`);
    candidates.push(...found);
  }
  // Dedupe paths (in case of overlapping roots)
  const uniquePaths = [...new Set(candidates)];

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
    if (path.endsWith("dna.yaml")) {
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
  for (const node of graph.nodes.values()) {
    for (const target of node.outbound) {
      if (!graph.inbound.has(target)) graph.inbound.set(target, new Set());
      graph.inbound.get(target)!.add(node.id);
      if (!graph.nodes.has(target)) {
        graph.lint.deadLinks.push({ from: node.id, to: target, field: "<various>" });
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
        id: n.id, type: n.type, title: n.title, path: n.path, outbound: n.outbound,
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
  const t = withTitle && node.title ? ` — ${node.title}` : "";
  return `${node.id}${t}`;
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
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--type" || args[i] === "-t") typeFilter = args[i + 1];
  }
  const nodes = [...g.nodes.values()]
    .filter(n => !typeFilter || n.type === typeFilter)
    .sort((a, b) => a.id.localeCompare(b.id));
  for (const n of nodes) {
    console.log(`  ${n.id.padEnd(45)} ${n.title || ""}`);
  }
  console.log(`\n${nodes.length} node${nodes.length === 1 ? "" : "s"}${typeFilter ? ` (type=${typeFilter})` : ""}`);
}

function cmdShow(args: string[]) {
  const id = args[0];
  if (!id) { console.error("Usage: dna mesh show <id>"); process.exit(1); }
  const g = buildGraph();
  const n = g.nodes.get(id);
  if (!n) {
    console.error(`❌ Node not found: ${id}`);
    // Suggest near matches
    const near = [...g.nodes.keys()].filter(k => k.includes(id.replace("dna://", "")));
    if (near.length) {
      console.error(`Did you mean: ${near.slice(0, 5).join(", ")}`);
    }
    process.exit(1);
  }
  console.log(`🧬 ${n.id}`);
  console.log(`   Type:    ${n.type}`);
  if (n.title) console.log(`   Title:   ${n.title}`);
  console.log(`   File:    ${relPath(n.path)}`);
  console.log("");
  console.log(`   Outbound (${n.outbound.length}):`);
  for (const target of n.outbound) {
    const targetNode = g.nodes.get(target);
    const dead = targetNode ? "" : " ⚠️ dead link";
    console.log(`     → ${target}${targetNode?.title ? ` — ${targetNode.title}` : ""}${dead}`);
  }
  const inb = g.inbound.get(n.id);
  console.log("");
  console.log(`   Inbound (${inb?.size || 0}):`);
  if (inb) {
    for (const src of [...inb].sort()) {
      const srcNode = g.nodes.get(src);
      console.log(`     ← ${src}${srcNode?.title ? ` — ${srcNode.title}` : ""}`);
    }
  }
}

function cmdLinks(args: string[]) {
  const id = args[0];
  if (!id) { console.error("Usage: dna mesh links <id>"); process.exit(1); }
  const g = buildGraph();
  const n = g.nodes.get(id);
  if (!n) { console.error(`❌ Node not found: ${id}`); process.exit(1); }
  for (const target of n.outbound) {
    const t = g.nodes.get(target);
    console.log(`${target}${t?.title ? ` — ${t.title}` : " (unresolved)"}`);
  }
}

function cmdRefs(args: string[]) {
  const id = args[0];
  if (!id) { console.error("Usage: dna mesh refs <id>"); process.exit(1); }
  const g = buildGraph();
  const inb = g.inbound.get(id);
  if (!inb || inb.size === 0) {
    console.log(`(No inbound references to ${id})`);
    return;
  }
  for (const src of [...inb].sort()) {
    const s = g.nodes.get(src);
    console.log(`${src}${s?.title ? ` — ${s.title}` : ""}`);
  }
}

function cmdImpact(args: string[]) {
  const id = args[0];
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
      console.log(`    ${item.id}${n?.title ? ` — ${n.title}` : ""}`);
    }
  });
  console.log(`\n  Total affected: ${visited.size - 1}`);
}

/** Tarjan SCC — returns all SCCs with size > 1, plus self-loops. */
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
      for (const w of node.outbound) {
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
      const selfLoop = scc.length === 1 && (g.nodes.get(scc[0])?.outbound.includes(scc[0]) ?? false);
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
    ["agent", "repo"],
    ["agent", "tool"],
    ["agent", "site"],
    ["host", "middleware"],
    ["site", "repo"],
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
    if (node.outbound.includes(node.id)) {
      g.lint.missingBackLinks.push({ source: node.id, target: node.id });
    }
  }
  // Back-link enforcement
  for (const node of g.nodes.values()) {
    for (const target of node.outbound) {
      if (target === node.id) continue; // self-loop already handled
      const targetNode = g.nodes.get(target);
      if (!targetNode) continue;
      const pairKey = [node.type, targetNode.type].sort().join(":");
      if (!structuralSet.has(pairKey)) continue;
      if (!targetNode.outbound.includes(node.id)) {
        g.lint.missingBackLinks.push({ source: node.id, target: targetNode.id });
      }
    }
  }

  // --- Check 6: Title presence ---
  for (const node of g.nodes.values()) {
    if (!node.title) g.lint.missingTitles.push(node.id);
  }

  // --- Output ---
  const { deadLinks, duplicateIds, missingFields, nonCanonicalExt, cycles,
          staleShadows, idPathMismatches, typeDirMismatches, missingBackLinks, missingTitles } = g.lint;
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
      console.log(`\n🔄  Cycles (${cycles.length} SCC — debug only, bidirectional back-links are expected):`);
      for (const scc of cycles) {
        console.log(`   [${scc.join(" → ")}]`);
      }
    } else {
      console.log(`\n✅  No cycles detected`);
    }
  }
  if (staleShadows.length) {
    console.log(`\n⏰  Stale shadows (>30 days, ${staleShadows.length}):`);
    for (const s of staleShadows) {
      console.log(`   ${s.id}  (${s.age_days} days old)  ${relPath(s.path)}`);
    }
  } else {
    console.log(`✅  No stale shadows`);
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
    console.log(`\nℹ️  Non-canonical extension (.yaml; .yml is canonical) — ${nonCanonicalExt.length} files`);
    console.log("   (backward-compat OK; rename batch is a future task)");
  }
  if (missingTitles.length) {
    console.log(`\n📝  Missing titles (${missingTitles.length} nodes):`);
    for (const id of missingTitles.slice(0, 20)) console.log(`   ${id}`);
    if (missingTitles.length > 20) console.log(`   ... and ${missingTitles.length - 20} more`);
  } else {
    console.log(`✅  All nodes have titles`);
  }
  // Orphan governance: philosophy/convention/flow with no inbound
  const govTypes = new Set(["philosophy", "convention", "flow", "protocol"]);
  const orphans = [...g.nodes.values()].filter(n => govTypes.has(n.type) && !(g.inbound.get(n.id)?.size));
  if (orphans.length) {
    console.log(`\nℹ️  Orphan governance nodes (${orphans.length}, no inbound refs):`);
    for (const o of orphans.slice(0, 20)) console.log(`   ${o.id}`);
    if (orphans.length > 20) console.log(`   ... and ${orphans.length - 20} more`);
  }
  if (!hasErrors && !deadLinks.length && !duplicateIds.length) {
    console.log("\n✅ Lint clean (no errors).");
  }
  if (strict && (deadLinks.length || duplicateIds.length || hasErrors)) {
    console.log("\n❌ --strict: exiting 1 (errors found)");
    process.exit(1);
  }
}

function cmdHeal(args: string[]) {
  // --shadows is an alias for sync-shadows --apply
  if (args.includes("--shadows")) {
    const rest = args.filter(a => a !== "--shadows");
    cmdSyncShadows(["--apply", ...rest]);
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
    ["agent", "repo"],
    ["agent", "tool"],
    ["agent", "site"],
    ["host", "middleware"],
    ["site", "repo"],
    ["realm", "middleware"],
    ["flow", "agent"],
  ];
  const structuralSet = new Set<string>();
  for (const [a, b] of STRUCTURAL_PAIRS) {
    structuralSet.add([a, b].sort().join(":"));
  }

  // Collect missing back-links
  const missing = new Map<string, string[]>(); // target id -> sources to add
  for (const node of g.nodes.values()) {
    for (const target of node.outbound) {
      if (target === node.id) continue;
      const targetNode = g.nodes.get(target);
      if (!targetNode) continue;
      const pairKey = [node.type, targetNode.type].sort().join(":");
      if (!structuralSet.has(pairKey)) continue;
      if (!targetNode.outbound.includes(node.id)) {
        if (!missing.has(target)) missing.set(target, []);
        missing.get(target)!.push(node.id);
      }
    }
  }

  if (missing.size === 0) {
    console.log("✅  No missing back-links — nothing to heal.");
    return;
  }

  if (!apply) {
    console.log(`🔗  Dry-run: would add back-links to ${missing.size} node(s):\n`);
  } else {
    console.log("⚠️  WARNING: js-yaml dump will lose inline comments. Proceeding with --apply.\n");
  }

  for (const [targetId, sources] of missing) {
    const targetNode = g.nodes.get(targetId)!;
    const filePath = targetNode.path;
    const isMd = filePath.endsWith(".md");
    console.log(`  → ${targetId}  (${relPath(filePath)})`);
    for (const src of sources) {
      console.log(`     + ${src}`);
    }

    if (!apply) continue;

    // Read & patch
    const raw = readFileSync(filePath, "utf-8");
    if (isMd) {
      // Frontmatter: extract YAML block, patch, re-assemble
      const fmMatch = raw.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n([\s\S]*)$/);
      if (!fmMatch) {
        console.log(`     ❌ Cannot parse frontmatter in ${filePath}`);
        continue;
      }
      const [, fmRaw, body] = fmMatch;
      let fm: Record<string, any>;
      try {
        fm = (yaml.load(fmRaw) as Record<string, any>) || {};
      } catch {
        console.log(`     ❌ YAML parse error in ${filePath}`);
        continue;
      }
      if (!Array.isArray(fm.links)) fm.links = [];
      for (const src of sources) {
        if (!fm.links.includes(src)) fm.links.push(src);
      }
      const newFm = yaml.dump(fm, { lineWidth: 120, noRefs: true });
      writeFileSync(filePath, `---\n${newFm}---\n${body}`, "utf-8");
    } else {
      // dna.yml / dna.yaml
      let fields: Record<string, any>;
      try {
        fields = (yaml.load(raw) as Record<string, any>) || {};
      } catch {
        console.log(`     ❌ YAML parse error in ${filePath}`);
        continue;
      }
      if (!Array.isArray(fields.links)) fields.links = [];
      for (const src of sources) {
        if (!fields.links.includes(src)) fields.links.push(src);
      }
      const newYaml = yaml.dump(fields, { lineWidth: 120, noRefs: true });
      writeFileSync(filePath, newYaml, "utf-8");
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
  const m = url.match(/github\.com[/:](\S+?\/(\S+?))(?:\/|$|#|\?)/);
  if (!m) return null;
  return m[1].replace(/\.git$/, "");
}

/** Fetch file content from a GitHub repo via gh api. Returns null if not found or error. */
function ghFetchFileContent(ownerRepo: string, filePath: string): string | null {
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

// Fields that belong to the local shadow — never overwritten from upstream
const SHADOW_LOCAL_FIELDS = new Set([
  "shadow", "shadow_origin", "shadow_repo_path", "shadow_fetched_at", "shadow_source",
]);

function cmdSyncShadows(args: string[]) {
  const applyMode = args.includes("--apply");
  const filterIdx = args.indexOf("--filter");
  const filterStr = filterIdx !== -1 ? args[filterIdx + 1] : null;

  if (!applyMode) {
    console.log("🔍  DRY-RUN mode (use --apply to write changes)\n");
  } else {
    console.log("✍️   APPLY mode — shadow files will be rewritten\n");
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
      console.log(`   ⚠️  shadow_origin not parseable as GitHub URL — skip`);
      errors++;
      continue;
    }

    // Try dna.yml first, fall back to dna.yaml
    let upstreamContent: string | null = null;
    let upstreamFile = "dna.yml";
    try {
      upstreamContent = ghFetchFileContent(ownerRepo, "dna.yml");
      if (!upstreamContent) {
        upstreamFile = "dna.yaml";
        upstreamContent = ghFetchFileContent(ownerRepo, "dna.yaml");
      }
    } catch (err: any) {
      console.log(`   ❌ gh api error: ${err.message}`);
      errors++;
      continue;
    }

    if (!upstreamContent) {
      console.log(`   ℹ️  No upstream DNA found (no dna.yml / dna.yaml in ${ownerRepo})\n`);
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
      console.log(`   ℹ️  No upstream DNA found (${upstreamFile} has no id: dna://... field)\n`);
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

    const { meta: existingMeta, body: shadowBody } = parseFrontmatter(shadowRaw);

    // Merge: start from upstream, overlay local-only fields, update shadow_fetched_at
    const merged: Record<string, any> = { ...upstreamFields };
    for (const localField of SHADOW_LOCAL_FIELDS) {
      if (existingMeta[localField] !== undefined) {
        merged[localField] = existingMeta[localField];
      }
    }
    merged.shadow_fetched_at = new Date().toISOString();

    const newFm = yaml.dump(merged, { lineWidth: 120, quotingType: '"', forceQuotes: false }).trimEnd();
    const newFileContent = `---\n${newFm}\n---\n\n${shadowBody}\n`;

    if (newFileContent === shadowRaw) {
      console.log(`   ✅  No change\n`);
      skipped++;
      continue;
    }

    // Show diff
    const oldFm = yaml.dump(existingMeta, { lineWidth: 120 }).trimEnd();
    const diffStr = simpleDiff(oldFm, newFm);
    if (diffStr) {
      console.log(`   📝  Diff (frontmatter):`)
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
      console.log(`   ℹ️  Would update (dry-run). Use --apply to write.\n`);
      updated++;  // counts as "would update"
    }
  }

  console.log("─".repeat(60));
  if (applyMode) {
    console.log(`✅  ${checked} shadows checked — ${updated} updated, ${skipped} skipped, ${errors} errors`);
  } else {
    console.log(`🔍  ${checked} shadows checked — ${updated} would update, ${skipped} skipped, ${errors} errors`);
    if (updated > 0) console.log(`    Run with --apply to write changes.`);
  }
}

function cmdHelp() {
  console.log(`🕸️  DNA Mesh — graph queries over distributed dna.yml/dna.yaml/*.dna.md files

Usage: dna mesh <subcommand> [args]

Subcommands:
  scan                 Refresh cache, print stats
  ls [--type X]        List nodes (filter by type)
  show <id>            Node details + outbound + inbound edges
  links <id>           Outbound edges (X references...)
  refs <id>            Inbound edges (... references X)
  impact <id>          Recursive inbound walk (what depends on X)
  lint [--strict] [--show-cycles]  Dead links, self-loops, missing back-links, shadows, path mismatches, titles
  heal --back-links [--apply]      Add missing structural back-links (dry-run by default)
  heal --shadows                   Sync all shadow nodes from upstream (alias for sync-shadows --apply)
  sync-shadows [--apply] [--filter <substr>]  Refresh shadows from upstream GitHub dna.yml

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

const [, , subcmd, ...rest] = process.argv;
switch (subcmd) {
  case "scan":         cmdScan(); break;
  case "ls":           cmdLs(rest); break;
  case "show":         cmdShow(rest); break;
  case "links":        cmdLinks(rest); break;
  case "refs":         cmdRefs(rest); break;
  case "impact":       cmdImpact(rest); break;
  case "lint":         cmdLint(rest); break;
  case "heal":         cmdHeal(rest); break;
  case "sync-shadows": cmdSyncShadows(rest); break;
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
