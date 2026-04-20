#!/usr/bin/env node
/**
 * spec — GBTD (Goal / Boundary / Tools / Deprecated) CLI
 *
 * Usage:
 *   dna spec <workspace>                    Full GBTD
 *   dna spec <workspace> <dotpath>          Single node + parent chain
 *   dna spec <workspace> --tree             Compact tree overview
 *   dna spec <workspace> --json             JSON output
 *   dna spec <workspace> --goal             Goal text only
 *   dna spec <workspace> --boundary         Boundary list only
 *   dna spec <workspace> --tools            Tools list only
 *   dna spec <workspace> --deprecated       Deprecated patterns only
 *   dna spec <workspace> --spec             Read referenced spec document
 *   dna spec <workspace> --check-deprecated Audit active deprecations
 *   dna spec --global                       Global system-wide spec
 *   dna spec --repo owner/repo              Read dna.yaml from GitHub repo
 */
import { execSync } from "node:child_process";
import yaml from "js-yaml";
import { HOME, WORKSPACE_ROOTS, AGENT_REGISTRY, loadYaml, existsSync, readFileSync, statSync, join, normalize, resolve, isAbsolute } from "../lib/common.ts";

const GLOBAL_GOAL = join(HOME, ".openclaw/GOAL.yaml");
const GLOBAL_DNA = existsSync(join(HOME, ".openclaw/workspace/dna.yml"))
  ? join(HOME, ".openclaw/workspace/dna.yml")
  : join(HOME, ".openclaw/workspace/dna.yaml");
const FLAT_KEYS = new Set(["goal", "boundary", "tools", "philosophy", "deprecated", "spec", "id", "type", "title", "links"]);
const GBT_KEYS = new Set(["goal", "boundary", "tools", "serves", "not", "how", "deprecated", "spec", "philosophy"]);

const HELP = `📌 DNA Spec CLI — GBTD (Goal / Boundary / Tools / Deprecated)

Usage:
  dna spec <workspace>                    Full GBTD
  dna spec <workspace> <dotpath>          Single node + parent chain
  dna spec <workspace> --tree             Compact tree
  dna spec <workspace> --json             JSON output
  dna spec <workspace> --goal             Goal only
  dna spec <workspace> --boundary         Boundary only
  dna spec <workspace> --tools            Tools only
  dna spec <workspace> --deprecated       Deprecated patterns
  dna spec <workspace> --spec             Referenced spec document
  dna spec <workspace> --check-deprecated Audit active deprecations
  dna spec --global                       Global spec
  dna spec --repo owner/repo              From GitHub`;

// ── Helpers ──

function unwrapRoot(data: Record<string, any>): [string, Record<string, any>] {
  if (!data || !Object.keys(data).length) return ["unknown", {}];
  const firstKey = Object.keys(data)[0];
  if (FLAT_KEYS.has(firstKey)) return ["spec", data];
  const val = data[firstKey];
  return [firstKey, typeof val === "object" && !Array.isArray(val) ? val : {}];
}

function resolveWorkspace(nameOrPath: string): string {
  if (existsSync(nameOrPath) && statSync(nameOrPath).isDirectory()) {
    return resolve(nameOrPath);
  }
  // Check agent registry
  if (existsSync(AGENT_REGISTRY)) {
    const agents = loadYaml(AGENT_REGISTRY) as any[];
    if (Array.isArray(agents)) {
      for (const a of agents) {
        if (a.agentId === nameOrPath || (a.name || "").toLowerCase() === nameOrPath.toLowerCase()) {
          if (a.workspace && existsSync(a.workspace)) return a.workspace;
        }
      }
    }
  }
  for (const root of WORKSPACE_ROOTS) {
    const candidate = join(root, nameOrPath);
    if (existsSync(candidate)) return candidate;
  }
  return nameOrPath;
}

function resolveAgentId(workspace: string): string | null {
  if (!existsSync(AGENT_REGISTRY)) return null;
  const agents = loadYaml(AGENT_REGISTRY) as any[];
  if (!Array.isArray(agents)) return null;
  const norm = normalize(workspace);
  for (const a of agents) {
    if (a.workspace && normalize(a.workspace) === norm) return a.agentId;
  }
  return null;
}

