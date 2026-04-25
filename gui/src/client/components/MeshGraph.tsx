import { useMemo, useEffect, useState, useCallback } from "react";
import {
  ReactFlow,
  Background,
  Controls,
  MiniMap,
  Handle,
  Position,
  useReactFlow,
  ReactFlowProvider,
  type Node,
  type Edge as RFEdge,
  type NodeProps,
} from "@xyflow/react";
import { NodeSummary, Edge, Preset, colorForType } from "../lib";
import { isEmpireLayout } from "./StatsPanel";
import { useI18n } from "../i18n";

// ─────────────────────────────────────────────────────────────────────────────
// Layout modes
// ─────────────────────────────────────────────────────────────────────────────
type LayoutMode = "radial" | "force" | "tree" | "grid";
const LAYOUT_STORAGE_KEY = "dna.mesh.layout";

type Pos = { x: number; y: number };
type PosMap = Map<string, Pos>;

// ── 1. Radial cluster (original) ─────────────────────────────────────────────
function layoutRadial(nodes: NodeSummary[]): PosMap {
  const byType = new Map<string, NodeSummary[]>();
  for (const n of nodes) {
    if (!byType.has(n.type)) byType.set(n.type, []);
    byType.get(n.type)!.push(n);
  }
  const types = Array.from(byType.keys()).sort();
  const macroR = Math.max(900, Math.sqrt(nodes.length) * 140);
  const positions: PosMap = new Map();
  types.forEach((t, ti) => {
    const group = byType.get(t)!;
    const ang = (ti / types.length) * Math.PI * 2;
    const cx = Math.cos(ang) * macroR;
    const cy = Math.sin(ang) * macroR;
    const microR = Math.max(120, Math.sqrt(group.length) * 60);
    group.forEach((n, gi) => {
      const a = (gi / group.length) * Math.PI * 2 + ti;
      const rJitter = microR * (0.6 + 0.4 * Math.sin(gi * 1.7));
      positions.set(n.id, {
        x: cx + Math.cos(a) * rJitter,
        y: cy + Math.sin(a) * rJitter,
      });
    });
  });
  return positions;
}

// ── 2. Force-directed (precomputed, no extra deps) ───────────────────────────
// Simple Fruchterman-Reingold style simulation. Runs ~300 iterations once
// per (nodes,edges) input — synchronous, no animation frames, no live physics.
function layoutForce(nodes: NodeSummary[], edges: Edge[]): PosMap {
  const n = nodes.length;
  if (n === 0) return new Map();
  const idIndex = new Map<string, number>();
  nodes.forEach((node, i) => idIndex.set(node.id, i));

  // Area scales with node count so density stays sane
  const W = Math.max(1600, Math.sqrt(n) * 220);
  const k = Math.sqrt((W * W) / Math.max(1, n)); // ideal edge length

  // Seed: small radial scatter so we don't all collapse at origin
  const xs = new Float64Array(n);
  const ys = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    const a = (i / n) * Math.PI * 2;
    const r = (W / 4) * (0.4 + 0.6 * ((i * 9301 + 49297) % 233280) / 233280);
    xs[i] = Math.cos(a) * r;
    ys[i] = Math.sin(a) * r;
  }

  // Adjacency for spring forces
  const adj: Array<[number, number]> = [];
  for (const e of edges) {
    const s = idIndex.get(e.source);
    const t = idIndex.get(e.target);
    if (s === undefined || t === undefined || s === t) continue;
    adj.push([s, t]);
  }

  const ITER = n > 600 ? 200 : 300;
  let temp = W / 10;
  const cool = temp / (ITER + 1);
  const dxArr = new Float64Array(n);
  const dyArr = new Float64Array(n);

  for (let iter = 0; iter < ITER; iter++) {
    dxArr.fill(0);
    dyArr.fill(0);

    // Repulsive forces (O(n^2) — fine up to ~1500 nodes)
    for (let i = 0; i < n; i++) {
      for (let j = i + 1; j < n; j++) {
        let dx = xs[i] - xs[j];
        let dy = ys[i] - ys[j];
        let dist2 = dx * dx + dy * dy;
        if (dist2 < 0.01) {
          dx = (Math.random() - 0.5) * 0.1;
          dy = (Math.random() - 0.5) * 0.1;
          dist2 = dx * dx + dy * dy + 0.01;
        }
        const dist = Math.sqrt(dist2);
        const force = (k * k) / dist;
        const fx = (dx / dist) * force;
        const fy = (dy / dist) * force;
        dxArr[i] += fx;
        dyArr[i] += fy;
        dxArr[j] -= fx;
        dyArr[j] -= fy;
      }
    }

    // Attractive forces along edges
    for (let a = 0; a < adj.length; a++) {
      const [i, j] = adj[a];
      const dx = xs[i] - xs[j];
      const dy = ys[i] - ys[j];
      const dist = Math.sqrt(dx * dx + dy * dy) || 0.01;
      const force = (dist * dist) / k;
      const fx = (dx / dist) * force;
      const fy = (dy / dist) * force;
      dxArr[i] -= fx;
      dyArr[i] -= fy;
      dxArr[j] += fx;
      dyArr[j] += fy;
    }

    // Apply with cooling cap
    for (let i = 0; i < n; i++) {
      const disp = Math.sqrt(dxArr[i] * dxArr[i] + dyArr[i] * dyArr[i]) || 0.01;
      const capped = Math.min(disp, temp);
      xs[i] += (dxArr[i] / disp) * capped;
      ys[i] += (dyArr[i] / disp) * capped;
    }
    temp -= cool;
  }

  const positions: PosMap = new Map();
  nodes.forEach((node, i) => positions.set(node.id, { x: xs[i], y: ys[i] }));
  return positions;
}

