/**
 * Local ONNX-based embeddings for DNA mesh nodes.
 *
 * Stack:
 *   - @huggingface/transformers (pure JS ONNX runtime, no Python, no network at query time)
 *   - Model: Xenova/all-MiniLM-L6-v2 (384-d, ~22MB, downloaded once on first use)
 *   - Storage: <DNA_DATA>/.embeddings.json — incremental (re-embed only changed contentHash)
 *
 * Used by scripts/search-cli.ts. Lazy-loaded to keep `dna` startup latency unaffected
 * when no search is happening.
 */
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { DNA_DATA } from "./common.ts";

export const EMBEDDINGS_PATH = join(DNA_DATA, ".embeddings.json");
export const EMBEDDINGS_VERSION = 1;
export const MODEL_ID = "Xenova/all-MiniLM-L6-v2";

export interface EmbeddingEntry {
  id: string;            // mesh node id
  type: string;          // node.type (philosophy, convention, ...)
  title?: string;        // human label for result printing
  contentHash: string;   // sha256(text used for embedding)
  vector: number[];      // 384-d float, NORMALIZED (unit length) so cosine == dot product
}

export interface EmbeddingsIndex {
  version: number;
  model: string;
  entries: EmbeddingEntry[];
}

// ── hashing & text prep ────────────────────────────────────────────────────

/** Build the embedding input text for a node. */
export function buildEmbedText(args: {
  id: string;
  title?: string;
  body?: string;
  tags?: string[];
  fields?: Record<string, any>;
}): string {
  const parts: string[] = [];
  if (args.title) parts.push(args.title);
  // id often contains semantic tokens (e.g. "test-driven", "graph-traversal")
  parts.push(args.id.replace(/[/-]/g, " "));
  if (args.body) parts.push(args.body);
  if (args.tags?.length) parts.push(args.tags.join(" "));
  // Pull a few semantically-relevant fields if no body
  if (!args.body && args.fields) {
    for (const k of ["description", "purpose", "goal", "summary", "what", "why"]) {
      const v = args.fields[k];
      if (typeof v === "string") parts.push(v);
    }
  }
  return parts.join("\n").trim();
}

export function contentHashOf(text: string): string {
  return createHash("sha256").update(text).digest("hex").slice(0, 16);
}

// ── index load / save ──────────────────────────────────────────────────────

export function loadIndex(): EmbeddingsIndex {
  if (!existsSync(EMBEDDINGS_PATH)) {
    return { version: EMBEDDINGS_VERSION, model: MODEL_ID, entries: [] };
  }
  try {
    const raw = JSON.parse(readFileSync(EMBEDDINGS_PATH, "utf8")) as EmbeddingsIndex;
    if (raw.version !== EMBEDDINGS_VERSION || raw.model !== MODEL_ID) {
      // Schema/model mismatch — discard, force re-index
      return { version: EMBEDDINGS_VERSION, model: MODEL_ID, entries: [] };
    }
    return raw;
  } catch {
    return { version: EMBEDDINGS_VERSION, model: MODEL_ID, entries: [] };
  }
}

export function saveIndex(idx: EmbeddingsIndex): void {
  mkdirSync(dirname(EMBEDDINGS_PATH), { recursive: true });
  writeFileSync(EMBEDDINGS_PATH, JSON.stringify(idx));
}

// ── model loader (lazy, cached for the process lifetime) ───────────────────

let _embedder: any = null;
let _loadPromise: Promise<any> | null = null;

export async function loadModel(quiet = false): Promise<any> {
  if (_embedder) return _embedder;
  if (_loadPromise) return _loadPromise;
  _loadPromise = (async () => {
    if (!quiet) process.stderr.write("⏳ loading embedding model (first run downloads ~22MB)...\n");
    const tx = await import("@huggingface/transformers");
    const pipe = await (tx as any).pipeline("feature-extraction", MODEL_ID, {
      // Quantized = smaller download + faster CPU inference; fine for retrieval
      dtype: "q8",
    });
    _embedder = pipe;
    return pipe;
  })();
  return _loadPromise;
}

