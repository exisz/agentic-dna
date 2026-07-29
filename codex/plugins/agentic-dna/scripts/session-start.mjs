#!/usr/bin/env node
import { compileWorkspaceContext } from "./context-core.mjs";

let input = {};
try {
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(chunk);
  const raw = Buffer.concat(chunks).toString("utf8").trim();
  if (raw) input = JSON.parse(raw);
} catch (error) {
  process.stderr.write(`agentic-dna: invalid hook input: ${error.message}\n`);
  process.exit(0);
}

try {
  const { context } = compileWorkspaceContext(input.cwd ?? process.cwd());
  if (!context) process.exit(0);
  process.stdout.write(JSON.stringify({
    hookSpecificOutput: {
      hookEventName: "SessionStart",
      additionalContext: context
    }
  }));
} catch (error) {
  process.stderr.write(`agentic-dna: context load failed: ${error.message}\n`);
  process.exit(0);
}
