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
- **Workflow Paradigms** — Git/CI/deploy level management
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
dna workflow --list            # List workflow levels
dna skill ls                   # List manual skills
```

Any unrecognized subcommand automatically falls through to `dna tool <name>`, so registered toolbox entries work as top-level commands (e.g. `dna agentbase` → `dna tool agentbase`).

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
