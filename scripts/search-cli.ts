#!/usr/bin/env node
/**
 * DNA Search — unified search over the mesh.
 *
 * Combines three signals:
 *   1. Substring match on id+title (exact, fast, deterministic)
 *   2. Semantic match via local ONNX embeddings (synonyms, paraphrases, typos)
 *   3. PageRank weighting (keystone nodes break ties)
 *
 * Replaces the old `dna find` (substring-only). `dna find` is now a deprecated
 * alias that forwards here.
 *
 * Usage:
 *   dna search <query>                       # top 5 results across all node types
 *   dna search <query> --top 10
 *   dna search <query> --type philosophy     # filter by node type
 *   dna search <query> --json                # machine-readable output
 *   dna search <query> --exact               # substring only (skip embeddings)
 *   dna search --reindex                     # force full re-embed
 *   dna search --status                      # show index status
 */
import { existsSync, statSync } from "node:fs";
import { buildGraph } from "./mesh-cli.ts";
import {
  EMBEDDINGS_PATH,
  cosineSim,
  embed,
  loadIndex,
  saveIndex,
  updateIndex,
  type EmbeddingEntry,
  type NodeForIndex,
} from "../lib/embeddings.ts";
import {
  PAGERANK_PATH,
  getOrComputePageRank,
  pagerankBoost,
  pagerankFileSize,
} from "../lib/pagerank.ts";

// ── helpers ─────────────────────────────────────────────────────────────────

function nodesFromGraph(): NodeForIndex[] {
  const g = buildGraph();
  return [...g.nodes.values()].map((n) => ({
    id: n.id,
    type: n.type,
    title: n.title,
    body: n._body,
    tags: Array.isArray(n.fields?.tags) ? n.fields.tags : undefined,
    fields: n.fields,
  }));
}

function flagArg(args: string[], name: string): string | undefined {
  const i = args.indexOf(name);
  if (i === -1) return undefined;
  return args[i + 1];
}

function flagBool(args: string[], name: string): boolean {
  return args.includes(name);
}

function dropFlag(args: string[], name: string, takesValue: boolean): string[] {
  const out: string[] = [];
  for (let i = 0; i < args.length; i++) {
    if (args[i] === name) {
      if (takesValue) i++;
      continue;
    }
    out.push(args[i]);
  }
  return out;
}

// ── index lifecycle ─────────────────────────────────────────────────────────

async function ensureFreshIndex(quiet = false): Promise<void> {
  const nodes = nodesFromGraph();
  const idx = loadIndex();
  if (existsSync(EMBEDDINGS_PATH)) {
    const indexedIds = new Set(idx.entries.map((e) => e.id));
    let needsAny = false;
    for (const n of nodes) {
      if (!indexedIds.has(n.id)) {
        needsAny = true;
        break;
      }
    }
    if (!needsAny && idx.entries.length === nodes.length) return;
  }
  if (!quiet) process.stderr.write("🧬 building embedding index (one-time, ~5s)...\n");
  await rebuildIndex(quiet);
}

async function rebuildIndex(quiet = false): Promise<void> {
  const nodes = nodesFromGraph();
  const t0 = Date.now();
  const { index, stats } = await updateIndex(nodes, (i, total, id) => {
    if (quiet) return;
    if (i % 25 === 0 || i === total) {
      process.stderr.write(`  [${i}/${total}] ${id}\n`);
    }
  });
  saveIndex(index);
  const elapsed = ((Date.now() - t0) / 1000).toFixed(1);
  if (!quiet) {
    process.stderr.write(
      `✅ index updated in ${elapsed}s — ${stats.total} nodes (${stats.embedded} re-embedded, ${stats.reused} reused, ${stats.removed} removed)\n`,
    );
  }
}

// ── unified search ──────────────────────────────────────────────────────────

interface ScoredEntry {
  entry: { id: string; type: string; title?: string };
  score: number;       // final ranking score (higher = better)
  signals: {
    substring: number; // 0 or 1; 1 if id/title contains the query
    semantic: number;  // cosine similarity 0..1 (or 0 if --exact / no embedding)
    pagerank: number;  // raw pagerank value
  };
}