function loadGoal(workspace: string): Record<string, any> {
  const dnaPath = existsSync(join(workspace, "dna.yml"))
    ? join(workspace, "dna.yml")
    : join(workspace, "dna.yaml");
  const goalPath = join(workspace, "GOAL.yaml");
  let data: any = null;
  if (existsSync(dnaPath)) {
    data = loadYaml(dnaPath);
    if (existsSync(goalPath)) {
      const goalData = loadYaml(goalPath);
      if (goalData && typeof goalData === "object") {
        for (const [k, v] of Object.entries(goalData as Record<string, any>)) {
          if (!(k in data)) data[k] = v;
        }
      }
    }
    return data;
  }
  if (existsSync(goalPath)) {
    data = loadYaml(goalPath);
    if (!data || typeof data !== "object") { console.error("❌ GOAL.yaml is not a valid mapping"); process.exit(1); }
    return data;
  }
  console.error(`❌ No dna.yaml or GOAL.yaml found in ${workspace}`);
  process.exit(1);
}

function loadFromGithub(repo: string): Record<string, any> {
  for (const filename of ["dna.yml", "dna.yaml", "GOAL.yaml"]) {
    try {
      const result = execSync(`gh api repos/${repo}/contents/${filename} --jq .content`, { timeout: 15000, encoding: "utf-8" }).trim();
      if (result) {
        const content = Buffer.from(result, "base64").toString("utf-8");
        const data = yaml.load(content) as any;
        if (data && typeof data === "object") return data;
      }
    } catch { /* continue */ }
  }
  console.error(`❌ No dna.yaml or GOAL.yaml found in repo ${repo}`);
  process.exit(1);
}

function loadSpecFromGithub(repo: string, specRef: string): string {
  try {
    const result = execSync(`gh api repos/${repo}/contents/${specRef} --jq .content`, { timeout: 15000, encoding: "utf-8" }).trim();
    if (result) return Buffer.from(result, "base64").toString("utf-8").trimEnd();
  } catch { /* fall through */ }
  console.error(`❌ Spec file '${specRef}' not found in repo ${repo}`);
  process.exit(1);
}

function loadGlobalGoal(): Record<string, any> | null {
  for (const p of [GLOBAL_DNA, GLOBAL_GOAL]) {
    const data = loadYaml(p);
    if (data && typeof data === "object") return data as Record<string, any>;
  }
  return null;
}

// ── Deprecated ──

interface DeprecatedPattern {
  pattern?: string; replacement?: string; reason?: string; since?: string;
  level: string; exempt: boolean; exempt_reason: string;
  [key: string]: any;
}

function getDeprecatedPatterns(globalData: Record<string, any> | null, agentData?: Record<string, any> | null, agentId?: string | null): DeprecatedPattern[] {
  const patterns: DeprecatedPattern[] = [];
  if (globalData) {
    const [, root] = unwrapRoot(globalData);
    for (const dep of (root.deprecated || []) as any[]) {
      let isExempt = false, exemptReason = "";
      if (agentId) {
        for (const ex of (dep.exemptions || []) as any[]) {
          if (ex.agentId === agentId) { isExempt = true; exemptReason = ex.reason || ""; break; }
        }
      }
      patterns.push({ ...dep, level: "global", exempt: isExempt, exempt_reason: exemptReason });
    }
  }
  if (agentData) {
    const [, root] = unwrapRoot(agentData);
    for (const dep of (root.deprecated || []) as any[]) {
      patterns.push({ ...dep, level: "agent", exempt: false, exempt_reason: "" });
    }
  }
  return patterns;
}

function displayDeprecated(patterns: DeprecatedPattern[], showExempt = true) {
  if (!patterns.length) { console.log("✅ No deprecated patterns defined."); return; }
  console.log("─── Deprecated Patterns ───\n");
  patterns.forEach((p, i) => {
    const exemptTag = p.exempt ? " ⚠️ EXEMPT" : "";
    console.log(`  ${i + 1}. [${p.level.toUpperCase()}]${exemptTag} ${p.pattern || "(no pattern)"}`);
    if (p.replacement) console.log(`     → Replacement: ${p.replacement}`);
    if (p.reason) console.log(`     → Reason: ${(p.reason as string).trim()}`);
    if (p.since) console.log(`     → Since: ${p.since}`);
    if (p.exempt && showExempt && p.exempt_reason) console.log(`     → Exemption reason: ${p.exempt_reason}`);
    console.log();
  });
}

