# 🧬 Agentic DNA

[![CI](https://github.com/exisz/agentic-dna/actions/workflows/ci.yml/badge.svg)](https://github.com/exisz/agentic-dna/actions/workflows/ci.yml)
[![License: Apache-2.0](https://img.shields.io/badge/License-Apache%202.0-blue.svg)](https://opensource.org/licenses/Apache-2.0)
[![npm: agentic-dna](https://img.shields.io/npm/v/agentic-dna.svg)](https://www.npmjs.com/package/agentic-dna)
[![npm: openclaw-dna](https://img.shields.io/npm/v/openclaw-dna.svg)](https://www.npmjs.com/package/openclaw-dna)
[![npm downloads](https://img.shields.io/npm/dm/agentic-dna.svg)](https://www.npmjs.com/package/agentic-dna)

**Governance and knowledge system for AI agent fleets.**

Agentic DNA provides a structured governance layer for multi-agent systems — defining agent identity, enforcing policies, managing shared knowledge, and ensuring consistency across an entire fleet of AI agents.

## Features

- **Agent Identity (dna.yaml)** — Goal, boundary, tools, and deprecation specs per agent
- **Philosophy DB** — Universal principles shared across all agents
- **Convention DB** — Actionable rules (global or workspace-scoped)
- **Toolbox** — Shared CLI/tool documentation
- **Architecture Paradigms** — Git/CI/deploy level management
- **Adaptive Cron** — Dynamic frequency adjustment
- **Policy Injection** — Automatic cron and interactive session policies
- **Directive Expansion** — `{{dna ...}}` directives in bootstrap files

## Requirements

- **Node.js** >= 18

## Install

### CLI Only (standalone)

```bash
npm install -g agentic-dna
dna init                    # Initialize data directory
dna help
```

### OpenClaw Plugin

```bash
openclaw plugins install openclaw-dna
openclaw gateway restart
```

### From Source

```bash
git clone https://github.com/exisz/agentic-dna.git
cd agentic-dna
pnpm install
npm link                    # Makes 'dna' command available globally
dna init
```

## CLI

```bash
dna init                       # Initialize data directory
dna spec <agent>               # View agent spec (goal/boundary/tools)
dna philosophy <slug>          # View a philosophy entry
dna philosophy --list          # List all philosophies
dna convention <slug>          # View a convention
dna convention --list          # List all conventions
dna tool ls                    # List tools in the toolbox
dna tool <name>                # View tool GBTD
dna hydrate --all              # Expand all {{dna}} directives
dna cron up <id>               # Increase cron frequency
dna cron down <id>             # Decrease cron frequency
dna protocol --list            # List protocol paradigms
dna skill ls                   # List manual skills
dna search <query>             # Semantic search over the mesh (local ONNX embeddings)
dna distill scan               # Find semantic duplicate/overlap candidates across DNA + Markdown
```

Any unrecognized subcommand automatically falls through to `dna tool <name>`, so registered toolbox entries work as top-level commands (e.g. `dna agentbase` → `dna tool agentbase`).

## Search

One unified command. Old `dna find` is now an alias for `dna search` (use `--exact` for substring-only behavior).

```bash
dna search nebula                              # substring match: dna://board/nebula, dna://agent/nebula, ...
dna search "test before code"                  # semantic: → dna://philosophy/test-driven
dna search "documentation matters" --type philosophy
dna search "ticket-before-work" --exact        # exact id
dna search "graph traversal" --top 10 --json   # machine-readable
dna search --status                            # index info (size, entries, by type)
dna search --reindex                           # force full re-embed
```

Results combine three signals:
- **Substring** match on id+title (≡, base score 0.7)
- **Semantic** cosine similarity via local ONNX embeddings (~)
- **PageRank** boost for keystone nodes (computed via `graphology`)

The model (`Xenova/all-MiniLM-L6-v2`, ~22MB) downloads once on first use to `~/.cache/huggingface/`. Embeddings are stored at `<DNA_DATA>/.embeddings.json` (≈3MB for 389 nodes); PageRank at `<DNA_DATA>/.pagerank.json`. Both incremental: `dna mesh scan` only re-embeds changed nodes; PageRank recomputes only when edge count changes.

Also: **`dna mesh centrality`** — list keystone nodes by PageRank.

## Distill

`dna distill` is the knowledge garbage collector: it uses the same local embedding stack to find where knowledge should be compressed into DNA instead of repeated across files.

```bash
dna distill scan --scope cwd                  # read-only duplicate audit for current workspace
dna distill scan --scope global --top 50      # scan OpenClaw workspaces + DNA roots
dna distill guard "ticket before work"        # check if a concept already exists before writing
```

Finding classes:
- **dna-markdown** — Markdown repeats canonical DNA; replace prose with a `{{dna ... --inject ...}}` pointer or `dna://` reference.
- **dna-dna** — DNA entries overlap; merge/retire one canonical slug.
- **markdown-markdown** — repeated Markdown; extract/distill shared idea into DNA, then point both sections at it.

Default mode is read-only. It writes only an embedding cache at `<DNA_DATA>/.distill-embeddings.json`.

## Development

```bash
# One-shot: build → install → restart gateway
make dev

# Just build (no install)
make build

# Build + install (no restart)
make install

# Clean build artifacts
make clean
```

## Repository Structure

This is a **monorepo** that publishes two npm packages from a single repository:

| Package | Description |
|---------|-------------|
| [`agentic-dna`](https://www.npmjs.com/package/agentic-dna) | The standalone `dna` CLI tool |
| [`openclaw-dna`](https://www.npmjs.com/package/openclaw-dna) | The OpenClaw plugin (source: `openclaw/index.ts`) |

```
agentic-dna/
├── bin/
│   └── dna                   # CLI entry — routes all `dna` subcommands
├── lib/                      # Shared CLI implementation modules
│   └── expand.ts             # {{dna}} directive expansion
├── openclaw/                 # OpenClaw plugin — published as `openclaw-dna` npm package
│   ├── index.ts              # Plugin entry: policy injection + directive expansion
│   ├── dist/                 # Build output (run `cd openclaw && pnpm build`)
│   ├── skills/               # Bundled AgentSkills
│   ├── package.json          # openclaw-dna package manifest
│   └── openclaw.plugin.json  # OpenClaw plugin descriptor
├── scripts/                  # Utility/build scripts
└── test/                     # Tests
```

> **Note for OpenClaw users:** The `openclaw-dna` plugin source lives here at `openclaw/index.ts`. There is no separate `openclaw-dna` repository — both packages are developed and released from this repo.

## Project Structure

```
agentic-dna/
├── bin/              # CLI entrypoint
│   └── dna           # Router script
├── scripts/          # CLI tools (TypeScript)
├── lib/              # Shared modules
│   └── expand.ts     # {{dna}} directive expansion
└── openclaw/         # OpenClaw plugin (npm: openclaw-dna)
    ├── package.json
    ├── openclaw.plugin.json
    ├── index.ts      # Plugin entry — policy injection + directive expansion
    └── skills/       # Bundled AgentSkills
```

## License

[Apache-2.0](LICENSE)
