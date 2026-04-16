# Spec — GBTD (Goal / Boundary / Tools / Deprecated)

Every autonomous unit declares a _spec_ — a hierarchical tree of
**Goal**, **Boundary**, **Tools**, and optionally **Deprecated**. This is not
documentation; it is the unit's contract with the system.

## The Four Elements

| Element        | Question                                   | Example                                                                      |
| -------------- | ------------------------------------------ | ---------------------------------------------------------------------------- |
| **Goal**       | What do you do and why?                    | "拿 ticket、写代码、修 bug、提升产品能力。每次交付能跑、能验证、有 commit。" |
| **Boundary**   | What do you _not_ do? Where are the edges? | "不运行产品给用户。不决定产品方向。不 CLI deploy。"                          |
| **Tools**      | What do you use to get it done?            | "spec.md, CLI tools, git"                                                    |
| **Deprecated** | What patterns are no longer allowed?       | "SSH to Linux → use OpenClaw node instead"                                   |

Goal + Boundary + Tools are required. Deprecated is optional but audited when
present.

A goal without boundaries is a blank check. A goal without tools is a wish. A
deprecated section prevents the system from regressing.

## Spec Levels

Specs exist at three levels, with inheritance:

| Level      | File                          | Scope                                        |
| ---------- | ----------------------------- | -------------------------------------------- |
| **Global** | `~/.openclaw/GOAL.yaml`       | System-wide — all agents inherit             |
| **Agent**  | `{workspace}/GOAL.yaml`       | Agent-specific — overrides/extends global    |
| **Node**   | Nested inside agent GOAL.yaml | Pod, project, launcher — inherits from agent |

Global deprecated patterns are inherited by ALL agents unless explicitly
exempted (via `exemptions` list).

## Who Needs a Spec

Any unit that executes autonomously:

| Unit                    | File                          | Example                         |
| ----------------------- | ----------------------------- | ------------------------------- |
| Agent                   | `{workspace}/GOAL.yaml`       | Any autonomous agent            |
| Pod / step              | Node inside agent's GOAL.yaml | `pods.engineer`, `pods.product` |
| Sub-project             | Node inside agent's GOAL.yaml | `projects.crossroads`           |
| Launcher / orchestrator | Node inside agent's GOAL.yaml | `launcher`                      |

## Hierarchy Rule

Every node has a `serves` field pointing to its parent. Sub-goals _must_ serve
their parent's goal. If a sub-goal doesn't serve the parent, it doesn't belong.

```
agent (root goal)
├── launcher       serves: agent
├── pods/
│   ├── product    serves: agent
│   ├── engineer   serves: agent
│   └── ...
└── projects/
    ├── project-a  serves: agent
    └── project-b  serves: agent
```

## How to Write a GOAL.yaml

### 1. Start with the root

```yaml
agent_name:
  goal: >
    One paragraph. What this agent does, why it exists,
    who it serves.
  boundary:
    - What it does NOT do (list)
  tools:
    - What it uses (list)
```

### 2. Add sub-nodes for each autonomous unit

```yaml
agent_name:
  goal: ...
  boundary: [...]
  tools: [...]

  pods:
    engineer:
      goal: >
        What the engineer pod does.
      boundary:
        - What it does not do.
      tools:
        - What it uses.
      serves: agent_name
```

### 3. Keep goals short

One paragraph max. If you need more, the goal is too broad — split into
sub-nodes.

### 4. Boundaries are explicit negations

Don't write vague boundaries like "stays focused". Write concrete exclusions:

- ❌ "Stays within scope" — vague
- ✅ "不写代码。不修改 ticket 状态。不 CLI deploy。" — concrete

### 5. Tools are specific

Not "uses various tools". List the actual tools, scripts, CLIs, files:

- ❌ "Uses project tools" — vague
- ✅ "jira-cli, git, projects/{id}/engineer_pod.md, spec.md" — specific

### 6. Deprecated patterns declare what NOT to use anymore

Deprecated patterns live in the `deprecated` section. Each entry has:

- `pattern`: what is deprecated (tool call pattern, approach, etc.)
- `replacement`: what to use instead
- `reason`: why it was deprecated
- `since`: date the deprecation took effect
- `exemptions` (optional): list of agents exempt from this rule

