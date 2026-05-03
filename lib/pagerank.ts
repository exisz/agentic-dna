/**
 * Graph metrics over the DNA mesh — currently: PageRank.
 *
 * Why PageRank? In a governance mesh, "important" ≈ "many things depend on it,
 * and those things are themselves important". A keystone philosophy referenced
 * by many keystone conventions ranks higher than an isolated note. We use this
 * to break ties in search ranking and to expose `dna mesh centrality`.
 *
 * Implementation: graphology (TS-native, tiny, well-tested). We build a directed
 * graph from inbound edges (X depends on Y → edge Y → X is a "vote" for Y from X).
 * That matches the Web-PageRank intuition: link = vote.
 *
 * Cached at <DNA_DATA>/.pagerank.json — invalidated by mesh edge count.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import Graph from "graphology";
import pagerank from "graphology-metrics/centrality/pagerank.js";
import { DNA_DATA } from "./common.ts";
import type { MeshGraph } from "../scripts/mesh-cli.ts";

export const PAGERANK_PATH = join(DNA_DATA, ".pagerank.json");
export const PAGERANK_VERSION = 1;

export interface PageRankIndex {
  version: number;
  /** edge count signature — re-compute if the mesh edge count changes */
  edgeSignature: string;
  /** {nodeId: rank} — values sum to ~1.0 (graphology default) */
  ranks: Record<string, number>;
}

/** Build a graphology directed graph from a MeshGraph. Each outbound edge becomes a directed edge. */
function meshToGraphology(g: MeshGraph): { gr: Graph; edgeCount: number } {
  const gr = new Graph({ type: "directed", multi: false, allowSelfLoops: false });
  for (const id of g.nodes.keys()) gr.addNode(id);
  let edgeCount = 0;
  for (const node of g.nodes.values()) {
    for (const e of node.outbound) {
      // Only count edges to nodes we actually have (skip dead links — they're not "votes")
      if (!gr.hasNode(e.target)) continue;
      if (node.id === e.target) continue; // skip self
      // PageRank intuition: an outbound edge from X to Y is a vote for Y from X.
      // Our edge already goes X → Y (X references Y), so direction is right.
      if (!gr.hasEdge(node.id, e.target)) {
        gr.addEdge(node.id, e.target);
        edgeCount++;
      }
    }
  }
  return { gr, edgeCount };
}

function signatureOf(g: MeshGraph): string {
  let edges = 0;
  for (const n of g.nodes.values()) edges += n.outbound.length;
  return `n${g.nodes.size}-e${edges}`;
}

export function loadPageRank(): PageRankIndex | null {
  if (!existsSync(PAGERANK_PATH)) return null;
  try {
    const idx = JSON.parse(readFileSync(PAGERANK_PATH, "utf8")) as PageRankIndex;
    if (idx.version !== PAGERANK_VERSION) return null;
    return idx;
  } catch {
    return null;
  }
}

export function savePageRank(idx: PageRankIndex): void {
  mkdirSync(dirname(PAGERANK_PATH), { recursive: true });
  writeFileSync(PAGERANK_PATH, JSON.stringify(idx));
}

/** Compute PageRank fresh from a mesh graph. */
export function computePageRank(g: MeshGraph): PageRankIndex {
  const { gr } = meshToGraphology(g);
  // Defaults: alpha=0.85, tolerance=1e-6, maxIter=100. Good for our scale.
  const ranks = pagerank(gr) as Record<string, number>;
  return {
    version: PAGERANK_VERSION,
    edgeSignature: signatureOf(g),
    ranks,
  };
}

/** Return cached or freshly-computed PageRank, persisting if recomputed. */
export function getOrComputePageRank(g: MeshGraph): PageRankIndex {
  const cached = loadPageRank();
  const sig = signatureOf(g);
  if (cached && cached.edgeSignature === sig) return cached;
  const fresh = computePageRank(g);
  savePageRank(fresh);
  return fresh;
}

/**
 * Map a raw PageRank value [0..1] into a small multiplier (1.0 .. 1.0+epsilon)
 * suitable for breaking ties in semantic-search ranking. We never want PageRank
 * to dominate cosine similarity — only to nudge equally-relevant results.
 *
 * Returns a multiplier in [1.0, 1.0 + maxBoost]. Default maxBoost=0.05 means
 * the highest-ranked node gets a 5% bump, the lowest essentially nothing.
 */
export function pagerankBoost(
  rank: number,
  maxRank: number,
  maxBoost = 0.05,
): number {
  if (maxRank <= 0) return 1;
  return 1 + (rank / maxRank) * maxBoost;
}

/** Get file size for status output. */
export function pagerankFileSize(): number {
  if (!existsSync(PAGERANK_PATH)) return 0;
  return statSync(PAGERANK_PATH).size;
}
