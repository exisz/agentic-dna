---
name: dna
description: "DNA — an agent governing knowledge system. Core modules: spec (GBTD), philosophy (structured wisdom), convention (actionable rules), workflow (git/CI/deploy paradigms), inbox (agent message routing). Unified CLI: `dna`. Triggers on: spec, dna.yaml, GBTD, philosophy, convention, workflow, git workflow, branching strategy, dna."
---

# DNA — Agent Governance System

A governing knowledge system for autonomous agents. Five modules, one CLI.

## Modules

| Module | Reference | What It Covers | When to Load |
|--------|-----------|---------------|-------------|
| `spec` | `references/spec.md` | GBTD (Goal/Boundary/Tools/Deprecated), dna.yaml format | Writing or auditing dna.yaml |
| `philosophy` | `references/philosophy.md` | Structured wisdom database with slug-based entries | When you need a guiding principle |
| `convention` | `references/convention.md` | Actionable rules — global and local (agent dna.yaml) | When you need a specific "use X not Y" rule |
| `workflow` | `references/workflow.md` | Git/CI/deploy paradigms — branching, PR, QA gates, merge authority | Setting up project git/deploy workflow |
| `inbox` | (data directory) | Agent inbox system — per-source response guides | When checking or responding to inbox items |

## dna.yaml — Agent DNA

Every agent declares its DNA in `dna.yaml` at workspace root:

```yaml
goal: >
  What this agent does and why.

boundary:
  - What it doesn't do.

tools:
  - Tools it uses.

philosophy:
  - artifact-is-the-test
  - quality-over-quantity

conventions:
  - id: my-local-rule
    rule: "Specific actionable rule for this agent."
    derives-from: module-isolation  # optional link to parent philosophy

deprecated:
  - pattern: "old thing"
    replacement: "new thing"
```

`dna spec` reads dna.yaml (falls back to GOAL.yaml for backward compat).

## CLI: `dna`

```bash
# ── Spec (reads dna.yaml, merges GOAL.yaml) ───
dna spec <agent>                        # Full GBTD output
dna spec <agent> pods.engineer          # Specific node + parent chain
dna spec <agent> --tree                 # Compact tree overview
dna spec <agent> --goal                 # Goal text only
dna spec <agent> --boundary             # Boundary list only
dna spec <agent> --tools                # Tools list only
dna spec <agent> --deprecated           # Deprecated patterns only
dna spec --global                       # System-wide spec

# ── Repo mode (GitHub) ───────────────
dna spec --repo <owner/repo>            # Read dna.yaml from GitHub repo
dna spec --repo <owner/repo> --spec     # Read spec doc from repo

# ── Toolbox (registered CLIs) ─────────
dna tool ls                             # List registered tools
dna tool <name>                         # Show tool's GBTD
dna tool <name> --spec                  # Read tool's spec.md

# ── Cron ──────────────────────────────────
dna cron investigate --agent <id> --last 10
dna cron investigate --agent <id> --session <SID>

# ── Philosophy (slug IDs) ─────────────────
dna philosophy --list                           # List all entries
dna philosophy <slug>                           # Full text
dna philosophy --inject <slug>                  # Injectable format
dna philosophy --search "keyword"               # Search
dna philosophy --agent <agent>                  # Agent's philosophy

# ── Convention (actionable rules) ─────────────
dna convention --list                           # List global conventions
dna convention <slug>                           # Full text
dna convention --inject <slug>                  # Injectable format
dna convention --agent <agent>                  # Agent's local conventions
dna convention --agent <agent> --all            # Global + local
dna convention --search "keyword"               # Search

# ── Workflow (git/CI/deploy paradigms) ───────
dna workflow --list                              # List all workflow levels
dna workflow <level>                             # Full workflow definition
dna workflow --inject <level>                    # Injectable format
dna workflow --agent <agent>                     # Agent's assigned workflow
dna workflow --search "keyword"                  # Search workflows

# ── Inbox (agent message routing) ─────────────
dna inbox ls --agent <agent>                    # Actionable inbox items
dna inbox ls --agent <agent> --from <source>    # Filter by source
dna inbox ls --agent <agent> --all              # Include completed items
dna inbox guide <source>                        # Show response guide for a source

# ── Skill (manual skills, multi-root) ─────
dna skill ls                                    # List all manual skills
dna skill read <name>                           # Output skill content
dna skill read <name> --refs                    # Include references list
dna skill read-ref <name> <file>                # Read a specific reference
dna skill search "keyword"                      # Search by name/description
dna skill roots                                 # Show registered skill roots
dna skill add-root <path>                       # Register a new skill root
dna skill remove-root <path>                    # Unregister a skill root
```

### Legacy CLIs (deprecated)

Old `spec` and `cron-investigate` commands print a deprecation notice and exit.