/** Embed a single text → 384-d unit-normalized Float32. */
export async function embed(text: string): Promise<number[]> {
  const pipe = await loadModel(true);
  const out = await pipe(text, { pooling: "mean", normalize: true });
  // out.data is a TypedArray
  return Array.from(out.data as Float32Array);
}

/** Embed many texts (still serial — model is single-threaded). Calls cb after each for progress. */
export async function embedMany(
  texts: string[],
  onTick?: (i: number, total: number) => void,
): Promise<number[][]> {
  const pipe = await loadModel();
  const total = texts.length;
  const vectors: number[][] = [];
  for (let i = 0; i < total; i++) {
    const out = await pipe(texts[i], { pooling: "mean", normalize: true });
    vectors.push(Array.from(out.data as Float32Array));
    onTick?.(i + 1, total);
  }
  return vectors;
}

// ── similarity ─────────────────────────────────────────────────────────────

/** Cosine similarity for unit-normalized vectors == dot product. Defensive code path included. */
export function cosineSim(a: number[], b: number[]): number {
  if (a.length !== b.length) return 0;
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  if (na === 0 || nb === 0) return 0;
  // Vectors are stored normalized → na≈nb≈1 → this collapses to dot
  return dot / (Math.sqrt(na) * Math.sqrt(nb));
}

// ── incremental index update ───────────────────────────────────────────────

export interface NodeForIndex {
  id: string;
  type: string;
  title?: string;
  body?: string;
  tags?: string[];
  fields?: Record<string, any>;
}

export interface UpdateStats {
  total: number;
  embedded: number;
  reused: number;
  removed: number;
}

/**
 * Update the embedding index from a snapshot of nodes. Re-embeds only nodes whose
 * contentHash changed (or weren't indexed before). Removes entries for vanished nodes.
 *
 * Returns {total, embedded, reused, removed}. Caller decides whether to print progress.
 */
export async function updateIndex(
  nodes: NodeForIndex[],
  onProgress?: (i: number, total: number, what: string) => void,
): Promise<{ index: EmbeddingsIndex; stats: UpdateStats }> {
  const old = loadIndex();
  const oldById = new Map(old.entries.map((e) => [e.id, e]));

  const desired: Array<{ node: NodeForIndex; text: string; hash: string }> = [];
  for (const n of nodes) {
    const text = buildEmbedText(n);
    if (!text) continue;
    desired.push({ node: n, text, hash: contentHashOf(text) });
  }

  // Determine which need (re-)embedding
  const toEmbed = desired.filter((d) => oldById.get(d.node.id)?.contentHash !== d.hash);
  const reused = desired.length - toEmbed.length;

  // Build new entries: reuse where possible
  const newEntries: EmbeddingEntry[] = [];

  // First pass: reuse
  for (const d of desired) {
    const prev = oldById.get(d.node.id);
    if (prev && prev.contentHash === d.hash) {
      newEntries.push({ ...prev, type: d.node.type, title: d.node.title });
    }
  }

  // Second pass: embed the changed/new ones
  if (toEmbed.length) {
    await loadModel();
    for (let i = 0; i < toEmbed.length; i++) {
      const d = toEmbed[i];
      onProgress?.(i + 1, toEmbed.length, d.node.id);
      const vec = await embed(d.text);
      newEntries.push({
        id: d.node.id,
        type: d.node.type,
        title: d.node.title,
        contentHash: d.hash,
        vector: vec,
      });
    }
  }

  const removed = old.entries.length - reused;

  const idx: EmbeddingsIndex = {
    version: EMBEDDINGS_VERSION,
    model: MODEL_ID,
    entries: newEntries,
  };
  return {
    index: idx,
    stats: {
      total: desired.length,
      embedded: toEmbed.length,
      reused,
      removed: removed > 0 ? removed : 0,
    },
  };
}