async function rankUnified(
  query: string,
  opts: {
    typeFilter?: string;
    top: number;
    exact: boolean;     // skip semantic
    quiet: boolean;
  },
): Promise<ScoredEntry[]> {
  const qLower = query.toLowerCase();
  const g = buildGraph();
  const pr = getOrComputePageRank(g);
  const maxRank = Math.max(...Object.values(pr.ranks), 0);

  // Substring-eligible: every node in the graph (no embedding required)
  const allNodes = [...g.nodes.values()];
  const substringHits = new Map<string, { id: string; type: string; title?: string }>();
  for (const n of allNodes) {
    if (opts.typeFilter && n.type !== opts.typeFilter) continue;
    if (
      n.id.toLowerCase().includes(qLower) ||
      (n.title || "").toLowerCase().includes(qLower)
    ) {
      substringHits.set(n.id, { id: n.id, type: n.type, title: n.title });
    }
  }

  // Semantic: only if not --exact AND we have an index
  let semanticEntries: EmbeddingEntry[] = [];
  let qVec: number[] | null = null;
  if (!opts.exact) {
    await ensureFreshIndex(opts.quiet);
    const idx = loadIndex();
    semanticEntries = opts.typeFilter
      ? idx.entries.filter((e) => e.type === opts.typeFilter)
      : idx.entries;
    if (semanticEntries.length) qVec = await embed(query);
  }

  // Build a map id → ScoredEntry, merging substring + semantic
  const scored = new Map<string, ScoredEntry>();

  // Substring contribution (gives a strong base score 0.7+ to ensure substring
  // hits never get buried under marginal semantic matches)
  for (const hit of substringHits.values()) {
    scored.set(hit.id, {
      entry: hit,
      score: 0,
      signals: {
        substring: 1,
        semantic: 0,
        pagerank: pr.ranks[hit.id] || 0,
      },
    });
  }

  // Semantic contribution
  if (qVec) {
    for (const e of semanticEntries) {
      const sim = cosineSim(qVec, e.vector);
      const existing = scored.get(e.id);
      if (existing) {
        existing.signals.semantic = sim;
      } else {
        scored.set(e.id, {
          entry: { id: e.id, type: e.type, title: e.title },
          score: 0,
          signals: {
            substring: 0,
            semantic: sim,
            pagerank: pr.ranks[e.id] || 0,
          },
        });
      }
    }
  }

  // Final score:
  //   base = max(0.7 * substring, semantic)   ← substring guarantees ≥0.7 so direct hits win
  //   final = base * pagerankBoost(node)      ← keystone nodes nudged up
  for (const s of scored.values()) {
    const base = Math.max(s.signals.substring * 0.7, s.signals.semantic);
    const boost = pagerankBoost(s.signals.pagerank, maxRank);
    s.score = base * boost;
  }

  return [...scored.values()]
    .filter((s) => s.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, opts.top);
}

// ── commands ────────────────────────────────────────────────────────────────

async function cmdSearch(rawArgs: string[], typeOverride?: string): Promise<void> {
  const top = parseInt(flagArg(rawArgs, "--top") || "5", 10);
  const typeFilter = typeOverride || flagArg(rawArgs, "--type");
  const asJson = flagBool(rawArgs, "--json");
  const exact = flagBool(rawArgs, "--exact");
  const quiet = flagBool(rawArgs, "--quiet") || asJson;

  let args = dropFlag(rawArgs, "--top", true);
  args = dropFlag(args, "--type", true);
  args = dropFlag(args, "--json", false);
  args = dropFlag(args, "--exact", false);
  args = dropFlag(args, "--quiet", false);

  const query = args.join(" ").trim();
  if (!query) {
    console.error("Usage: dna search <query> [--top N] [--type TYPE] [--exact] [--json]");
    process.exit(1);
  }

  const scored = await rankUnified(query, { typeFilter, top, exact, quiet });

  if (asJson) {
    console.log(
      JSON.stringify(
        scored.map((s) => ({
          id: s.entry.id,
          type: s.entry.type,
          title: s.entry.title,
          score: Number(s.score.toFixed(4)),
          signals: {
            substring: s.signals.substring,
            semantic: Number(s.signals.semantic.toFixed(4)),
            pagerank: Number(s.signals.pagerank.toFixed(6)),
          },
        })),
        null,
        2,
      ),
    );
    return;
  }

  if (!scored.length) {
    console.log(`No results for "${query}"${typeFilter ? ` (type=${typeFilter})` : ""}.`);
    return;
  }

  console.log(
    `🔎 Top ${scored.length} for "${query}"${typeFilter ? ` (type=${typeFilter})` : ""}${exact ? " [exact]" : ""}:\n`,
  );
  for (const s of scored) {
    const score = (s.score * 100).toFixed(1).padStart(5);
    const tag =
      s.signals.substring && s.signals.semantic > 0
        ? "≡~"
        : s.signals.substring
          ? "≡ "
          : "~ ";
    const type = s.entry.type.padEnd(12);
    console.log(`  ${score}%  ${tag} ${type}  ${s.entry.id}`);
    if (s.entry.title && s.entry.title !== s.entry.id) {
      console.log(`             ${"".padEnd(15)} └─ ${s.entry.title}`);
    }
  }
  console.log("");
  console.log("  ≡=substring  ~=semantic  ≡~=both");
  console.log("💡 dna show <id> · --type TYPE to filter · --exact for substring-only");
}