// ── Display ──

function fmtValue(v: any): string {
  if (typeof v === "string") return v.trim();
  if (Array.isArray(v)) return v.map(item => `• ${item}`).join("\n");
  return String(v);
}

function displayNode(key: string, node: any, indent = 0) {
  const prefix = "  ".repeat(indent);
  console.log(`${prefix}📌 ${key}`);
  if (typeof node === "object" && node !== null && !Array.isArray(node)) {
    for (const [field, label] of [["goal", "Goal"], ["serves", "Serves"], ["not", "Not"]] as const) {
      if (node[field]) console.log(`${prefix}  ${label}: ${fmtValue(node[field])}`);
    }
    if (node.spec) console.log(`${prefix}  Spec: ${node.spec}`);
    if (node.how) console.log(`${prefix}  How: ${fmtValue(node.how)}`);
    for (const field of ["boundary", "tools"] as const) {
      if (node[field]) {
        console.log(`${prefix}  ${field.charAt(0).toUpperCase() + field.slice(1)}:`);
        const items = Array.isArray(node[field]) ? node[field] : [node[field]];
        for (const item of items) console.log(`${prefix}    • ${item}`);
      }
    }
    if (node.deprecated && Array.isArray(node.deprecated) && node.deprecated.length) {
      console.log(`${prefix}  Deprecated:`);
      for (const d of node.deprecated) {
        const pat = typeof d === "object" ? (d.pattern || "(no pattern)") : String(d);
        const repl = typeof d === "object" ? (d.replacement || "") : "";
        console.log(`${prefix}    ⛔ ${pat}`);
        if (repl) console.log(`${prefix}      → ${repl}`);
      }
    }
  } else {
    console.log(`${prefix}  ${node}`);
  }
}

function displayTree(data: Record<string, any>, indent = 0) {
  for (const [key, value] of Object.entries(data)) {
    if (typeof value === "object" && value !== null && !Array.isArray(value)) {
      const goal = value.goal;
      const goalShort = typeof goal === "string" ? goal.trim().split("\n")[0].slice(0, 80) : "";
      const markers: string[] = [];
      if (value.boundary) markers.push("B");
      if (value.tools) markers.push("T");
      if (value.deprecated?.length) markers.push("D");
      const markerStr = markers.length ? ` [${markers.join("/")}]` : "";
      const icon = indent === 0 ? "📌" : "├─";
      console.log(`${"  ".repeat(indent)}${icon} ${key}${markerStr}: ${goalShort}`);
      for (const [subKey, subVal] of Object.entries(value)) {
        if (!GBT_KEYS.has(subKey) && typeof subVal === "object" && subVal !== null && !Array.isArray(subVal)) {
          displayTree({ [subKey]: subVal }, indent + 1);
        }
      }
    } else {
      console.log(`${"  ".repeat(indent)}├─ ${key}: ${value}`);
    }
  }
}

function displayFull(data: Record<string, any>) {
  const [rootKey, root] = unwrapRoot(data);
  function recurse(key: string, node: any, indent: number) {
    displayNode(key, node, indent);
    if (typeof node === "object" && node !== null && !Array.isArray(node)) {
      for (const [subKey, subVal] of Object.entries(node)) {
        if (!GBT_KEYS.has(subKey) && typeof subVal === "object" && subVal !== null && !Array.isArray(subVal)) {
          console.log();
          recurse(subKey, subVal, indent + 1);
        }
      }
    }
  }
  recurse(rootKey, root, 0);
}

function navigate(data: Record<string, any>, dotpath: string): [any, Array<{ key: string; node: any }>] {
  const [rootKey, root] = unwrapRoot(data);
  let parts = dotpath.split(".");
  if (parts[0] === rootKey) parts = parts.slice(1);
  let node: any = root;
  const chain = [{ key: rootKey, node: root }];
  for (const part of parts) {
    if (typeof node !== "object" || node === null || !(part in node)) {
      const keys = typeof node === "object" && node !== null ? Object.keys(node) : "(not a dict)";
      console.error(`❌ Path '${dotpath}' not found (failed at '${part}')`);
      console.error(`   Available keys: ${keys}`);
      process.exit(1);
    }
    node = node[part];
    chain.push({ key: part, node });
  }
  return [node, chain];
}