// ── 3. Hierarchy / Tree ──────────────────────────────────────────────────────
// Roots: nodes with type "agent" (fall back to nodes with no inbound edges).
// Direction: edge source → target == parent → child.
// Orphans (unreachable from any root) get parked along the bottom row.
function layoutTree(nodes: NodeSummary[], edges: Edge[]): PosMap {
  const positions: PosMap = new Map();
  if (nodes.length === 0) return positions;

  const idSet = new Set(nodes.map((n) => n.id));
  const children = new Map<string, string[]>();
  const inbound = new Map<string, number>();
  for (const n of nodes) {
    children.set(n.id, []);
    inbound.set(n.id, 0);
  }
  for (const e of edges) {
    if (!idSet.has(e.source) || !idSet.has(e.target)) continue;
    children.get(e.source)!.push(e.target);
    inbound.set(e.target, (inbound.get(e.target) || 0) + 1);
  }

  // Roots: prefer agent type, else nodes with zero inbound
  let roots = nodes.filter((n) => n.type === "agent").map((n) => n.id);
  if (roots.length === 0) {
    roots = nodes.filter((n) => (inbound.get(n.id) || 0) === 0).map((n) => n.id);
  }

  // BFS assign depth (level) per node (first visit wins → shortest path)
  const level = new Map<string, number>();
  const visited = new Set<string>();
  const queue: string[] = [];
  for (const r of roots) {
    level.set(r, 0);
    visited.add(r);
    queue.push(r);
  }
  while (queue.length) {
    const cur = queue.shift()!;
    const lvl = level.get(cur)!;
    for (const c of children.get(cur) || []) {
      if (visited.has(c)) continue;
      visited.add(c);
      level.set(c, lvl + 1);
      queue.push(c);
    }
  }

  // Orphans → bottom row
  const orphans: string[] = [];
  for (const n of nodes) if (!visited.has(n.id)) orphans.push(n.id);

  // Bucket by level
  const byLevel = new Map<number, string[]>();
  for (const [id, lvl] of level.entries()) {
    if (!byLevel.has(lvl)) byLevel.set(lvl, []);
    byLevel.get(lvl)!.push(id);
  }

  const sortedLevels = Array.from(byLevel.keys()).sort((a, b) => a - b);
  const ROW_H = 220;
  const COL_W = 200;

  for (const lvl of sortedLevels) {
    const row = byLevel.get(lvl)!.sort();
    const rowWidth = (row.length - 1) * COL_W;
    row.forEach((id, i) => {
      positions.set(id, {
        x: i * COL_W - rowWidth / 2,
        y: lvl * ROW_H,
      });
    });
  }

  // Orphan row at bottom
  if (orphans.length) {
    const orphanLevel = (sortedLevels[sortedLevels.length - 1] ?? -1) + 2;
    orphans.sort();
    const w = (orphans.length - 1) * COL_W;
    orphans.forEach((id, i) => {
      positions.set(id, {
        x: i * COL_W - w / 2,
        y: orphanLevel * ROW_H,
      });
    });
  }

  return positions;
}

