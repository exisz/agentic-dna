#!/usr/bin/env node
/**
 * DNA Model CLI — injection-time model materialization helpers.
 *
 * Intended for nested hydrate directives, e.g.
 *   {{dna --raw model subagent --tier senior}}
 */

const POLICY = {
  junior: [
    ["openai/gpt-5.4", 55],
    ["openai/gpt-5.5", 25],
    ["github-copilot/claude-sonnet-4.6", 18],
    ["github-copilot/claude-opus-4.7", 2],
  ],
  senior: [
    ["openai/gpt-5.5", 45],
    ["openai/gpt-5.4", 35],
    ["github-copilot/claude-sonnet-4.6", 15],
    ["github-copilot/claude-opus-4.7", 5],
  ],
  principal: [
    ["openai/gpt-5.5", 60],
    ["openai/gpt-5.4", 20],
    ["github-copilot/claude-opus-4.7", 15],
    ["github-copilot/claude-sonnet-4.6", 5],
  ],
} as const;

type Tier = keyof typeof POLICY;

function pick(tier: Tier): string {
  const candidates = POLICY[tier];
  const total = candidates.reduce((sum, [, weight]) => sum + weight, 0);
  let roll = Math.random() * total;
  for (const [model, weight] of candidates) {
    roll -= weight;
    if (roll <= 0) return model;
  }
  return candidates[candidates.length - 1][0];
}

function main(args: string[]): void {
  const cmd = args[0];
  if (!cmd || cmd === "--help" || cmd === "-h") {
    console.log(`DNA Model CLI

Usage:
  dna model subagent --tier senior [--format model|json]

Policy:
  80% GPT: openai/gpt-5.5 / openai/gpt-5.4
  20% Claude: github-copilot/claude-sonnet-4.6 / github-copilot/claude-opus-4.7`);
    return;
  }
  if (cmd !== "subagent") {
    console.error(`Unknown model command: ${cmd}`);
    process.exit(1);
  }

  const tierArg = args[args.indexOf("--tier") + 1] as Tier | undefined;
  const tier: Tier = tierArg && tierArg in POLICY ? tierArg : "senior";
  const formatArg = args[args.indexOf("--format") + 1];
  const format = formatArg === "json" ? "json" : "model";
  const model = pick(tier);

  if (format === "json") {
    console.log(JSON.stringify({ model, tier, policy: "gpt_80_claude_20", weights: POLICY[tier] }));
  } else {
    console.log(model);
  }
}

main(process.argv.slice(2));