async function cmdStatus(): Promise<void> {
  const idx = loadIndex();
  const exists = existsSync(EMBEDDINGS_PATH);
  console.log("=== Embeddings ===");
  console.log(`Path:         ${EMBEDDINGS_PATH}`);
  console.log(`Exists:       ${exists}`);
  console.log(`Model:        ${idx.model}`);
  console.log(`Schema ver:   ${idx.version}`);
  console.log(`Entries:      ${idx.entries.length}`);
  if (exists) {
    const sz = statSync(EMBEDDINGS_PATH).size;
    console.log(`File size:    ${(sz / 1024).toFixed(1)} KB`);
  }

  console.log("\n=== PageRank ===");
  const prSize = pagerankFileSize();
  console.log(`Path:         ${PAGERANK_PATH}`);
  console.log(`Exists:       ${prSize > 0}`);
  if (prSize > 0) {
    console.log(`File size:    ${(prSize / 1024).toFixed(1)} KB`);
  }

  if (idx.entries.length) {
    const types = new Map<string, number>();
    for (const e of idx.entries) types.set(e.type, (types.get(e.type) || 0) + 1);
    console.log("\nBy type:");
    for (const [t, n] of [...types.entries()].sort((a, b) => b[1] - a[1])) {
      console.log(`   ${t.padEnd(15)} ${n}`);
    }
  }
}

function printHelp(): void {
  console.log(`🔎 DNA Search — unified mesh search

Combines substring + semantic (local ONNX embeddings) + PageRank weighting.
Replaces the old 'dna find' (substring-only). 'dna find' still works as alias.

Usage:
  dna search <query>                Top 5 results
  dna search <query> --top 10       Limit results
  dna search <query> --type TYPE    Filter by node type (philosophy/convention/...)
  dna search <query> --exact        Substring only (skip semantic)
  dna search <query> --json         Machine-readable
  dna search --reindex              Force full re-embed
  dna search --status               Show index info

Examples:
  dna search "test before code"                  # finds philosophy/test-driven semantically
  dna search "test before code" --type convention
  dna search "ticket-before-work" --exact        # exact id match
  dna search nebula                              # substring matches across all types

Index: ${EMBEDDINGS_PATH}
Model: Xenova/all-MiniLM-L6-v2 (downloaded once to ~/.cache/huggingface/)
`);
}

// ── exports for thin wrappers (philosophy/convention/protocol/flow CLIs) ────

/** Run a typed search inline — used by per-type wrapper CLIs. */
export async function runTypedSearch(type: string, args: string[]): Promise<void> {
  await cmdSearch(args, type);
}

// ── main ────────────────────────────────────────────────────────────────────

// Run the CLI dispatcher only when this file is invoked directly as `search-cli`.
// We can't trust `import.meta.url === file://${argv[1]}` because tsup bundles
// search-cli into the per-type wrappers (philosophy-cli.js, etc.) — doing so
// would cause every wrapper to also fire search-cli's dispatcher and double-run.
const _arg1 = process.argv[1] || "";
const _basename = _arg1.split("/").pop() || "";
const isMain = _basename === "search-cli.js" || _basename === "search-cli.ts";

if (isMain) {
  const argv = process.argv.slice(2);
  (async () => {
    if (!argv.length || argv[0] === "--help" || argv[0] === "-h" || argv[0] === "help") {
      printHelp();
      return;
    }
    if (argv[0] === "--status" || argv[0] === "status") {
      await cmdStatus();
      return;
    }
    if (argv[0] === "--reindex" || argv[0] === "reindex") {
      await rebuildIndex(false);
      return;
    }
    await cmdSearch(argv);
  })().catch((err) => {
    console.error("❌", err?.message || err);
    process.exit(1);
  });
}
