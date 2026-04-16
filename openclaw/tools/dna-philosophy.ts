import { Type } from "@sinclair/typebox";
import { execSync } from "node:child_process";

export function createPhilosophyTool() {
  return {
    name: "dna_philosophy",
    label: "DNA Philosophy",
    description:
      "Query the DNA philosophy database — universal principles for agent governance. Use 'list' to see all entries, or provide a slug to read a specific entry.",
    parameters: Type.Object({
      action: Type.Union(
        [
          Type.Literal("list"),
          Type.Literal("get"),
          Type.Literal("search"),
          Type.Literal("inject"),
        ],
        {
          description:
            'Action: "list" (all entries), "get" (by slug), "search" (by keyword), "inject" (injectable format)',
        },
      ),
      slug: Type.Optional(
        Type.String({ description: "Philosophy entry slug (for get/inject)" }),
      ),
      query: Type.Optional(
        Type.String({ description: "Search keyword (for search)" }),
      ),
      agent: Type.Optional(
        Type.String({
          description: "Agent ID to show its philosophy entries",
        }),
      ),
    }),
    async execute(_toolCallId: string, params: Record<string, unknown>) {
      const { action, slug, query, agent } = params as {
        action: string;
        slug?: string;
        query?: string;
        agent?: string;
      };
      try {
        let cmd = "dna philosophy";
        if (action === "list") cmd += " --list";
        else if (action === "get" && slug) cmd += ` ${slug}`;
        else if (action === "search" && query)
          cmd += ` --search "${query}"`;
        else if (action === "inject" && slug) cmd += ` --inject ${slug}`;
        if (agent) cmd += ` --agent ${agent}`;

        const output = execSync(cmd, { encoding: "utf-8", timeout: 10000 });
        return { content: [{ type: "text", text: output.trim() }] };
      } catch (e: any) {
        return {
          content: [{ type: "text", text: `Error: ${e.message}` }],
          isError: true,
        };
      }
    },
  };
}
