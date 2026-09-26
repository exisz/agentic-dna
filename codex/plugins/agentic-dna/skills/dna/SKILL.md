---
name: dna
description: Use Agentic DNA governance in Codex. Apply when the user mentions DNA, dna.yaml, workspace context, OpenClaw compatibility, CLI directives, philosophy, conventions, protocols, or flows.
---

# Agentic DNA for Codex

The plugin passively loads compatible workspace context through a Codex
`SessionStart` hook. Do not re-read every bootstrap file unless the user asks
to audit or refresh it.

The plugin deliberately registers no `SubagentStart` hook. Subagents inherit
only the context their parent delegates; do not reload workspace Markdown or
DNA injections for them.

For the main task, a `UserPromptSubmit` hook performs one bounded DNA lookup.
It injects at most one node and only when DNA reports an exact substring match
for an entity explicitly named in the current prompt. Semantic-only matches are
ignored to avoid speculative context.

## Workspace files

Without configuration, the hook loads these files when present:

- `IDENTITY.md`
- `SOUL.md`
- `USER.md`
- `TOOLS.md`
- `dna.yaml` or `dna.yml`
- global DNA injections whose trigger is `always` or `codex`

Codex already loads `AGENTS.md`; the hook does not duplicate it. `MEMORY.md`
is deliberately excluded because it may contain secrets and historical text
should not automatically become developer context.

## Optional configuration

Create `workspace.context.json` at the workspace root to override file loading,
budgets, or registered commands. Start from
`references/workspace-context.example.json`.

## Directives

Legacy DNA directives remain supported:

```md
{{dna convention --inject remote-first-work}}
```

Generic registered CLI directives use:

```md
{{cli dna philosophy artifact-is-the-test}}
```

Only registered commands run. Commands execute without a shell; pipes,
redirections, substitutions, and command separators are rejected.

The bundled hook resolves the DNA executable from `DNA_CLI`, `PATH`, the
repository CLI beside the Codex marketplace, and standard local binary
locations, in that order.

## Validation

Run the hook manually with structured stdin:

```bash
printf '%s' '{"cwd":"/path/to/workspace","source":"startup"}' |
  node scripts/session-start.mjs
```

Verify that output is one JSON object containing
`hookSpecificOutput.additionalContext`.
