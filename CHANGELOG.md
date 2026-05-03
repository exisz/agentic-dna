# Changelog

All notable changes to this project will be documented in this file.

## [0.10.0] - 2026-05-03

### Changed (BREAKING-ish, but UX-positive)
- **`dna find` is now an alias for `dna search`** — unified, no more two near-duplicate commands. Old behavior (substring on id+title) available via `dna search --exact`.
- **`dna search` is now unified**: substring + semantic + PageRank in one ranker. Substring hits get a guaranteed 0.7+ base score so direct ID matches always rank top; semantic fills in the rest; PageRank breaks ties by node importance.
- **Per-type CLIs collapsed to thin wrappers** (1061 lines → 250 lines, -76%):
  - `dna philosophy/convention/protocol/flow` are now identical thin facades over the mesh + unified search.
  - Removed `--add` / `--edit` / `--rm` (Empire stopped managing these as separate types). Add new entries by dropping a `.dna` file with `type: <type>` frontmatter into the matching `~/.openclaw/.dna/<type>s/` directory.
  - Removed convention's `--scope global|local|all` flag — mesh already merges global + workspace-local automatically.
  - All `--search` subcommands (`dna philosophy --search ...`, etc.) now route to unified search filtered to that type. Bonus: they get semantic + PageRank for free.
  - All four wrappers fit in <25 lines each; new types can be added in one line via `makeTypedCli({ type })`.

### Added
- **`dna mesh centrality`** — PageRank-ranked keystone nodes. `--top N`, `--type T`, `--json`. Reveals which nodes the mesh actually depends on.
- **`graphology` + `graphology-metrics` integration** — used for PageRank today, available for future graph algorithms (centrality variants, communities, etc.). Cached at `<DNA_DATA>/.pagerank.json`, invalidated by edge-count signature.
- `dna search --exact` flag for substring-only behavior (the old `dna find`).
- `dna search` output now shows signal markers: `≡` (substring), `~` (semantic), `≡~` (both).

## [0.9.0] - 2026-05-03

### Added
- **`dna search <query>`** — semantic search over the mesh using local ONNX embeddings.
  - Pure-JS runtime via `@huggingface/transformers` (no Python, no network at query time).
  - Model: `Xenova/all-MiniLM-L6-v2` (~22MB, downloaded once to `~/.cache/huggingface/`).
  - Index stored at `<DNA_DATA>/.embeddings.json` (≈3MB for 389 nodes).
  - Incremental: `dna mesh scan` re-embeds only changed nodes; query latency <500ms warm.
  - Flags: `--top N`, `--type TYPE`, `--json`, `--reindex`, `--status`.
  - Solves the failure modes `dna find` had: synonyms, paraphrases, typos, intent queries.
  - Existing `dna find` (substring on id+title) is unchanged — use it for fast exact lookups.

## [0.2.0] - 2025-04-16

### Added
- Unified CLI binary with `dna` command
- Smoke tests for CI
- Philosophy and convention databases
- Agent identity system (`dna.yaml`)
- Toolbox management
- Workflow paradigms
- Adaptive cron
- Policy injection
- Directive expansion (`{{dna ...}}`)
- OpenClaw plugin (`openclaw-dna`)

## [0.0.1] - 2025-04-15

### Added
- Initial release
