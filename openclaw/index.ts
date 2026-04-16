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
import type { OpenClawPluginApi } from "openclaw/plugin-sdk/core";
import { createPhilosophyTool } from "./tools/dna-philosophy.ts";
import { createConventionTool } from "./tools/dna-convention.ts";
import {
  expandDnaDirectives,
  hasDirectives,
  clearCache,
} from "../lib/expand.ts";

// ─── Prompt Injection Content ───────────────────────────────

const DNA_KNOWLEDGE_GUIDE = `<openclaw-dna-guide>
## Where Information Lives — DNA System

DNA is the governing knowledge system. Before writing anything, know where it belongs:

| What | Where | CLI |
|------|-------|-----|
| Agent identity (goal/boundary/tools) | \`dna.yaml\` at workspace root | \`dna spec <agent>\` |
| Deprecated patterns | \`dna.yaml\` → \`deprecated:\` section | \`dna spec <agent> --deprecated\` |
| Universal principles | Philosophy DB | \`dna philosophy <slug>\` |
| Actionable rules (global or local) | Convention DB | \`dna convention <slug>\` or in \`dna.yaml\` → \`conventions:\` |
| Shared CLIs/tools | DNA Toolbox | \`dna tool ls\` / \`dna tool <name>\` |
| Agent-specific tool notes | \`TOOLS.md\` | (workspace file) |
| Recurring tasks / schedules | \`orchestration.yaml\` / \`CRON_ENTRYPOINT*.md\` | \`dna cron investigate\` |
| Lessons / personal context | \`MEMORY.md\` | (fallback — lowest priority) |

Key: if it's universal wisdom → philosophy. If it's an actionable rule → convention. If it's agent-specific → TOOLS.md or dna.yaml.
</openclaw-dna-guide>`;

const CRON_POLICY = `<openclaw-cron-policy>
## Cron Session Rules (MANDATORY — you are running as a scheduled cron job)

⛔ **NO subagents. Ever.**
- Do NOT call sessions_spawn, sessions_send, or any subagent tool.
- Subagents fail to yield back to cron sessions — this causes silent data loss and cascading failures.
- All work must be done directly in THIS session using direct tool calls.

⚠️ **Time budget awareness.**
- Cron sessions have hard timeouts. Prioritize completing the highest-value work first.
- Write checkpoint/progress notes to files as you go so the next run can resume.
- If you cannot finish everything, finish something — partial progress beats a timeout with nothing committed.

📋 **Reply discipline.**
- End your session with a brief summary of what was done (for the cron announce delivery).
- Do not output NO_REPLY in cron sessions unless there is truly nothing to report.
</openclaw-cron-policy>`;

const INTERACTIVE_POLICY = `<openclaw-work-policy>
## Work Execution Policy (non-cron sessions)

🔀 **Prefer subagents for implementation work.**
- When the task involves writing code, running tests, making changes, or any multi-step implementation: spawn a subagent.
- Do the thinking, planning, and analysis yourself. Delegate the doing.
- This keeps your context clean and lets you orchestrate rather than execute.
- Exception: trivial one-shot tasks (single file edit, quick lookup) can be done directly.
</openclaw-work-policy>`;

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
        let injectable = DNA_KNOWLEDGE_GUIDE;
        injectable += "\n\n" + (isCron ? CRON_POLICY : INTERACTIVE_POLICY);
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