// ── 4. Grid (by type, alphabetical within row) ───────────────────────────────
function layoutGrid(nodes: NodeSummary[]): PosMap {
  const byType = new Map<string, NodeSummary[]>();
  for (const n of nodes) {
    if (!byType.has(n.type)) byType.set(n.type, []);
    byType.get(n.type)!.push(n);
  }
  const types = Array.from(byType.keys()).sort();
  const positions: PosMap = new Map();
  const COL_W = 110;
  const ROW_H = 180;
  const MAX_PER_ROW = Math.max(20, Math.ceil(Math.sqrt(nodes.length) * 1.6));

  let rowIdx = 0;
  for (const t of types) {
    const group = byType
      .get(t)!
      .slice()
      .sort((a, b) => (a.title || a.id).localeCompare(b.title || b.id));
    // Wrap groups exceeding MAX_PER_ROW into multiple rows
    for (let chunkStart = 0; chunkStart < group.length; chunkStart += MAX_PER_ROW) {
      const chunk = group.slice(chunkStart, chunkStart + MAX_PER_ROW);
      const rowWidth = (chunk.length - 1) * COL_W;
      chunk.forEach((n, i) => {
        positions.set(n.id, {
          x: i * COL_W - rowWidth / 2,
          y: rowIdx * ROW_H,
        });
      });
      rowIdx++;
    }
  }
  return positions;
}

// ── 5. Empire (agent-centric, projects orbit their managing agent) ────────────
function layoutEmpire(nodes: NodeSummary[]): PosMap {
  const positions: PosMap = new Map();
  const agents = nodes.filter((n) => n.type === "agent");
  const projects = nodes.filter((n) => n.type === "project");

  // Place agents on an outer ring (so they can be "central" relative to their cluster)
  const agentR = Math.max(900, agents.length * 200);
  const agentPos = new Map<string, Pos>();
  agents.forEach((a, i) => {
    const ang = (i / Math.max(1, agents.length)) * Math.PI * 2 - Math.PI / 2;
    const p = { x: Math.cos(ang) * agentR, y: Math.sin(ang) * agentR };
    agentPos.set(a.id, p);
    positions.set(a.id, p);
  });

  // Bucket projects by managing agent
  const byAgent = new Map<string, NodeSummary[]>();
  const unassigned: NodeSummary[] = [];
  for (const p of projects) {
    const owner = p.managedBy;
    if (owner && agentPos.has(owner)) {
      if (!byAgent.has(owner)) byAgent.set(owner, []);
      byAgent.get(owner)!.push(p);
    } else {
      unassigned.push(p);
    }
  }

  // Orbit each agent's projects around it
  for (const [agentId, group] of byAgent.entries()) {
    const c = agentPos.get(agentId)!;
    const orbitR = Math.max(180, Math.sqrt(group.length) * 90);
    group.forEach((p, gi) => {
      const ang = (gi / Math.max(1, group.length)) * Math.PI * 2;
      positions.set(p.id, {
        x: c.x + Math.cos(ang) * orbitR,
        y: c.y + Math.sin(ang) * orbitR,
      });
    });
  }

  // Unassigned projects → outer ring
  if (unassigned.length) {
    const r = agentR + 600;
    unassigned.forEach((p, i) => {
      const ang = (i / unassigned.length) * Math.PI * 2;
      positions.set(p.id, { x: Math.cos(ang) * r, y: Math.sin(ang) * r });
    });
  }

  // Any other node types that slipped through (shouldn't in empire preset, but be safe)
  for (const n of nodes) {
    if (positions.has(n.id)) continue;
    positions.set(n.id, { x: 0, y: 0 });
  }

  return positions;
}

