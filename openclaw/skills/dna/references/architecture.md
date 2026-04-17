# Architecture System — Git, CI, Deploy & Merge Paradigms

Every project declares an `architecture:` field in its agent's `dna.yaml`. The architecture determines git branching strategy, CI pipeline shape, QA gates, and agent merge authority.

## Two-Second Decision Tree

```
Solo project, no review needed?         → basic
Need a dev environment?                 → basic-dev
Need branch protection on main?         → dev-pr-agent-merge
Need automated smoke tests before merge? → dev-pr-smoketest
Human must approve every merge?          → dev-pr-human-merge
Enterprise-grade multi-gate?             → advanced (placeholder)
```

## Architecture Levels (ordered by increasing rigour)

| ID | Branches | PR | QA On | Agent Can Merge | Human Review |
|----|----------|----|-------|-----------------|--------------|
| `basic` | `main` only | none | prod | n/a | no |
| `basic-dev` | `main` + `dev` | `dev→main` | dev | yes | no |
| `dev-pr-agent-merge` | `main` + `dev` (protected) | `dev→main` | dev | yes (self-merge) | no |
| `dev-pr-smoketest` | `main` + `dev` (protected) | `dev→main` | dev | yes (after checks) | no |
| `dev-pr-human-merge` | `main` + `dev` (protected) | `dev→main` | dev | no | required |
| `advanced` | TBD | TBD | TBD | TBD | TBD |

## How to Declare

In the agent's `dna.yaml`:

```yaml
architecture: basic-dev
```

## CLI

```bash
dna architecture --list                   # List all architecture paradigms
dna architecture basic                    # Show full architecture definition
dna architecture --inject basic           # Injectable format for AGENTS.md
dna architecture --agent <agent>          # Show which architecture an agent uses
dna architecture --search "human"         # Search architectures
```
