# Philosophy Database — Index

Structured wisdom entries for your agent system. Each entry has a slug-based ID and can be referenced, injected, or searched.

## Entries

<!-- Add your philosophy entries here. Example row:
| my-philosophy-slug | My Philosophy Title | tag1, tag2, tag3 |
-->

| ID | Title | Tags |
|----|-------|------|

## Entry Format

Each philosophy entry is a markdown file named `<slug-id>.md` with frontmatter:

```markdown
---
id: artifact-is-the-test
title: The Artifact Is The Test
tags: [verification, testing, debugging]
since: 2026-01-15
---

# The Artifact Is The Test

Your philosophy text here. Explain the principle, why it matters,
and how agents should apply it.
```

## How to Use

```bash
dna philosophy --list                              # List all entries
dna philosophy <slug>                              # Full text
dna philosophy --inject <slug>                     # Injectable format
dna philosophy --search "keyword"                  # Search by keyword
dna philosophy --agent <agent>                     # Show agent's philosophy
```

## Case Studies

Case studies are stored in `case-studies/<philosophy-id>/` as markdown files.
They document real decisions where a philosophy entry was born or applied.

```bash
dna philosophy --case-study <slug>                 # View case study
```

## Adding New Entries

1. Create `<slug-id>.md` in the philosophy data directory (kebab-case)
2. Use standard frontmatter: `id`, `title`, `tags`, `since`
3. Update this index table
4. Entries must be:
   - Universal (applies to all agents, not just one)
   - Actionable (changes behavior, not just a platitude)
   - Learned from experience (born from a real failure or insight)

## Agent-Level DNA (dna.yaml)

Agents declare their philosophy references in `dna.yaml` at workspace root:

```yaml
goal: >
  What this agent does and why.

philosophy:
  - artifact-is-the-test
  - quality-over-quantity
```

`dna philosophy --agent <agent>` resolves the agent's philosophy entries.
