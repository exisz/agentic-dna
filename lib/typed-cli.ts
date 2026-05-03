/**
 * Generic typed-CLI factory — backs the thin per-type wrappers
 * (philosophy / convention / protocol / flow).
 *
 * Each type is just `dna://<type>/<slug>` in the mesh now. There is no
 * per-type storage, no per-type schema, no scaffolding logic. Everything
 * is a thin facade over:
 *   - mesh-cli buildGraph + getNodesByType  (list / show / agent)
 *   - search-cli runTypedSearch              (search, filtered to type)
 *   - generic --inject formatter             (callout block from summary)
 *
 * Adding a new type? `makeTypedCli({ type: "X" })` and you're done.
 */
import { existsSync } from "node:fs";
import { join } from "node:path";
import { INJECT_CHAR_LIMIT, resolveAgentWorkspace, loadYaml } from "./common.ts";
import { buildGraph, getNodesByType, nodeToEntry } from "../scripts/mesh-cli.ts";
import { runTypedSearch } from "../scripts/search-cli.ts";

export interface TypedCliOptions {
  /** Mesh node type, e.g. "philosophy", "convention", "protocol", "flow". */
  type: string;
  /** Display label, e.g. "Philosophy". Defaults to capitalized type. */
  label?: string;
  /** Emoji for headers. */
  emoji?: string;
  /** dna.yaml field key for `--agent <id>` lookup. Defaults to type. */
  agentField?: string;
  /**
   * Inject block style. "philosophy"=DNA: marker, "convention"=CONVENTION: marker,
   * etc. Defaults to UPPERCASE(type).
   */
  injectMarker?: string;
}

function typedSearchableEntries(type: string) {
  const g = buildGraph();
  const nodes = getNodesByType(g, type);
  nodes.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  return nodes.map(nodeToEntry);
}

function findEntry(type: string, slug: string) {
  const entries = typedSearchableEntries(type);
  return entries.find((e) => (e.id as string).toLowerCase() === slug.toLowerCase());
}

function cmdList(opts: TypedCliOptions) {
  const entries = typedSearchableEntries(opts.type);
  const label = opts.label || opts.type.charAt(0).toUpperCase() + opts.type.slice(1);
  const emoji = opts.emoji || "🧬";
  if (!entries.length) {
    console.log(`No ${opts.type} entries found.`);
    return;
  }
  console.log(`${emoji} ${label} Database — ${entries.length} entries\n`);
  const col = Math.max(...entries.map((e) => (e.id as string).length)) + 2;
  console.log(`${"ID".padEnd(col)} ${"Title".padEnd(40)} Tags`);
  console.log("-".repeat(col + 50));
  for (const e of entries) {
    const tags = Array.isArray(e.tags) ? e.tags.join(", ") : (e.tags || "");
    console.log(
      `${(e.id as string).padEnd(col)} ${((e.title as string) || "?").padEnd(40)} ${tags}`,
    );
  }
}

function cmdShow(opts: TypedCliOptions, slug: string) {
  const e = findEntry(opts.type, slug);
  if (!e) {
    console.error(`❌ ${opts.type} entry not found: ${slug}`);
    console.error(`💡 Try: dna search "${slug}" --type ${opts.type}`);
    process.exit(1);
  }
  console.log(e._body);
}

function cmdInject(opts: TypedCliOptions, slug: string) {
  const e = findEntry(opts.type, slug);
  if (!e) {
    console.error(`❌ ${opts.type} entry not found: ${slug}`);
    process.exit(1);
  }
  const marker = opts.injectMarker || opts.type.toUpperCase();
  const emoji = opts.emoji || "🧬";

  const summary = (e.summary as string) || (() => {
    console.error(`⚠️ No summary field for ${e.id} — using body fallback`);
    return (e._body as string).slice(0, 500).trimEnd();
  })();

  let output = `<!-- ${marker}:${e.id} -->\n**${emoji} ${e.id}** *(summary)*: ${summary}\n\n> 📖 *Full text*: \`dna ${opts.type} ${e.id}\`\n<!-- /${marker}:${e.id} -->`;
  if (output.length > INJECT_CHAR_LIMIT) {
    let truncated = output.slice(0, INJECT_CHAR_LIMIT);
    const lastNl = truncated.lastIndexOf("\n");
    if (lastNl > INJECT_CHAR_LIMIT / 2) truncated = truncated.slice(0, lastNl);
    output = truncated + `\n\n⚠️ TRUNCATED — run \`dna ${opts.type} ${e.id}\` for full text.\n<!-- /${marker}:${e.id} -->`;
  }
  console.log(output);
}

