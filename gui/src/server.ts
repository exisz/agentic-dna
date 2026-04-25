/**
 * DNA UI — Express + Vite-Express server
 * Serves API for mesh visualization and the React SPA.
 */
import express from "express";
import ViteExpress from "vite-express";
import { readFileSync, existsSync, statSync, lstatSync } from "node:fs";
import { join, resolve, dirname } from "node:path";
import { homedir } from "node:os";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";
import yaml from "js-yaml";
import { loadConfig as loadDnaConfig } from "../../lib/config.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const PORT = parseInt(process.env.PORT || "4893", 10);

// ── Resolve DNA_DATA the same way the bin/dna script does ────────────
function isDir(p: string): boolean {
  try { return statSync(p).isDirectory(); } catch { return false; }
}
function resolveDnaData(): string {
  if (process.env.DNA_DATA && isDir(process.env.DNA_DATA)) return process.env.DNA_DATA;
  const candidates = [
    join(homedir(), ".dna"),
    join(homedir(), ".openclaw", ".dna"),
    join(homedir(), ".agentic-dna"),
  ];
  for (const c of candidates) if (isDir(c)) return c;
  return candidates[1];
}
const DNA_DATA = resolveDnaData();
const CACHE_PATH = join(DNA_DATA, ".mesh-cache.json");

// ── Cache loader ─────────────────────────────────────────────────────
interface CachedOutbound { target: string; kind?: string }
interface CachedNode {
  id: string;
  type: string;
  title?: string;
  path: string;
  status?: string;
  managed_by?: string;
  // Newer cache writes objects; older versions wrote bare strings.
  outbound: Array<string | CachedOutbound>;
}

/** Normalize an outbound entry (string or {target, kind}) to {target, kind?}. */
function normOut(e: string | CachedOutbound): CachedOutbound {
  return typeof e === "string" ? { target: e } : e;
}
interface MeshCache {
  generated_at: string;
  stats: { nodes: number; edges: number; deadLinks: number };
  nodes: CachedNode[];
}

let cache: MeshCache | null = null;
let cacheMtime = 0;

function loadCache(): MeshCache {
  if (!existsSync(CACHE_PATH)) {
    // Try to build it
    try {
      execFileSync(resolve(__dirname, "../../bin/dna"), ["mesh", "scan"], {
        stdio: "inherit",
      });
    } catch {
      // ignore — fall through to error
    }
  }
  if (!existsSync(CACHE_PATH)) {
    throw new Error(
      `mesh cache not found at ${CACHE_PATH}. Run \`dna mesh scan\` first.`,
    );
  }
  const mtime = statSync(CACHE_PATH).mtimeMs;
  if (!cache || mtime !== cacheMtime) {
    cache = JSON.parse(readFileSync(CACHE_PATH, "utf-8"));
    cacheMtime = mtime;
  }
  return cache!;
}

// ── Frontmatter / body parsing for individual nodes ──────────────────
function parseFile(path: string): { fields: Record<string, any>; body: string } {
  if (!existsSync(path)) return { fields: {}, body: "" };
  const raw = readFileSync(path, "utf-8");
  // Markdown w/ frontmatter
  if (path.endsWith(".md")) {
    const m = raw.match(/^---\n([\s\S]*?)\n---\n?([\s\S]*)$/);
    if (m) {
      const fields = (yaml.load(m[1]) as Record<string, any>) || {};
      return { fields, body: m[2] };
    }
    return { fields: {}, body: raw };
  }
  // YAML
  if (path.endsWith(".yml") || path.endsWith(".yaml")) {
    try {
      const fields = (yaml.load(raw) as Record<string, any>) || {};
      return { fields, body: "" };
    } catch {
      return { fields: {}, body: raw };
    }
  }
  return { fields: {}, body: raw };
}

// ── App ──────────────────────────────────────────────────────────────
const app = express();
app.use(express.json());

app.get("/api/health", (_req, res) => {
  res.json({ ok: true, dna_data: DNA_DATA, port: PORT });
});

