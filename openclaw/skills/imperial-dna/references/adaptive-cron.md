# Adaptive Cron — Self-Adjusting Frequency

> Module of DNA. Read this when setting up adaptive/dynamic cron schedules or frequency auto-adjustment.

## Concept

An adaptive cron starts at low frequency (once/day). After each run, the agent evaluates board state and adjusts:
- **Many To Do tickets** → `up` (run more often)
- **Board is clear** → `down` (run less often)

## Frequency Tiers

| Tier | Interval | Runs/Day |
|------|----------|----------|
| 0 | 24h | 1 |
| 1 | 12h | 2 |
| 2 | 6h | 4 |
| 3 | 4h | 6 |
| 4 | 2h | 12 |
| 5 | 1h | 24 |

## CLI: `dna cron`

```bash
# Adjust frequency up (more frequent)
dna cron up <cron_id>

# Adjust frequency down (less frequent)
dna cron down <cron_id>

# Linked cron: sync follower to source at multiplier
dna cron link <follower_id> <source_id> <multiplier>
```

## Safety Rules

1. Cron name **must** contain `[ADAPTIVE]` — script refuses otherwise
2. Schedule kind **must** be `every` (not `cron`)
3. `anchorMs` is **never** changed — only `everyMs`
4. Cron ID hardcoded in entrypoint to prevent cross-cron accidents

## Integration Pattern

At end of cron workflow:

1. Check board: query your issue tracker for open items (e.g. status = "To Do")
2. Decide:
   - **5+ To Do** → `dna cron up <id>`
   - **0-2 To Do** → `dna cron down <id>`
   - **3-4 To Do** → no change
3. For linked crons, also run: `dna cron link <follower> <source> <multiplier>`

## Linked Adaptive Crons

A linked cron follows another at a fixed multiplier.

### Naming Convention
```
[LINKED:<source_id>:<multiplier>x] <name>
```

### Safety (Linked)
- Source must also be `every` kind
- Multiplier ≥ 1
- Result clamped to 1h–7d range

## Setup Checklist

- [ ] Cron name includes `[ADAPTIVE]` or `[LINKED:...]`
- [ ] Schedule kind is `every`
- [ ] Entrypoint has cron ID hardcoded
- [ ] Chart includes frequency adjustment as final step
