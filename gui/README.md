# 🧬 DNA UI — Mesh Visualization Dashboard

A web dashboard for exploring the DNA mesh graph (`~/.openclaw/.dna`).

Launched via the main `dna` CLI:

```bash
dna ui                # start (default port 4893), open browser
dna ui --port 5000    # custom port
dna ui --stop         # stop the service
dna ui --status       # process status
dna ui --logs         # tail logs
dna ui --install-service  # install/register DNA UI under shared oxmgr daemon
dna ui --foreground   # run inline (debugging, no daemon)
```

## Reboot persistence

`dna ui` is supervised by [oxmgr](https://www.npmjs.com/package/oxmgr). For a
persistent installation that survives login/reboot, run:

```bash
dna ui --install-service
```

This is a one-shot installer: it ensures the shared oxmgr platform daemon exists
and is active, then registers `dna-ui` under that daemon. If oxmgr is already
installed by another app, the same daemon/state is reused; no manual
launchd/systemd setup is required. The `dna-ui` entry uses absolute Node/tsx
paths so it does not depend on an interactive shell `PATH`.

## What it does

- **Force-clustered node graph** of every `dna://` node, colored by type,
  sized by degree (hubs are bigger / glow brighter).
- **Search** (⌘K) — instant filter by id, title, or type.
- **Type filter** — click any type chip in the left rail to scope the graph.
- **Detail panel** — click a node to see frontmatter, body, and inbound +
  outbound edges (every edge is a click-through).
- **Mini-map + zoom controls** for navigating large meshes (390+ nodes).

## Stack

| Layer       | Choice |
|-------------|--------|
| Server      | Express + [vite-express](https://github.com/szymmis/vite-express) |
| Process mgr | [oxmgr](https://www.npmjs.com/package/oxmgr) (`dna-ui` service) |
| Frontend    | React 18 + [@xyflow/react](https://reactflow.dev/) |
| Styling     | Tailwind CSS (dark theme) |

## Data source

The server reads `${DNA_DATA}/.mesh-cache.json` (refreshed by `dna mesh scan`)
for the topology, then opens the source file on disk for full per-node
frontmatter + body when a node is selected.

## API

| Method | Path | Description |
|--------|------|-------------|
| GET | `/api/health` | Health + resolved DNA_DATA |
| GET | `/api/nodes`  | All nodes (summary) + edges |
| GET | `/api/stats`  | Counts + by-type histogram |
| GET | `/api/search?q=` | Fuzzy match (id / title / type) |
| GET | `/api/node/<id>` | Full node (frontmatter, body, in/outbound) |

## Layout

```
gui/
├── package.json
├── vite.config.ts
├── tailwind.config.js
├── tsconfig.json
└── src/
    ├── server.ts                    # Express API + vite-express
    └── client/
        ├── index.html
        ├── main.tsx
        ├── App.tsx
        ├── styles.css
        ├── lib.ts                    # type→color palette + interfaces
        └── components/
            ├── MeshGraph.tsx         # @xyflow/react canvas
            ├── NodeDetail.tsx        # right-side detail panel
            ├── SearchBar.tsx         # ⌘K search
            └── StatsPanel.tsx        # left rail stats + filter
```

## Building manually

```bash
cd gui
npm install
npm run build      # → dist/client/
npm run start      # foreground server (production mode)
```