// ─────────────────────────────────────────────────────────────────────────────
// Lightweight node renderer (unchanged from previous perf-optimised version)
// ─────────────────────────────────────────────────────────────────────────────
function MeshNodeView({ data, selected }: NodeProps) {
  const d = data as {
    label: string;
    color: string;
    size: number;
    isFocused: boolean;
    isDimmed: boolean;
    showLabel: boolean;
  };
  const ring = selected || d.isFocused;
  return (
    <div
      className="group relative flex items-center justify-center"
      style={{ opacity: d.isDimmed ? 0.18 : 1 }}
    >
      <Handle type="target" position={Position.Top} style={{ opacity: 0, pointerEvents: "none" }} />
      <div
        className="rounded-full"
        style={{
          width: d.size,
          height: d.size,
          background: d.color,
          border: ring ? "2px solid rgba(255,255,255,0.85)" : "1px solid rgba(255,255,255,0.08)",
        }}
      />
      {d.showLabel && (
        <div
          className="pointer-events-none absolute top-full mt-1 px-1.5 py-0.5 rounded text-[10px] font-mono whitespace-nowrap bg-ink-900/90 border border-ink-700 text-slate-200"
        >
          {d.label}
        </div>
      )}
      <Handle type="source" position={Position.Bottom} style={{ opacity: 0, pointerEvents: "none" }} />
    </div>
  );
}

const nodeTypes = { mesh: MeshNodeView };

// ─────────────────────────────────────────────────────────────────────────────
// Layout selector toolbar
// ─────────────────────────────────────────────────────────────────────────────
const LAYOUT_OPTIONS: Array<{ id: LayoutMode; icon: string; label: string }> = [
  { id: "radial", icon: "🔵", label: "Radial" },
  { id: "force", icon: "🕸️", label: "Force" },
  { id: "tree", icon: "🌳", label: "Tree" },
  { id: "grid", icon: "▦", label: "Grid" },
];

