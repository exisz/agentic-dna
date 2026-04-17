# Protocol System — Git, CI, Deploy & Merge Paradigms

Every project declares a `protocol:` field in its agent's `dna.yaml`. The protocol determines git branching strategy, CI pipeline shape, QA gates, and agent merge authority.

## Two-Second Decision Tree

```
Solo project, no review needed?         → basic
Need a dev environment?                 → basic-dev
Need branch protection on main?         → dev-pr-agent-merge
Need automated smoke tests before merge? → dev-pr-smoketest
Human must approve every merge?          → dev-pr-human-merge
Enterprise-grade multi-gate?             → advanced (placeholder)
```

## Protocol Levels (ordered by increasing rigour)

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
protocol: basic-dev
```

## CLI

```bash
dna protocol --list                   # List all protocol paradigms
dna protocol basic                    # Show full protocol definition
dna protocol --inject basic           # Injectable format for AGENTS.md
dna protocol --agent <agent>          # Show which protocol an agent uses
dna protocol --search "human"         # Search protocols
```