```yaml
agent_name:
  goal: ...
  deprecated:
    - pattern: "manual deploy via CLI"
      replacement: "git push + CI/CD auto-deploy"
      reason: "Manual deploys bypass CI checks and are unauditable"
      since: "2026-04-10"
```

Global deprecations in `~/.openclaw/GOAL.yaml` are inherited by all agents.
Agent-level deprecations add to (not replace) the global list.

## Full Example

```yaml
my-agent:
  goal: >
    Manage multiple product projects — product/engineering/QA pods
    running in rotation, continuously maintaining and improving products.
  boundary:
    - Does not write product code directly — delegates to pods
    - Does not manually decide launch order — probability-driven
    - Does not mix projects in one cron — one pod, one project per run
  tools:
    - launcher.py (probability-weighted launcher)
    - projects.yaml (project registry)
    - jira-cli (ticket management)

  pods:
    engineer:
      goal: >
        Pick up tickets, write code, fix bugs, improve product.
        Each delivery must be runnable, verifiable, and committed.
      boundary:
        - Does not run the product for users
        - Does not decide product direction
        - Does not CLI deploy — git push only, CI/CD auto-deploys
      tools:
        - projects/{id}/engineer_pod.md
        - projects/{id}/spec.md
        - jira-cli
        - git
      serves: my-agent

  projects:
    my-project:
      goal: >
        Build an interactive experience.
      boundary:
        - PWA deployment (Next.js + Vercel)
      tools:
        - projects/my-project/spec.md
        - projects/my-project/*_pod.md
      serves: my-agent
```

## CLI: `dna spec`

```bash
# Full GBTD output (Goal + Boundary + Tools + Deprecated)
# Deprecated patterns from both global and agent level are ALWAYS shown
dna spec <agent>

# Specific node + parent chain (for pod execution)
dna spec <agent> pods.engineer

# Compact tree overview (+ deprecated)
dna spec <agent> --tree

# JSON output (+ merged deprecated)
dna spec <agent> --json

# FILTER: single field output
dna spec <agent> --goal          # Goal text only
dna spec <agent> --boundary      # Boundary list only
dna spec <agent> --tools         # Tools list only

# Global spec (system-wide)
dna spec --global
dna spec --global --json

# FILTER: show only deprecated section (global + agent merged)
dna spec <agent> --deprecated
dna spec --global --deprecated

# AUDIT: list active deprecated patterns for this agent (excludes exempted)
dna spec <agent> --check-deprecated

# REPO MODE: read dna.yaml from a GitHub repo (requires `gh` CLI)
dna spec --repo <owner/repo>                   # Full GBTD
dna spec --repo <owner/repo> --spec            # Read referenced spec doc
dna spec --repo <owner/repo> --goal            # Goal text only
dna spec --repo <owner/repo> --json            # JSON output
```

### Repo-based Spec Pattern (GBTD-S)

Services and tools that live in their own repo can declare `dna.yaml` +
`SPEC.md` at repo root. This is the **GBTD-S** pattern: Goal / Boundary / Tools
/ Deprecated + Spec pointer.

```yaml
# dna.yaml (repo root)
goal: >-
  What this service does.
boundary:
  - What it does not do.
tools:
  - What it uses.
spec: SPEC.md # pointer to the detailed spec document
deprecated:
  - pattern: "old thing"
    replacement: "new thing"
    since: "2026-04-11"
```

Parent agents reference the repo instead of inlining the full spec:

```yaml
# In parent agent's dna.yaml
api-worker:
  repo: <owner/repo>  # "dna spec --repo <owner/repo>"
```

_Default output is always full GBTD_ — no flag needed to see deprecated
patterns. `--deprecated` is a filter (show only D), `--check-deprecated` is for
audit (shows only active non-exempt patterns).

## In Audit

Audits read `GOAL.yaml` as part of the governance check:

1. Does the agent _have_ a GOAL.yaml? (code-heavy, complex agents MUST have one)
2. Does each pod/step's execution align with its declared goal?
3. Does execution stay within declared boundaries?
4. Does it use the declared tools (and not undeclared ones for core operations)?
5. **(NEW) Deprecated pattern check**: Are any tool calls or execution patterns
   matching a deprecated pattern (global or agent-level)? Run
   `spec <agent> --check-deprecated` during audit.

Misalignment between declared spec and actual execution → finding severity
escalation. Use of deprecated patterns → Problem finding (unless agent is in the
exemption list).
