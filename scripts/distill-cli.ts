#!/usr/bin/env tsx
/**
 * DNA Distill — semantic dedup / distillation audit for DNA + Markdown.
 *
 * Purpose: DNA is the canonical distilled knowledge layer. This command finds
 * repeated / overlapping knowledge so agents can replace prose repetition with
 * pointers, merge DNA entries, or promote repeated Markdown into DNA.
 *
 * MVP commands:
 *   dna distill scan [--threshold 0.82] [--top 30] [--json] [--scope cwd|global]
 *   dna distill guard <concept> [--top 8] [--json]
 */
import { existsSync, readFileSync, readdirSync, statSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { buildGraph } from "./mesh-cli.ts";
import { DNA_DATA, HOME, parseFrontmatter, workspaceFromCwd } from "../lib/common.ts";
import { buildEmbedText, contentHashOf, cosineSim, embed } from "../lib/embeddings.ts";

const DISTILL_INDEX_PATH = join(DNA_DATA, ".distill-embeddings.json");
const MAX_DEPTH = 10;
const MIN_CHARS = 140;
const DEFAULT_THRESHOLD = 0.82;
const DEFAULT_TOP = 30;

const SKIP_DIRS = new Set([
  ".git", "node_modules", "dist", "build", ".next", ".turbo", ".cache",
  "coverage", "logs", "tmp", "vendor", ".venv", "venv", "__pycache__",
]);

const SKIP_MARKDOWN_BASENAMES = new Set([
  "CODE_OF_CONDUCT.md", "LICENSE.md", "SECURITY.md", "CHANGELOG.md",
]);

interface Artifact {
  id: string;
  source: "dna" | "markdown";
  type: string;
  title?: string;
  path: string;
  relPath: string;
  text: string;
  hash: string;
}

interface CachedVector {
  id: string;
  hash: string;
  vector: number[];
}

interface DistillIndex {
  version: 1;
  model: string;
  entries: CachedVector[];
}

interface PairFinding {
  score: number;
  class: "dna-markdown" | "dna-dna" | "markdown-markdown";
  action: string;
  canonical: Artifact;
  duplicate: Artifact;
}

function flagArg(args: string[], name: string): string | undefined {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
}

function flagBool(args: string[], name: string): boolean {
  return args.includes(name);
}

function stripFlags(args: string[], specs: Record<string, boolean>): string[] {
  const out: string[] = [];
  for (let i = 0; i < args.length; i++) {
    if (Object.prototype.hasOwnProperty.call(specs, args[i])) {
      if (specs[args[i]]) i++;
      continue;
    }
    out.push(args[i]);
  }
  return out;
}

function walk(root: string, depth = 0): string[] {
  if (!existsSync(root) || depth > MAX_DEPTH) return [];
  let entries: string[] = [];
  try { entries = readdirSync(root); } catch { return []; }
  const out: string[] = [];
  for (const name of entries) {
    if (SKIP_DIRS.has(name)) continue;
    if (name.startsWith(".") && name !== ".dna" && name !== ".openclaw") continue;
    const full = join(root, name);
    let st;
    try { st = statSync(full); } catch { continue; }
    if (st.isDirectory()) out.push(...walk(full, depth + 1));
    else if (st.isFile() && name.endsWith(".md")) {
      if (SKIP_MARKDOWN_BASENAMES.has(name)) continue;
      if (name.endsWith(".hydrated.md")) continue; // generated dna hydrate output
      out.push(full);
    }
  }
  return out;
}

function scanRoots(scope: "cwd" | "global"): string[] {
  if (scope === "cwd") {
    const ws = workspaceFromCwd(process.cwd()) || process.cwd();
    return [ws];
  }
  return [
    join(HOME, ".openclaw/workspace"),
    join(HOME, ".openclaw/workspaces"),
    join(HOME, ".openclaw/realms"),
    join(HOME, ".openclaw/.dna"),
    join(HOME, ".dna"),
  ].filter((p, i, arr) => existsSync(p) && arr.indexOf(p) === i);
}

function compact(s: string): string {
  return s.replace(/```[\s\S]*?```/g, " ")
    .replace(/<!--([\s\S]*?)-->/g, " ")
    .replace(/\{\{dna[^}]+\}\}/g, " ")
    .replace(/[#>*_`\-[\]()]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function slug(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9\u4e00-\u9fff]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 80) || "section";
}

function rel(p: string): string {
  const r = relative(process.cwd(), p);
  return r.startsWith("..") ? p.replace(HOME, "~") : r;
}

function splitMarkdown(path: string): Artifact[] {
  let raw = "";
  try { raw = readFileSync(path, "utf8"); } catch { return []; }
  const { meta, body } = parseFrontmatter(raw);
  const sections: Array<{ title: string; body: string }> = [];
  const lines = body.split(/\r?\n/);
  let currentTitle = String(meta.title || "preamble");
  let buf: string[] = [];
  const flush = () => {
    const text = compact(buf.join("\n"));
    if (text.length >= MIN_CHARS) sections.push({ title: currentTitle, body: text });
    buf = [];
  };
  for (const line of lines) {
    const m = line.match(/^(#{1,3})\s+(.+)$/);
    if (m) {
      flush();
      currentTitle = m[2].trim();
    } else {
      buf.push(line);
    }
  }
  flush();

  // If headings made the file too fragmented, keep a whole-file fallback.
  if (!sections.length) {
    const text = compact(body);
    if (text.length >= MIN_CHARS) sections.push({ title: String(meta.title || path.split("/").pop()), body: text });
  }

  const rp = rel(path);
  return sections.map((s) => {
    const id = `markdown://${rp}#${slug(s.title)}`;
    return {
      id,
      source: "markdown",
      type: "markdown",
      title: s.title,
      path,
      relPath: rp,
      text: s.body,
      hash: contentHashOf(s.body),
    } satisfies Artifact;
  });
}

function collectArtifacts(scope: "cwd" | "global"): Artifact[] {
  const graph = buildGraph();
  const meshPaths = new Set<string>();
  const artifacts: Artifact[] = [];

  for (const n of graph.nodes.values() as Iterable<any>) {
    if (n.path) meshPaths.add(resolve(n.path));
    const text = compact(buildEmbedText({
      id: n.id,
      title: n.title,
      body: n._body,
      tags: Array.isArray(n.fields?.tags) ? n.fields.tags : undefined,
      fields: n.fields,
    }));
    if (text.length < MIN_CHARS) continue;
    artifacts.push({
      id: n.id,
      source: "dna",
      type: n.type || "dna",
      title: n.title,
      path: n.path || "",
      relPath: n.path ? rel(n.path) : n.id,
      text,
      hash: contentHashOf(text),
    });
  }

  for (const root of scanRoots(scope)) {
    for (const md of walk(root)) {
      // Frontmatter mesh Markdown is represented as DNA above; avoid comparing it to itself.
      if (meshPaths.has(resolve(md))) continue;
      artifacts.push(...splitMarkdown(md));
    }
  }

  // Dedupe IDs, preserving first occurrence.
  const seen = new Set<string>();
  return artifacts.filter((a) => {
    if (seen.has(a.id)) return false;
    seen.add(a.id);
    return true;
  });
}

function loadDistillIndex(): DistillIndex {
  if (!existsSync(DISTILL_INDEX_PATH)) return { version: 1, model: "Xenova/all-MiniLM-L6-v2", entries: [] };
  try {
    const parsed = JSON.parse(readFileSync(DISTILL_INDEX_PATH, "utf8"));
    if (parsed.version === 1 && Array.isArray(parsed.entries)) return parsed;
  } catch {}
  return { version: 1, model: "Xenova/all-MiniLM-L6-v2", entries: [] };
}

function saveDistillIndex(idx: DistillIndex): void {
  mkdirSync(dirname(DISTILL_INDEX_PATH), { recursive: true });
  writeFileSync(DISTILL_INDEX_PATH, JSON.stringify(idx));
}

async function vectorsFor(artifacts: Artifact[], quiet = false): Promise<Map<string, number[]>> {
  const old = loadDistillIndex();
  const oldById = new Map(old.entries.map((e) => [e.id, e]));
  const entries: CachedVector[] = [];
  const out = new Map<string, number[]>();
  let embedded = 0;

  for (let i = 0; i < artifacts.length; i++) {
    const a = artifacts[i];
    const cached = oldById.get(a.id);
    if (cached?.hash === a.hash) {
      entries.push(cached);
      out.set(a.id, cached.vector);
      continue;
    }
    if (!quiet && (embedded === 0 || embedded % 25 === 0)) {
      process.stderr.write(`  embedding ${embedded + 1}+ / ${artifacts.length}: ${a.id}\n`);
    }
    const vector = await embed(a.text);
    embedded++;
    const e = { id: a.id, hash: a.hash, vector };
    entries.push(e);
    out.set(a.id, vector);
  }

  saveDistillIndex({ version: 1, model: old.model || "Xenova/all-MiniLM-L6-v2", entries });
  if (!quiet && embedded) process.stderr.write(`✅ distill embeddings updated: ${embedded} embedded, ${artifacts.length - embedded} reused\n`);
  return out;
}

function pairClass(a: Artifact, b: Artifact): PairFinding["class"] {
  if (a.source === "dna" && b.source === "dna") return "dna-dna";
  if (a.source === "markdown" && b.source === "markdown") return "markdown-markdown";
  return "dna-markdown";
}

function canonicalize(a: Artifact, b: Artifact): { canonical: Artifact; duplicate: Artifact } {
  if (a.source === "dna" && b.source === "markdown") return { canonical: a, duplicate: b };
  if (b.source === "dna" && a.source === "markdown") return { canonical: b, duplicate: a };
  // For same-source pairs, choose shorter / more slug-like item as tentative canonical.
  const score = (x: Artifact) => (x.source === "dna" ? 1000 : 0) - x.text.length / 100 + (x.title ? 5 : 0);
  return score(a) >= score(b) ? { canonical: a, duplicate: b } : { canonical: b, duplicate: a };
}

function recommendedAction(cls: PairFinding["class"]): string {
  switch (cls) {
    case "dna-markdown": return "replace repeated Markdown with {{dna ... --inject ...}} pointer or inline dna:// reference";
    case "dna-dna": return "merge/retire one DNA entry; keep one canonical slug";
    case "markdown-markdown": return "extract/distill shared idea into DNA, then point both Markdown sections at it";
  }
}

function buildFindings(artifacts: Artifact[], vectors: Map<string, number[]>, threshold: number, top: number): PairFinding[] {
  const findings: PairFinding[] = [];
  for (let i = 0; i < artifacts.length; i++) {
    const av = vectors.get(artifacts[i].id);
    if (!av) continue;
    for (let j = i + 1; j < artifacts.length; j++) {
      const bv = vectors.get(artifacts[j].id);
      if (!bv) continue;
      const score = cosineSim(av, bv);
      if (score < threshold) continue;
      const cls = pairClass(artifacts[i], artifacts[j]);
      const { canonical, duplicate } = canonicalize(artifacts[i], artifacts[j]);
      findings.push({ score, class: cls, action: recommendedAction(cls), canonical, duplicate });
    }
  }
  return findings.sort((a, b) => b.score - a.score).slice(0, top);
}

function jsonFinding(f: PairFinding) {
  return {
    score: Number(f.score.toFixed(4)),
    class: f.class,
    action: f.action,
    canonical: { id: f.canonical.id, source: f.canonical.source, type: f.canonical.type, title: f.canonical.title, path: f.canonical.relPath },
    duplicate: { id: f.duplicate.id, source: f.duplicate.source, type: f.duplicate.type, title: f.duplicate.title, path: f.duplicate.relPath },
  };
}

async function cmdScan(args: string[]): Promise<void> {
  const threshold = Number(flagArg(args, "--threshold") || DEFAULT_THRESHOLD);
  const top = Number(flagArg(args, "--top") || DEFAULT_TOP);
  const asJson = flagBool(args, "--json");
  const quiet = asJson || flagBool(args, "--quiet");
  const scope = (flagArg(args, "--scope") === "global" ? "global" : "cwd") as "cwd" | "global";

  const artifacts = collectArtifacts(scope);
  const vectors = await vectorsFor(artifacts, quiet);
  const findings = buildFindings(artifacts, vectors, threshold, top);

  if (asJson) {
    console.log(JSON.stringify({ threshold, scope, artifacts: artifacts.length, findings: findings.map(jsonFinding) }, null, 2));
    return;
  }

  console.log(`🧬 DNA Distill scan — ${artifacts.length} artifacts, threshold=${threshold}, scope=${scope}`);
  if (!findings.length) {
    console.log("No duplicate candidates found. Try lowering --threshold, e.g. 0.76.");
    return;
  }
  console.log("");
  for (const [idx, f] of findings.entries()) {
    console.log(`${String(idx + 1).padStart(2)}. ${(f.score * 100).toFixed(1)}%  ${f.class}`);
    console.log(`    canonical: ${f.canonical.id}`);
    if (f.canonical.title) console.log(`               ${f.canonical.title}`);
    console.log(`               ${f.canonical.relPath}`);
    console.log(`    duplicate: ${f.duplicate.id}`);
    if (f.duplicate.title) console.log(`               ${f.duplicate.title}`);
    console.log(`               ${f.duplicate.relPath}`);
    console.log(`    action:    ${f.action}`);
    console.log("");
  }
}

async function cmdGuard(args: string[]): Promise<void> {
  const top = Number(flagArg(args, "--top") || "8");
  const asJson = flagBool(args, "--json");
  const quiet = asJson || flagBool(args, "--quiet");
  const query = stripFlags(args, { "--top": true, "--json": false, "--quiet": false }).join(" ").trim();
  if (!query) {
    console.error("Usage: dna distill guard <concept> [--top N] [--json]");
    process.exit(1);
  }

  const artifacts = collectArtifacts("global");
  const vectors = await vectorsFor(artifacts, quiet);
  const qVec = await embed(query);
  const ranked = artifacts.map((a) => ({ a, score: cosineSim(qVec, vectors.get(a.id) || []) }))
    .filter((x) => x.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, top);

  if (asJson) {
    console.log(JSON.stringify(ranked.map((x) => ({
      score: Number(x.score.toFixed(4)),
      id: x.a.id,
      source: x.a.source,
      type: x.a.type,
      title: x.a.title,
      path: x.a.relPath,
      recommended: x.a.source === "dna" ? "use existing DNA pointer" : "consider distilling this Markdown into DNA first",
    })), null, 2));
    return;
  }

  console.log(`🛡️  Distill guard for "${query}"`);
  console.log("Use an existing canonical entry instead of writing another copy when possible.\n");
  for (const x of ranked) {
    const pct = (x.score * 100).toFixed(1).padStart(5);
    const rec = x.a.source === "dna" ? "use pointer" : "candidate source for distillation";
    console.log(`  ${pct}%  ${x.a.source.padEnd(8)} ${x.a.type.padEnd(12)} ${x.a.id}`);
    if (x.a.title) console.log(`          ${x.a.title}`);
    console.log(`          ${x.a.relPath}`);
    console.log(`          → ${rec}`);
  }
}

function printHelp(): void {
  console.log(`🧬 DNA Distill — semantic dedup / knowledge distillation audit

Usage:
  dna distill scan [--threshold 0.82] [--top 30] [--scope cwd|global] [--json]
  dna distill guard <concept> [--top 8] [--json]

Dedup classes:
  dna-markdown        Markdown repeats canonical DNA → replace prose with pointer/injection
  dna-dna             DNA entries overlap → merge/retire one canonical slug
  markdown-markdown   Markdown repeats Markdown → extract/distill into DNA

Default is read-only. No files are mutated.
`);
}

const _arg1 = process.argv[1] || "";
const _basename = _arg1.split("/").pop() || "";
const isMain = _basename === "distill-cli.js" || _basename === "distill-cli.ts";

if (isMain) {
  const [subcmd, ...rest] = process.argv.slice(2);
  (async () => {
    switch (subcmd) {
      case "scan": await cmdScan(rest); break;
      case "guard": await cmdGuard(rest); break;
      case "help":
      case "--help":
      case "-h":
      case undefined:
        printHelp(); break;
      default:
        console.error(`Unknown distill subcommand: ${subcmd}`);
        printHelp();
        process.exit(1);
    }
  })().catch((err) => {
    console.error("❌", err?.message || err);
    process.exit(1);
  });
}