function displayChain(chain: Array<{ key: string; node: any }>) {
  if (chain.length > 1) {
    console.log("─── Parent Chain ───");
    for (let i = 0; i < chain.length - 1; i++) {
      const link = chain[i];
      const goal = typeof link.node === "object" && link.node !== null ? (link.node.goal || "(no goal)") : String(link.node);
      const arrow = i > 0 ? "→ " : "";
      console.log(`  ${arrow}${link.key}: ${typeof goal === "string" ? goal.trim() : goal}`);
    }
    console.log();
  }
  console.log("─── Target ───");
  displayNode(chain[chain.length - 1].key, chain[chain.length - 1].node);
}

// ── Main ──

const args = process.argv.slice(2);
if (!args.length || args[0] === "--help" || args[0] === "-h") { console.log(HELP); process.exit(0); }

const FLAGS = new Set(["--global", "--json", "--tree", "--deprecated", "--check-deprecated", "--goal", "--boundary", "--tools", "--spec", "--repo"]);
const isGlobal = args.includes("--global");
const asJson = args.includes("--json");
const asTree = args.includes("--tree");
const showDeprecated = args.includes("--deprecated");
const checkDeprecated = args.includes("--check-deprecated");
const showGoal = args.includes("--goal");
const showBoundary = args.includes("--boundary");
const showTools = args.includes("--tools");
const showSpec = args.includes("--spec");
const isRepo = args.includes("--repo");
const positional = args.filter(a => !FLAGS.has(a));
const singleField = showGoal || showBoundary || showTools || showSpec;

function printField(root: Record<string, any>, field: string, workspace?: string) {
  if (field === "goal") {
    const val = root.goal || "";
    console.log(typeof val === "string" ? val.trim() : String(val));
  } else if (field === "boundary" || field === "tools") {
    const val = root[field] || [];
    if (Array.isArray(val)) val.forEach((item: any) => console.log(`• ${item}`));
    else console.log(val);
  } else if (field === "spec") {
    const specRef = root.spec || "";
    if (!specRef) { console.error("❌ No 'spec' pointer in dna.yaml"); process.exit(1); }
    if (workspace) {
      const specPath = join(workspace, specRef);
      if (!existsSync(specPath)) { console.error(`❌ Spec file not found: ${specPath}`); process.exit(1); }
      console.log(readFileSync(specPath, "utf-8").trimEnd());
    }
  }
}

// ── Repo mode ──
if (isRepo) {
  if (!positional.length) { console.error("❌ --repo requires owner/repo"); process.exit(1); }
  const repo = positional[0];
  const data = loadFromGithub(repo);
  const [, root] = unwrapRoot(data);
  if (showSpec) { console.log(loadSpecFromGithub(repo, root.spec || "")); process.exit(0); }
  if (showGoal) { printField(root, "goal"); process.exit(0); }
  if (showBoundary) { printField(root, "boundary"); process.exit(0); }
  if (showTools) { printField(root, "tools"); process.exit(0); }
  if (showDeprecated) { displayDeprecated(getDeprecatedPatterns(loadGlobalGoal(), data)); process.exit(0); }
  if (asJson) { console.log(JSON.stringify(data, null, 2)); process.exit(0); }
  asTree ? displayTree(data) : displayFull(data);
  const merged = getDeprecatedPatterns(loadGlobalGoal(), data);
  if (merged.length) { console.log(); displayDeprecated(merged); }
  process.exit(0);
}

// ── Global mode ──
if (isGlobal) {
  const globalData = loadGlobalGoal();
  if (!globalData) { console.error("❌ Global GOAL.yaml not found"); process.exit(1); }
  if (asJson) {
    const target = (showDeprecated || checkDeprecated) ? getDeprecatedPatterns(globalData) : globalData;
    console.log(JSON.stringify(target, null, 2));
    process.exit(0);
  }
  if (showDeprecated || checkDeprecated) { displayDeprecated(getDeprecatedPatterns(globalData)); process.exit(0); }
  asTree ? displayTree(globalData) : displayFull(globalData);
  process.exit(0);
}

