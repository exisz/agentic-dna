/**
 * DNA Directive Expansion — shared module.
 *
 * Used by:
 * - openclaw-dna extension (runtime bootstrap expansion)
 * - `dna hydrate` CLI (pre-render preview)
 *
 * Expands {{dna <subcommand> <args>}} directives by calling the dna CLI.
 * Protects directives inside code blocks (```) and inline code (`).
 */
import { execSync } from "node:child_process";
import { existsSync } from "node:fs";

// ─── Config ─────────────────────────────────────────────────

/** Regex to match {{dna <subcommand> <args>}} directives */
const DNA_DIRECTIVE_RE = /\{\{dna\s+([^}]+)\}\}/g;

/** Maximum characters for a single dna CLI expansion output */
const DNA_INJECT_CHAR_LIMIT = 2000;

/** Full path to the dna CLI. Resolved at first use via PATH;
 * fallback candidates cover common install locations (launchd/cron
 * may not have npm globals in PATH). */
let resolvedDnaCliPath: string | null = null;
function getDnaCliPath(): string {
  if (resolvedDnaCliPath) return resolvedDnaCliPath;
  // 1. PATH lookup (with home/npm-global paths prepended for cron/launchd)
  try {
    const found = execSync("command -v dna", {
      encoding: "utf-8",
      shell: "/bin/sh",
      env: {
        ...process.env,
        PATH: `/opt/homebrew/bin:${process.env.HOME}/.local/bin:${process.env.HOME}/.nvm/versions/node/v24.14.0/bin:${process.env.PATH ?? "/usr/bin:/bin"}`,
      },
    }).trim();
    if (found) { resolvedDnaCliPath = found; return found; }
  } catch {}
  // 2. Fallback candidates
  const home = process.env.HOME || "";
  const candidates = [
    `${home}/.local/bin/dna`,
    `/opt/homebrew/bin/dna`,
    `/usr/local/bin/dna`,
  ];
  for (const c of candidates) {
    if (existsSync(c)) { resolvedDnaCliPath = c; return c; }
  }
  resolvedDnaCliPath = "dna"; // last resort — rely on PATH at exec time
  return resolvedDnaCliPath;
}

/** Maximum time (ms) for a single dna CLI invocation */
const DNA_CLI_TIMEOUT_MS = 10_000;

// ─── Types ──────────────────────────────────────────────────

export interface Logger {
  warn: (msg: string) => void;
  info?: (msg: string) => void;
}

// ─── Cache ──────────────────────────────────────────────────

let dnaCache = new Map<string, string>();

/** Clear the expansion cache (call before each bootstrap pass) */
export function clearCache(): void {
  dnaCache = new Map();
}

// ─── Core ───────────────────────────────────────────────────

/**
 * Run `dna <args>` and return stdout, or an error marker on failure.
 * Results are cached by the full argument string.
 */
function runDnaCli(args: string, logger: Logger): string {
  const cached = dnaCache.get(args);
  if (cached !== undefined) return cached;

  try {
    const output = execSync(`${getDnaCliPath()} ${args}`, {
      encoding: "utf-8",
      timeout: DNA_CLI_TIMEOUT_MS,
      env: {
        ...process.env,
        NO_COLOR: "1",
        PATH: `/opt/homebrew/bin:${process.env.HOME}/.local/bin:${process.env.PATH ?? "/usr/bin:/bin"}`,
      },
      stdio: ["ignore", "pipe", "pipe"],
    }).trim();
    dnaCache.set(args, output);
    return output;
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    logger.warn(`dna CLI failed for [dna(${args})]: ${message}`);
    const fallback = `<!-- dna expansion failed for "${args.replace(/"/g, "'")}": ${message.slice(0, 200).replace(/-->/g, "--〉")} -->`;
    dnaCache.set(args, fallback);
    return fallback;
  }
}

/**
 * Expand a single directive match into rendered output.
 */
function expandDirective(args: string, logger: Logger): string {
  const trimmedArgs = args.trim();
  if (!trimmedArgs) return "<!-- [dna()] empty directive -->";

  const output = runDnaCli(trimmedArgs, logger);

  // Truncate oversized output
  let finalOutput = output;
  if (output.length > DNA_INJECT_CHAR_LIMIT) {
    let truncated = output.slice(0, DNA_INJECT_CHAR_LIMIT);
    const lastNl = truncated.lastIndexOf("\n");
    if (lastNl > DNA_INJECT_CHAR_LIMIT / 2) {
      truncated = truncated.slice(0, lastNl);
    }
    finalOutput = `${truncated}\n\n⚠️ TRUNCATED — {{dna ${trimmedArgs}}} output exceeds ${DNA_INJECT_CHAR_LIMIT} char limit. Run \`dna ${trimmedArgs}\` for full text.`;
    logger.warn?.(
      `dna expansion truncated for [${trimmedArgs}]: ${output.length} chars > ${DNA_INJECT_CHAR_LIMIT} limit`,
    );
  }

  const safeLabel = trimmedArgs.replace(/\s+/g, " ");
  return `«dna:${safeLabel}»\n\n${finalOutput}`;
}

/**
 * Expand all {{dna ...}} directives in a string.
 *
 * Directives inside fenced code blocks (```) and inline code (`) are preserved as-is.
 */
export function expandDnaDirectives(content: string, logger: Logger): string {
  if (!content.includes("{{dna ")) return content;

  // Protect fenced code blocks
  const codeBlocks: string[] = [];
  let protected_ = content.replace(/```[\s\S]*?```/g, (match) => {
    codeBlocks.push(match);
    return `\x00CODEBLOCK${codeBlocks.length - 1}\x00`;
  });

  // Protect inline code
  const inlineCodes: string[] = [];
  protected_ = protected_.replace(/`[^`]+`/g, (match) => {
    inlineCodes.push(match);
    return `\x00INLINE${inlineCodes.length - 1}\x00`;
  });

  // Expand directives in unprotected regions
  const expanded = protected_.replace(DNA_DIRECTIVE_RE, (_match, args: string) =>
    expandDirective(args, logger),
  );

  // Restore protected regions
  let result = expanded;
  for (let i = 0; i < codeBlocks.length; i++) {
    result = result.replace(`\x00CODEBLOCK${i}\x00`, codeBlocks[i]);
  }
  for (let i = 0; i < inlineCodes.length; i++) {
    result = result.replace(`\x00INLINE${i}\x00`, inlineCodes[i]);
  }

  return result;
}

/**
 * Check if content contains any expandable {{dna ...}} directives
 * (excludes directives inside code blocks and inline code).
 */
export function hasDirectives(content: string): boolean {
  // Fast path: no directive syntax at all
  if (!content.includes("{{dna ")) return false;
  // Slow path: check if any are outside code regions
  return countDirectives(content) > 0;
}

/**
 * Count directives in content (excluding code blocks/inline code).
 */
export function countDirectives(content: string): number {
  // Protect code regions first
  let protected_ = content.replace(/```[\s\S]*?```/g, "");
  protected_ = protected_.replace(/`[^`]+`/g, "");
  const matches = protected_.match(DNA_DIRECTIVE_RE);
  return matches ? matches.length : 0;
}
