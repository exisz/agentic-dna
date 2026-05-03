# Changelog

All notable changes to this project will be documented in this file.

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