// Effective DNA config (built-in defaults ⊕ global ⊕ server-cwd local).
app.get("/api/config", (_req, res) => {
  try {
    const cfg = loadDnaConfig(process.cwd(), true);
    res.json(cfg);
  } catch (e: any) {
    res.status(500).json({ error: e.message });
  }
});

app.get("/api/nodes", (_req, res) => {
  try {
    const c = loadCache();
    res.json({
      generated_at: c.generated_at,
      stats: c.stats,
      nodes: c.nodes.map((n) => ({
        id: n.id,
        type: n.type,
        title: n.title || n.id.split("/").pop(),
        outboundCount: n.outbound.length,
        status: n.status,
        managedBy: n.managed_by,
      })),
      edges: c.nodes.flatMap((n) =>
        (n.outbound || []).map((e: any) => {
          const o = normOut(e);
          const target = typeof o.target === 'object' && o.target !== null ? (o.target as any).target || String(o.target) : o.target;
          const verb = o.kind || (typeof o.target === 'object' ? (o.target as any).kind : undefined);
          return { source: n.id, target: String(target), verb: verb || undefined };
        }),
      ),
    });
  } catch (e: any) {
    res.status(500).json({ error: e.message });
  }
});

app.get("/api/stats", (_req, res) => {
  try {
    const c = loadCache();
    const byType: Record<string, number> = {};
    for (const n of c.nodes) byType[n.type] = (byType[n.type] || 0) + 1;
    res.json({
      generated_at: c.generated_at,
      total_nodes: c.stats.nodes,
      total_edges: c.stats.edges,
      dead_links: c.stats.deadLinks,
      by_type: byType,
    });
  } catch (e: any) {
    res.status(500).json({ error: e.message });
  }
});

app.get("/api/search", (req, res) => {
  const q = (req.query.q as string || "").toLowerCase().trim();
  if (!q) return res.json({ results: [] });
  try {
    const c = loadCache();
    const results = c.nodes
      .filter(
        (n) =>
          n.id.toLowerCase().includes(q) ||
          (n.title || "").toLowerCase().includes(q) ||
          n.type.toLowerCase().includes(q),
      )
      .slice(0, 50)
      .map((n) => ({ id: n.id, type: n.type, title: n.title }));
    res.json({ results });
  } catch (e: any) {
    res.status(500).json({ error: e.message });
  }
});

// /api/node/* — match the rest of the path (URI contains slashes)
app.get(/^\/api\/node\/(.+)$/, (req, res) => {
  const id = decodeURIComponent(req.params[0]);
  const fullId = id.startsWith("dna://") ? id : `dna://${id}`;
  try {
    const c = loadCache();
    const node = c.nodes.find((n) => n.id === fullId);
    if (!node) return res.status(404).json({ error: `not found: ${fullId}` });
    const { fields, body } = parseFile(node.path);
    // Inbound edges
    const inbound = c.nodes
      .filter((n) => n.outbound.some((e) => normOut(e).target === fullId))
      .map((n) => ({ id: n.id, type: n.type, title: n.title }));
    res.json({
      id: node.id,
      type: node.type,
      title: node.title,
      path: node.path,
      // Return as plain target id strings for backward compat with the client.
      outbound: node.outbound.map((e) => normOut(e).target),
      inbound,
      fields,
      body,
    });
  } catch (e: any) {
    res.status(500).json({ error: e.message });
  }
});

// ── Boot ─────────────────────────────────────────────────────────────
const server = app.listen(PORT, () => {
  console.log(`🧬 DNA UI listening on http://localhost:${PORT}`);
  console.log(`   DNA_DATA = ${DNA_DATA}`);
});

ViteExpress.config({
  mode: (process.env.NODE_ENV === "production" ? "production" : "development") as any,
  inlineViteConfig: {
    root: resolve(__dirname, "client"),
    build: { outDir: resolve(__dirname, "../dist/client") },
  },
});
ViteExpress.bind(app, server);
