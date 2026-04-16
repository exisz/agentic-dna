# Workflow System — Git, CI, Deploy & Merge Paradigms

Every project declares a `workflow:` field in its agent's `dna.yaml`. The workflow determines git branching strategy, CI pipeline shape, QA gates, and agent merge authority.

## Two-Second Decision Tree

```
Solo project, no review needed?         → basic
Need a dev environment?                 → basic-dev
Need branch protection on main?         → dev-pr-agent-merge
Need automated smoke tests before merge? → dev-pr-smoketest
Human must approve every merge?          → dev-pr-human-merge
Enterprise-grade multi-gate?             → advanced (placeholder)
```

## Workflow Levels (ordered by increasing rigour)

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
workflow: basic-dev
```

## CLI

```bash
dna workflow --list                   # List all workflow levels
dna workflow basic                    # Show full workflow definition
dna workflow --inject basic           # Injectable format for AGENTS.md
dna workflow --agent <agent>          # Show which workflow an agent uses
dna workflow --search "human"         # Search workflows
```
