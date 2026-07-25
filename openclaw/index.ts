/**
 * Agentic DNA Plugin
 *
 * Two responsibilities:
 *
 * 1. PROMPT INJECTION (before_prompt_build):
 *    - DNA Knowledge Guide (where to store info)
 *    - Cron Policy (no subagents in cron sessions)
 *    - Interactive Policy (prefer subagents for implementation)
 *
 * 2. BOOTSTRAP FILE EXPANSION (agent:bootstrap):
 *    - Scans bootstrap files (AGENTS.md, TOOLS.md, etc.) for {{dna ...}} directives
 *    - Uses shared expand module: ~/.openclaw/skills/openclaw-dna/lib/expand.ts
 *
 * Directive syntax: {{dna <subcommand> <args...>}}
 */
import { readFileSync, existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import type { OpenClawPluginApi } from "openclaw/plugin-sdk/core";
import { createPhilosophyTool } from "./tools/dna-philosophy.ts";
import { createConventionTool } from "./tools/dna-convention.ts";
import {
  expandDnaDirectives,
  hasDirectives,
  clearCache,
} from "../lib/expand.ts";

// ─── Prompt Injection Loader ─────────────────────────────────

const HOME = process.env.HOME!;
const DNA_DATA = process.env.DNA_DATA || join(HOME, ".openclaw/.dna");

interface Injection {
  id: string;
  trigger: "always" | "cron" | "interactive";
  content: string;
}

function loadInjections(): Injection[] {
  const dir = join(DNA_DATA, "injections");
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((f) => f.endsWith(".md") || f.endsWith(".dna"))
    .sort()
    .map((f) => {
      const raw = readFileSync(join(dir, f), "utf-8");
      if (!raw.startsWith("---")) return null;
      const end = raw.indexOf("---", 3);
      if (end === -1) return null;
      const fmText = raw.slice(3, end).trim();
      const body = raw.slice(end + 3).trim();
      const meta: Record<string, string> = {};
      for (const line of fmText.split("\n")) {
        const m = line.match(/^(\w[\w-]*)\s*:\s*(.+)$/);
        if (m) meta[m[1]] = m[2].trim();
      }
      return {
        id: meta.id || f.replace(/\.md$/, ""),
        trigger: (meta.trigger || "always") as Injection["trigger"],
        content: body,
      };
    })
    .filter(Boolean) as Injection[];
}

function getInjectionText(isCron: boolean): string {
  const injections = loadInjections();
  const parts = injections
    .filter((inj) => {
      if (inj.trigger === "always") return true;
      if (inj.trigger === "cron") return isCron;
      if (inj.trigger === "interactive") return !isCron;
      return false;
    })
    .map((inj) => inj.content);
  if (parts.length === 0) return "";
  return `<openclaw-dna>\n${parts.join("\n\n")}\n</openclaw-dna>`;
}

// ─── Plugin Registration ────────────────────────────────────

const plugin = {
  id: "openclaw-dna",
  name: "Agentic DNA plugin for OpenClaw",
  description:
    "OpenClaw DNA system — knowledge guide, cron/work policy, and {{dna(...)}} directive expansion in bootstrap files.",
  configSchema: { parse: () => ({}) },

  register(api: OpenClawPluginApi) {
    // ── 1. Prompt injection ──
    api.on(
      "before_prompt_build",
      (_event, ctx) => {
        const isCron = ctx.trigger === "cron";
        const injectable = getInjectionText(isCron);
        if (!injectable) return {};
        return { appendSystemContext: injectable };
      },
      { priority: 5 },
    );

    // ── 2. Bootstrap file expansion ──
    api.registerHook(
      "agent:bootstrap",
      async (event) => {
        const context = event.context as {
          bootstrapFiles?: Array<{
            name: string;
            path: string;
            content?: string;
            missing: boolean;
          }>;
        };

        if (!Array.isArray(context.bootstrapFiles)) return;

        // Clear cache each bootstrap pass so dna.yaml edits are picked up
        clearCache();

        // Check if any file actually contains a directive
        const anyDirectives = context.bootstrapFiles.some(
          (file) => file.content && hasDirectives(file.content),
        );
        if (!anyDirectives) return;

        // Expand directives in place
        context.bootstrapFiles = context.bootstrapFiles.map((file) => {
          if (!file.content || !hasDirectives(file.content)) return file;
          const expanded = expandDnaDirectives(file.content, api.logger);
          return { ...file, content: expanded };
        });
      },
      {
        name: "openclaw-dna-bootstrap-expand",
        description: "Expands {{dna(...)}} directives in workspace bootstrap files.",
      },
    );

    // ── 3. Tools ──
    api.registerTool(createPhilosophyTool());
    api.registerTool(createConventionTool());

    api.logger.info(
      "openclaw-dna: registered (knowledge guide + cron policy + {{dna()}} expansion + tools)",
    );
  },
};

export default plugin;