function cmdAgent(opts: TypedCliOptions, agentId: string) {
  const workspace = resolveAgentWorkspace(agentId);
  if (!workspace) {
    console.error(`❌ Agent not found: ${agentId}`);
    process.exit(1);
  }
  const dnaPath = existsSync(join(workspace, "dna.yml"))
    ? join(workspace, "dna.yml")
    : join(workspace, "dna.yaml");
  if (!existsSync(dnaPath)) {
    console.error(`❌ No dna.yaml found in ${workspace}`);
    process.exit(1);
  }

  const data = loadYaml(dnaPath);
  const root = data && typeof data === "object" ? data : {};
  const firstKey = Object.keys(root)[0];
  const inner =
    firstKey && typeof root[firstKey] === "object" && !Array.isArray(root[firstKey])
      ? root[firstKey]
      : root;
  const field = opts.agentField || opts.type;
  const ids: string[] = inner?.[field] || [];
  const label = opts.label || opts.type.charAt(0).toUpperCase() + opts.type.slice(1);
  const emoji = opts.emoji || "🧬";

  if (!ids.length) {
    console.log(`No ${opts.type} entries in ${dnaPath}`);
    return;
  }

  const entries = typedSearchableEntries(opts.type);
  const entryMap = new Map(entries.map((e) => [(e.id as string).toLowerCase(), e]));
  console.log(`${emoji} ${agentId} ${label} — ${ids.length} entries\n`);
  for (const id of ids) {
    const e = entryMap.get(id.toLowerCase());
    console.log(e ? `  ${id}: ${e.title}` : `  ${id}: ❌ NOT FOUND`);
  }
}

export function makeTypedCli(opts: TypedCliOptions) {
  const label = opts.label || opts.type.charAt(0).toUpperCase() + opts.type.slice(1);
  const emoji = opts.emoji || "🧬";
  const HELP = `${emoji} DNA ${label} CLI — thin wrapper over the mesh

Usage:
  dna ${opts.type} --list                        List all ${opts.type} entries
  dna ${opts.type} <slug>                        Show full entry
  dna ${opts.type} --inject <slug>               Injectable callout block
  dna ${opts.type} --search <query>              Unified search (semantic + substring + PageRank)
  dna ${opts.type} --agent <id>                  Show an agent's ${opts.type} list

All ${opts.type} entries live in the mesh as dna://${opts.type}/<slug>.
Use 'dna show dna://${opts.type}/<slug>' for cross-type details + edges.
Add new entries by dropping a .dna file with 'type: ${opts.type}' frontmatter
into ~/.openclaw/.dna/${opts.type === "philosophy" ? "philosophies" : opts.type === "convention" ? "conventions" : opts.type === "protocol" ? "protocols" : opts.type + "s"}/`;

  return async function main(args: string[]) {
    if (!args.length || args[0] === "--help" || args[0] === "-h") {
      console.log(HELP);
      return;
    }
    const a0 = args[0];
    if (a0 === "--list" || a0 === "list") return cmdList(opts);
    if ((a0 === "--search" || a0 === "search") && args[1]) {
      // Forward the rest of the args (after the query) to the unified search
      // so flags like --top, --json, --exact still work.
      const queryAndFlags = args.slice(1);
      return runTypedSearch(opts.type, queryAndFlags);
    }
    if (a0 === "--inject" && args[1]) return cmdInject(opts, args[1]);
    if (a0 === "--agent" && args[1]) return cmdAgent(opts, args[1]);
    // Show by slug (default)
    return cmdShow(opts, a0);
  };
}
