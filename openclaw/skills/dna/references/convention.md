# Convention System — Actionable Rules

Conventions are concrete, actionable rules that agents follow. Unlike philosophy (universal wisdom), conventions are specific instructions — "use X instead of Y", "always do Z before W".

## Two Levels

| Level | Scope | Where Stored | CLI |
|-------|-------|-------------|-----|
| **Global** | All agents | `conventions/*.md` in this module | `dna convention <slug>` |
| **Local** | Single agent | `dna.yaml` → `conventions:` section | `dna convention <slug> --agent <id>` |

## Global vs Local Decision

```
Does this rule apply to ALL agents?
  → YES → Global convention (this directory)
  → NO → Local convention (agent's dna.yaml → conventions:)
```

Philosophy vs Convention:
- **Philosophy**: "Why" — universal principle (e.g., "module-isolation")
- **Convention**: "How" — specific rule derived from a principle (e.g., "use Prisma ORM, not raw SQL")

A convention often derives from a philosophy. Reference the parent philosophy when applicable.

## Global Convention Format

Each global convention is a markdown file in `conventions/`:

```markdown
---
id: use-orm-not-raw-sql
title: Use ORM, Not Raw SQL
tags: [database, convention, orm]
derives-from: module-isolation
since: 2026-04-15
---

# Convention: Use ORM, Not Raw SQL

**Rule:** All database access must go through an ORM (Prisma, Drizzle). No raw SQL in application code.

**Why:** Derived from `module-isolation` philosophy — database is an implementation detail behind the ORM boundary.

**Applies to:** All agents with database access.
```

## Local Convention Format (in dna.yaml)

```yaml
conventions:
  - id: dev-branch-first
    rule: "All code changes go to dev branch first. Never push directly to main."
    derives-from: null  # agent-specific, no philosophy parent
  
  - id: ticket-before-work
    rule: "Create a Jira ticket before starting any work. No ad-hoc fixes."
    derives-from: single-source-of-truth
```

## CLI

```bash
# List all global conventions
dna convention --list

# Read a specific global convention
dna convention use-orm-not-raw-sql

# Injectable format (for bootstrap expansion)
dna convention --inject use-orm-not-raw-sql

# List agent's local conventions (from dna.yaml)
dna convention --agent <agent>

# Search conventions
dna convention --search "database"
```

## Entries

| ID | Title | Derives From | Tags |
|----|-------|-------------|------|
| use-orm-not-raw-sql | Use ORM, Not Raw SQL | module-isolation | database, orm, convention |
| check-toolbox-first | Check DNA Toolbox Before Building New | empire-dry | tooling, reuse, convention |
| no-standalone-scripts | No Standalone Scripts — Subcommands Only | single-source-of-truth | cli, scripts, convention |
| commit-references-ticket | Commits Must Reference Ticket ID | single-source-of-truth | git, tickets, convention |
| git-push-not-manual-deploy | Git Push, Not Manual Deploy | artifact-is-the-test | deployment, ci-cd, convention |
| ticket-before-work | Ticket Before Work — No Ad-Hoc Fixes | single-source-of-truth | tickets, process, discipline |
| ticket-must-have-dod | Tickets Must Have Definition of Done | user-story-first | tickets, quality |
| tiered-subagent-selection | Tiered Subagent Selection — Match Tier to Task Complexity | quality-over-quantity | subagents, cost, orchestration |
| status-flow-discipline | Status Flow Discipline — Roles Own Their Transitions | relay-baton | workflow, status, tickets |
| deploy-verify-before-qa | Deploy Verify Before QA — Confirm It's Live | artifact-is-the-test | deployment, qa, verification |
| qa-evidence-mandatory | QA Evidence Mandatory — Screenshots or It Didn't Happen | artifact-is-the-test | qa, evidence, screenshots |
| qa-leaves-reusable-scripts | QA Leaves Reusable Scripts — Build Tests as You Go | process-over-fix | qa, playwright, testing |
