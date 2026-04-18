---
id: oss-iterate
title: "OSS Project Iteration — Day-to-Day Changes"
summary: Standard procedure for modifying an already-launched OSS project. Covers bugfixes, features, docs, and refactors through to automated publish via CI.
tags: [flow, oss, iterate, npm, github, ci, release]
derives-from: oss-launch-zero-to-one
---

# OSS Project Iteration — Day-to-Day Changes

The standard procedure for modifying an already-launched OSS project (one that completed `oss-launch-zero-to-one`). Covers: bugfixes, features, docs, refactors → automated publish.

## When to Use

- Existing public OSS project (npm/PyPI/cargo) needs changes
- **NOT for:** initial launch (use `oss-launch-zero-to-one`), private packages, internal tools

---

## Pre-flight (one-time per session)

1. Verify the repo satisfies the auto-release contract per `dna convention oss-release-playbook`:
   - `.github/workflows/ci.yml` — lint + test + build
   - `.github/workflows/auto-release.yml` **or** `release.yml` — push-to-main → bump → publish → tag → GH Release
   - `NPM_TOKEN` (or equivalent) repo secret is set
2. If any of the above are missing → backfill via `oss-launch-zero-to-one` Step 5 before continuing.

---

## Phase 1 — Change

### Step 1: Branch (optional but recommended for non-trivial changes)

- **Trivial** (typo, one-liner, doc fix) → commit straight to `main` is acceptable
- **Non-trivial** (touches code or build) → branch `<type>/<short-desc>`
  - e.g. `fix/cli-crash`, `feat/realm-hint`, `refactor/parse-legacy-yaml`

### Step 2: Conventional Commit Discipline

The release workflow reads commit prefix to decide bump type:

| Prefix | Bump | Example |
|--------|------|---------|
| `feat!:` or `BREAKING CHANGE:` in body | **major** | `feat!: drop Node 18 support` |
| `feat:` | **minor** | `feat: add --json output` |
| `fix:` / `docs:` / `chore:` / `refactor:` / `test:` / `perf:` | **patch** | `fix: handle empty config` |

> ⚠️ Wrong prefix = wrong version bump. Double-check before push.  
> When multiple commits land before a release, CI picks the **highest bump** seen since the last tag.

### Step 3: Build + Test Locally

```bash
pnpm build          # or: cargo build / python -m build / etc.
npm test            # or: cargo test / pytest / etc.
dna <cmd>           # manually exercise the changed behaviour
git status          # verify no untracked artifacts that should be .gitignored
```

---

## Phase 2 — Ship

### Step 4: Push to main

**Default path (Emperor's preference):** direct merge to `main`, no PR.

```bash
# If working on a branch:
git checkout main
git merge --ff-only <branch>
git push origin main
git push origin --delete <branch>   # clean up remote branch

# If already on main:
git push origin main
```

**PR path** — use only when:
- The repo has a contribution policy requiring review, OR
- The change is risky and you want CI gate signal before merging

```bash
gh pr create --fill
# wait for green CI
gh pr merge --squash --delete-branch
```

### Step 5: Watch CI

```bash
gh run list --limit 3
gh run watch <run-id>    # blocks until complete; optional
```

The Release workflow should:
1. Detect bump type from commits since last tag
2. Bump version in the package manifest(s)
3. Build + publish to registry (npm / PyPI / crates.io)
4. Commit `chore: release vX.Y.Z [skip ci]`
5. Tag `vX.Y.Z` and push
6. Create GitHub Release with auto-generated notes

### Step 6: Verify Published Version

```bash
npm view <pkg> version          # or: cargo search <pkg> / pip index versions <pkg>
git pull --ff-only              # pull the [skip ci] release commit + tag
git log --oneline -3            # release commit should be at HEAD
```

If the version didn't bump → inspect with:

```bash
gh run view <id> --log-failed
```

---

## Phase 3 — Post-Ship (when applicable)

### Step 7: Update Local Copies

If the package is installed globally and you depend on the new behaviour:

```bash
npm i -g <pkg>@latest
```

For OpenClaw plugins:

```bash
openclaw plugins update <pkg>
# or: openclaw gateway restart
```

### Step 8: Cross-Referenced Updates

If the change affects how other agents use the tool, also update:

- **AgentSkill `SKILL.md`** — if CLI behaviour or flags changed
- **Related conventions/philosophies** — if semantics shifted
- **nebula `projects.yaml` notes** — if project metadata changed
- **Cron entrypoints** — if CLI args or invocation changed

### Step 9: Ticket Hygiene (when work was ticket-tracked)

```bash
lazyjira issues comment <KEY> -b "Released vX.Y.Z — <one-liner of what changed>"
lazyjira issues transition <KEY> Done    # if DoD is fully met
```

---

## Anti-Patterns

| ❌ Don't | Why |
|----------|-----|
| `git push --no-verify` to skip hooks | Bypasses quality gates |
| `[skip ci]` on functional changes | Skips publish — your fix never ships |
| Manual `npm publish` from local | Bypasses CI, causes version drift |
| Committing `dist/` rebuilds manually | `release.yml` already builds in CI; causes noise diffs |
| Wrong commit prefix (e.g. `feat:` for a doc fix) | Triggers unwanted minor bump |

---

## Related

- `dna flow oss-launch-zero-to-one` — initial 0→1 launch procedure
- `dna convention oss-release-playbook` — the static CI/CD contract every OSS repo must satisfy
- `dna philosophy readme-is-product` — README quality bar
