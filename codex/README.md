# Agentic DNA for Codex

The Codex adapter passively hydrates OpenClaw-style workspace context at
`SessionStart`. It reads workspace identity, behavior, user, tool, and DNA
files, expands safe CLI directives in memory, and returns one bounded
developer-context block to Codex.

The plugin does nothing on `SubagentStart`. Subagents receive only the context
their parent delegates, without another copy of workspace Markdown or DNA
injections.

## Layout

```text
codex/
├── .agents/plugins/marketplace.json
└── plugins/agentic-dna/
    ├── .codex-plugin/plugin.json
    ├── hooks/hooks.json
    ├── scripts/
    ├── skills/
    └── test/
```

## Local installation

Add this repository's Codex marketplace, then install the plugin:

```bash
codex plugin marketplace add /absolute/path/to/agentic-dna/codex
codex plugin add agentic-dna@personal
```

Start a new Codex task after installation. Open `/hooks`, review the Agentic
DNA hook, and trust it. Hook trust is tied to the hook definition; changing
workspace DNA data does not require re-trusting an unchanged hook.

Ensure hooks are enabled in `~/.codex/config.toml`:

```toml
[features]
hooks = true
```

## Workspace behavior

The default loader reads `IDENTITY.md`, `SOUL.md`, `USER.md`, `TOOLS.md`, and
`dna.yaml`/`dna.yml` when present. Codex already reads `AGENTS.md`, so it is
not duplicated. `MEMORY.md` is excluded by default because it may contain
credentials or stale historical text.

Use `workspace.context.json` for an explicit file list and registered CLI
commands. See the example bundled with the DNA skill.

## Publishing

The `codex/` directory is a self-contained repository marketplace. The
portable OSS installation path is to clone the Git repository and register
the local `codex/` directory:

```bash
git clone https://github.com/exisz/agentic-dna.git
codex plugin marketplace add "$PWD/agentic-dna/codex"
codex plugin add agentic-dna@personal
```

Before tagging a release:

1. Run `npm run test:codex`.
2. Run Codex's plugin and skill validators.
3. Test a clean install and review the hook with `/hooks`.
4. Update the plugin semver and repository changelog.
5. Tag and publish the GitHub repository release.
6. Distribute this adapter through the repository marketplace. The current
   OpenAI public submission form documents skills-only and MCP-backed
   submissions, but not a hooks-only submission path; do not assume the
   passive hook will be accepted into the universal directory until that
   process explicitly supports Codex hooks.