// ── Agent mode ──
if (!positional.length) { console.error("❌ No workspace specified. Use: spec <workspace> or spec --global"); process.exit(1); }

const workspaceName = positional[0];
const isAbsOrDir = isAbsolute(workspaceName) || existsSync(workspaceName);
const segments = isAbsOrDir ? [workspaceName] : workspaceName.split(".");
const workspace = resolveWorkspace(segments[0]);
const agentId = resolveAgentId(workspace);
const subpath = segments.slice(1);
const dictKey = positional[1] || null;

// ── Deprecated modes ──
if (showDeprecated || checkDeprecated) {
  const globalData = loadGlobalGoal();
  let agentData: Record<string, any> | null = null;
  try { agentData = loadGoal(workspace); } catch { /* no agent data */ }
  const patterns = getDeprecatedPatterns(globalData, agentData, agentId);
  if (asJson) { console.log(JSON.stringify(patterns, null, 2)); process.exit(0); }
  if (checkDeprecated) {
    const active = patterns.filter(p => !p.exempt);
    const exempt = patterns.filter(p => p.exempt);
    console.log(`─── Deprecated Patterns Audit: ${workspaceName} ───\n`);
    if (active.length) {
      console.log(`  ⛔ ${active.length} active deprecated pattern(s) to check:\n`);
      active.forEach((p, i) => {
        console.log(`  ${i + 1}. [${p.level.toUpperCase()}] ${p.pattern || "(no pattern)"}`);
        if (p.replacement) console.log(`     → Use instead: ${p.replacement}`);
        if (p.since) console.log(`     → Since: ${p.since}`);
        console.log();
      });
    } else {
      console.log("  ✅ No active deprecated patterns apply to this agent.\n");
    }
    if (exempt.length) {
      console.log(`  ℹ️  ${exempt.length} exemption(s):\n`);
      for (const p of exempt) console.log(`  • ${p.pattern || "(no pattern)"} — ${p.exempt_reason || "no reason given"}`);
      console.log();
    }
    process.exit(0);
  }
  displayDeprecated(patterns);
  process.exit(0);
}

// ── Standard display ──
let targetDir = workspace;
for (const seg of subpath) {
  const candidate = join(targetDir, seg);
  if (existsSync(candidate)) { targetDir = candidate; }
  else { console.error(`❌ Directory not found: ${candidate}`); process.exit(1); }
}

let data = loadGoal(targetDir);
if (dictKey && dictKey in data && typeof data[dictKey] === "object") {
  data = { [dictKey]: data[dictKey] };
} else if (dictKey) {
  console.error(`❌ Key '${dictKey}' not found in ${join(targetDir, "dna.yaml")}`);
  process.exit(1);
}

if (singleField) {
  const [, root] = unwrapRoot(data);
  if (showGoal) printField(root, "goal");
  else if (showBoundary) printField(root, "boundary");
  else if (showTools) printField(root, "tools");
  else if (showSpec) printField(root, "spec", targetDir);
  process.exit(0);
}

const remaining = dictKey ? positional.slice(2) : positional.slice(1);
const globalData = loadGlobalGoal();
const mergedDeprecated = getDeprecatedPatterns(globalData, data, agentId);

if (asJson) {
  if (remaining.length) {
    const [node] = navigate(data, remaining[0]);
    console.log(JSON.stringify(typeof node === "object" ? node : { value: node }, null, 2));
  } else {
    const out: any = { ...data };
    if (mergedDeprecated.length) out._deprecated_merged = mergedDeprecated;
    console.log(JSON.stringify(out, null, 2));
  }
  process.exit(0);
}

if (asTree) {
  displayTree(data);
  if (mergedDeprecated.length) { console.log(); displayDeprecated(mergedDeprecated); }
  process.exit(0);
}

if (remaining.length) {
  const [, chain] = navigate(data, remaining[0]);
  displayChain(chain);
} else {
  displayFull(data);
  if (mergedDeprecated.length) { console.log(); displayDeprecated(mergedDeprecated); }
}
