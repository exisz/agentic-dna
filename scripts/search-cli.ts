#!/usr/bin/env node
/**
 * DNA Search CLI — semantic search over the mesh using local ONNX embeddings.
 *
 * Usage:
 *   dna search <query>                       # top 5 results across all node types
 *   dna search <query> --top 10
 *   dna search <query> --type philosophy     # filter by node type
 *   dna search <query> --json                # machine-readable output
 *   dna search --reindex                     # force full re-embed
 *   dna search --status                      # show index status
 *
 * Storage: <DNA_DATA>/.embeddings.json
 * Model: Xenova/all-MiniLM-L6-v2 (downloaded once on first use)
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
  type NodeForIndex,
} from "../lib/embeddings.ts";

function nodesFromGraph(): NodeForIndex[] {
  const g = buildGraph();
  const out: NodeForIndex[] = [];
  for (const n of g.nodes.values()) {
    out.push({
      id: n.id,
      type: n.type,
      title: n.title,
      body: n._body,
      tags: Array.isArray(n.fields?.tags) ? n.fields.tags : undefined,
      fields: n.fields,
    });
  }
  return out;
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

async function ensureFreshIndex(quiet = false): Promise<void> {
  const nodes = nodesFromGraph();
  const idx = loadIndex();
  // Compare by id+contentHash via updateIndex which is idempotent. Skip rebuild
  // if file exists AND every desired node already matches.
  if (existsSync(EMBEDDINGS_PATH)) {
    // Cheap check first: same node count?
    const indexedIds = new Set(idx.entries.map((e) => e.id));
    let needsAny = false;
    for (const n of nodes) {
      if (!indexedIds.has(n.id)) {
        needsAny = true;
        break;
      }
    }
    if (!needsAny && idx.entries.length === nodes.length) {
      // Hash check is the only way to be 100% sure but is expensive — let scan handle it.
      // For search, accept "all ids present" as good enough.
      return;
    }
  }
  if (!quiet) process.stderr.write("🧬 building embedding index...\n");
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

async function cmdSearch(rawArgs: string[]): Promise<void> {
  const top = parseInt(flagArg(rawArgs, "--top") || "5", 10);
  const typeFilter = flagArg(rawArgs, "--type");
  const asJson = flagBool(rawArgs, "--json");
  const quiet = flagBool(rawArgs, "--quiet") || asJson;

  let args = dropFlag(rawArgs, "--top", true);
  args = dropFlag(args, "--type", true);
  args = dropFlag(args, "--json", false);
  args = dropFlag(args, "--quiet", false);

  const query = args.join(" ").trim();
  if (!query) {
    console.error("Usage: dna search <query> [--top N] [--type TYPE] [--json]");
    process.exit(1);
  }

  await ensureFreshIndex(quiet);
  const idx = loadIndex();
  if (!idx.entries.length) {
    console.error("⚠️  Embedding index is empty (no mesh nodes).");
    process.exit(1);
  }

  const qVec = await embed(query);
  const candidates = typeFilter
    ? idx.entries.filter((e) => e.type === typeFilter)
    : idx.entries;
  const scored = candidates
    .map((e) => ({ entry: e, score: cosineSim(qVec, e.vector) }))
    .sort((a, b) => b.score - a.score)
    .slice(0, top);

  if (asJson) {
    console.log(
      JSON.stringify(
        scored.map((s) => ({
          id: s.entry.id,
          type: s.entry.type,
          title: s.entry.title,
          score: Number(s.score.toFixed(4)),
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
    `🔎 Top ${scored.length} results for "${query}"${typeFilter ? ` (type=${typeFilter})` : ""}:\n`,
  );
  for (const s of scored) {
    const score = (s.score * 100).toFixed(1);
    const type = s.entry.type.padEnd(12);
    console.log(`  ${score.padStart(5)}%  ${type}  ${s.entry.id}`);
    if (s.entry.title && s.entry.title !== s.entry.id) {
      console.log(`             ${"".padEnd(12)}  └─ ${s.entry.title}`);
    }
  }
  console.log("");
  console.log(`💡 dna show <id> for full content. dna search --type philosophy <q> to filter.`);
}

async function cmdStatus(): Promise<void> {
  const idx = loadIndex();
  const exists = existsSync(EMBEDDINGS_PATH);
  console.log(`Index path:   ${EMBEDDINGS_PATH}`);
  console.log(`Exists:       ${exists}`);
  console.log(`Model:        ${idx.model}`);
  console.log(`Schema ver:   ${idx.version}`);
  console.log(`Entries:      ${idx.entries.length}`);
  if (exists) {
    const sz = statSync(EMBEDDINGS_PATH).size;
    console.log(`File size:    ${(sz / 1024).toFixed(1)} KB`);
  }
  if (idx.entries.length) {
    const types = new Map<string, number>();
    for (const e of idx.entries) types.set(e.type, (types.get(e.type) || 0) + 1);
    console.log("By type:");
    for (const [t, n] of [...types.entries()].sort((a, b) => b[1] - a[1])) {
      console.log(`   ${t.padEnd(15)} ${n}`);
    }
  }
}

function printHelp(): void {
  console.log(`🔎 DNA Search — semantic search over the mesh (local ONNX embeddings)

Usage:
  dna search <query>                Top 5 results across all node types
  dna search <query> --top 10       Limit results
  dna search <query> --type TYPE    Filter by node type (philosophy/convention/...)
  dna search <query> --json         Machine-readable output
  dna search --reindex              Force full re-embed
  dna search --status               Show index info

Examples:
  dna search "graph traversal"
  dna search "test before code" --type philosophy
  dna search --status

Index: ${EMBEDDINGS_PATH}
Model: Xenova/all-MiniLM-L6-v2 (downloaded once to ~/.cache/huggingface/)
`);
}

// ── main ────────────────────────────────────────────────────────────────────

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