function LayoutSelector({
  mode,
  onChange,
}: {
  mode: LayoutMode;
  onChange: (m: LayoutMode) => void;
}) {
  return (
    <div className="absolute top-3 right-3 z-10 flex items-center gap-0.5 px-1 py-1 rounded-md bg-ink-900/80 border border-ink-700/80 backdrop-blur shadow-lg">
      {LAYOUT_OPTIONS.map((opt) => {
        const active = opt.id === mode;
        return (
          <button
            key={opt.id}
            type="button"
            onClick={() => onChange(opt.id)}
            title={opt.label}
            className={
              "flex items-center gap-1.5 px-2 py-1 rounded text-[11px] font-mono transition-colors " +
              (active
                ? "bg-cyan-500/20 text-cyan-200 border border-cyan-500/40"
                : "text-slate-400 hover:text-slate-200 hover:bg-ink-700/60 border border-transparent")
            }
          >
            <span className="text-[13px] leading-none">{opt.icon}</span>
            <span>{opt.label}</span>
          </button>
        );
      })}
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Main graph component
// ─────────────────────────────────────────────────────────────────────────────
interface Props {
  nodes: NodeSummary[];
  edges: Edge[];
  selectedId: string | null;
  onSelect: (id: string | null) => void;
  filterTypes: Set<string>;
  searchHits: Set<string> | null;
  preset?: Preset;
}

function readStoredLayout(): LayoutMode {
  if (typeof window === "undefined") return "radial";
  try {
    const v = window.localStorage.getItem(LAYOUT_STORAGE_KEY);
    if (v === "radial" || v === "force" || v === "tree" || v === "grid") return v;
  } catch {
    /* ignore */
  }
  return "radial";
}

function GraphInner({ nodes, edges, selectedId, onSelect, filterTypes, searchHits, preset = "all" }: Props) {
  const rf = useReactFlow();
  const { t } = useI18n();
  const [layoutMode, setLayoutMode] = useState<LayoutMode>(() => readStoredLayout());

  const handleLayoutChange = useCallback((m: LayoutMode) => {
    setLayoutMode(m);
    try {
      window.localStorage.setItem(LAYOUT_STORAGE_KEY, m);
    } catch {
      /* ignore */
    }
  }, []);

  // degree map
  const degree = useMemo(() => {
    const d = new Map<string, number>();
    for (const e of edges) {
      d.set(e.source, (d.get(e.source) || 0) + 1);
      d.set(e.target, (d.get(e.target) || 0) + 1);
    }
    return d;
  }, [edges]);

  // Neighbours of selected
  const neighbours = useMemo(() => {
    if (!selectedId) return new Set<string>();
    const s = new Set<string>([selectedId]);
    for (const e of edges) {
      if (e.source === selectedId) s.add(e.target);
      if (e.target === selectedId) s.add(e.source);
    }
    return s;
  }, [edges, selectedId]);

  // Precompute positions per layout mode (cached in useMemo by deps)
  // Empire preset overrides layout with agent-centric orbit positioning.
  const positions = useMemo(() => {
    if (isEmpireLayout(preset)) return layoutEmpire(nodes);
    switch (layoutMode) {
      case "force":
        return layoutForce(nodes, edges);
      case "tree":
        return layoutTree(nodes, edges);
      case "grid":
        return layoutGrid(nodes);
      case "radial":
      default:
        return layoutRadial(nodes);
    }
  }, [layoutMode, nodes, edges, preset]);

  const visibleIds = useMemo(() => {
    if (filterTypes.size === 0) return null;
    return new Set(nodes.filter((n) => filterTypes.has(n.type)).map((n) => n.id));
  }, [nodes, filterTypes]);

  const baseNodes = useMemo(() => {
    return nodes.map((n) => {
      const pos = positions.get(n.id) || { x: 0, y: 0 };
      // In Empire preset, make agents large (central) and projects medium
      let size: number;
      if (isEmpireLayout(preset)) {
        if (n.type === "agent") size = 56;
        else if (n.type === "project") size = 26;
        else size = 18;
      } else {
        size = Math.min(56, 18 + Math.log2(1 + (degree.get(n.id) || 0)) * 7);
      }
      return {
        id: n.id,
        pos,
        label: n.title || n.id.split("/").pop() || n.id,
        color: colorForType(n.type),
        size,
      };
    });
  }, [nodes, positions, degree, preset]);

  const rfNodes: Node[] = useMemo(() => {
    return baseNodes.map((b) => {
      const filteredOut = visibleIds && !visibleIds.has(b.id);
      const searchOut = searchHits && !searchHits.has(b.id);
      const isFocused = selectedId === b.id || (selectedId && neighbours.has(b.id));
      // In Empire preset, also show labels for agent nodes always (central anchors)
      const isAgentInEmpire = isEmpireLayout(preset) && nodes.find((n) => n.id === b.id)?.type === "agent";
      const isDimmed =
        Boolean(filteredOut) ||
        Boolean(searchOut) ||
        Boolean(selectedId && !neighbours.has(b.id));
      return {
        id: b.id,
        type: "mesh",
        position: b.pos,
        data: {
          label: b.label,
          color: b.color,
          size: b.size,
          isFocused,
          isDimmed,
          showLabel: Boolean(isFocused) || Boolean(isAgentInEmpire),
        },
        selectable: true,
        draggable: false,
      };
    });
  }, [baseNodes, selectedId, neighbours, visibleIds, searchHits, preset, nodes]);

  // Edges: only render those touching the selected node (perf).
  // Same (source, target) pairs are merged into one line; verbs become a comma-joined label.
  // Reverse direction (target → source) stays a separate edge.
  const rfEdges: RFEdge[] = useMemo(() => {
    if (!selectedId) return [];
    type Group = { source: string; target: string; verbs: string[] };
    const groups = new Map<string, Group>();
    for (const e of edges) {
      const touch = e.source === selectedId || e.target === selectedId;
      if (!touch) continue;
      if (visibleIds && (!visibleIds.has(e.source) || !visibleIds.has(e.target))) continue;
      const key = `${e.source}\u0000${e.target}`;
      let g = groups.get(key);
      if (!g) {
        g = { source: e.source, target: e.target, verbs: [] };
        groups.set(key, g);
      }
      const v = (e.verb || "").trim();
      if (v && !g.verbs.includes(v)) g.verbs.push(v);
    }
    const out: RFEdge[] = [];
    let i = 0;
    for (const g of groups.values()) {
      const label = g.verbs.length ? g.verbs.join(", ") : undefined;
      out.push({
        id: `e${i++}`,
        source: g.source,
        target: g.target,
        animated: false,
        label,
        labelStyle: { fill: "#cbd5e1", fontSize: 10, fontFamily: "ui-monospace, monospace" },
        labelBgStyle: { fill: "rgba(7,10,19,0.85)" },
        labelBgPadding: [4, 2],
        labelBgBorderRadius: 3,
        style: { stroke: "#22d3ee", strokeWidth: 1.4, opacity: 0.9 },
      });
    }
    return out;
  }, [edges, selectedId, visibleIds]);

  // Pan to selected
  useEffect(() => {
    if (!selectedId) return;
    const p = positions.get(selectedId);
    if (!p) return;
    rf.setCenter(p.x, p.y, { zoom: 1.1, duration: 600 });
  }, [selectedId, positions, rf]);

  // When layout mode changes, refit view smoothly
  useEffect(() => {
    if (selectedId) return;
    const id = window.setTimeout(() => {
      try {
        rf.fitView({ padding: 0.15, duration: 600 });
      } catch {
        /* ignore */
      }
    }, 50);
    return () => window.clearTimeout(id);
  }, [layoutMode, rf, selectedId]);

  return (
    <>
      <ReactFlow
        nodes={rfNodes}
        edges={rfEdges}
        nodeTypes={nodeTypes}
        onNodeClick={(_, n) => onSelect(n.id)}
        onPaneClick={() => onSelect(null)}
        minZoom={0.1}
        maxZoom={2.5}
        defaultViewport={{ x: 0, y: 0, zoom: 0.4 }}
        proOptions={{ hideAttribution: true }}
        fitView
        fitViewOptions={{ padding: 0.15, duration: 400 }}
        onlyRenderVisibleElements
        nodesDraggable={false}
        nodesConnectable={false}
        elementsSelectable
        panOnDrag
        zoomOnScroll
        nodeOrigin={[0.5, 0.5]}
      >
        <Background color="#1a2238" gap={32} size={1} />
        <Controls position="bottom-right" showInteractive={false} />
        <MiniMap
          position="bottom-left"
          nodeColor={(n) => {
            const c = (n.data as any)?.color as string | undefined;
            return c || "#64748b";
          }}
          maskColor="rgba(7,10,19,0.7)"
          pannable
          zoomable
        />
      </ReactFlow>
      <LayoutSelector mode={layoutMode} onChange={handleLayoutChange} />
      {isEmpireLayout(preset) && (
        <div className="pointer-events-none absolute top-3 right-3 z-20 mt-10 text-[10px] font-mono text-violet-300/80 px-2 py-1 rounded-md bg-ink-900/70 border border-violet-500/30 backdrop-blur">
          🏛️ Empire layout (agents → projects)
        </div>
      )}
      {!selectedId && (
        <div className="pointer-events-none absolute top-3 left-1/2 -translate-x-1/2 text-[10px] font-mono text-slate-500 px-2.5 py-1 rounded-md bg-ink-900/60 border border-ink-700/60 backdrop-blur">
          {t("graph.legend.hint")}
        </div>
      )}
    </>
  );
}

export default function MeshGraph(props: Props) {
  return (
    <ReactFlowProvider>
      <GraphInner {...props} />
    </ReactFlowProvider>
  );
}
