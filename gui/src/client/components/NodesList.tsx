import { useMemo, useState } from "react";
import { Edge, NodeSummary, Preset, colorForType, iconForType } from "../lib";
import { isEmpireLayout } from "./StatsPanel";
import { useI18n } from "../i18n";

interface Props {
  nodes: NodeSummary[];
  edges: Edge[];
  selectedId: string | null;
  onSelect: (id: string | null) => void;
  filterTypes: Set<string>;
  searchHits: Set<string> | null;
  preset?: Preset;
}

type SortKey = "type" | "id" | "title" | "managedBy" | "status" | "edges";
type SortDir = "asc" | "desc";

export default function NodesList({
  nodes,
  edges,
  selectedId,
  onSelect,
  filterTypes,
  searchHits,
  preset = "all",
}: Props) {
  const { t } = useI18n();
  const [sortKey, setSortKey] = useState<SortKey>("type");
  const [sortDir, setSortDir] = useState<SortDir>("asc");
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());

  // Edge degree map (in + out, counts unique pairs)
  const degree = useMemo(() => {
    const d = new Map<string, number>();
    for (const e of edges) {
      d.set(e.source, (d.get(e.source) || 0) + 1);
      d.set(e.target, (d.get(e.target) || 0) + 1);
    }
    return d;
  }, [edges]);

  // Apply filter + search
  const visible = useMemo(() => {
    return nodes.filter((n) => {
      if (filterTypes.size > 0 && !filterTypes.has(n.type)) return false;
      if (searchHits && !searchHits.has(n.id)) return false;
      return true;
    });
  }, [nodes, filterTypes, searchHits]);

  // Group by type — OR by managing agent when in Empire Overview
  const groups = useMemo(() => {
    const map = new Map<string, NodeSummary[]>();
    if (isEmpireLayout(preset)) {
      // Build agent id → title lookup so group headers show the human name
      const agentTitle = new Map<string, string>();
      for (const n of nodes) {
        if (n.type === "agent") agentTitle.set(n.id, n.title || n.id.split("/").pop() || n.id);
      }
      const agentIcon = iconForType("agent");
      const projectIcon = iconForType("project");
      for (const n of visible) {
        let key: string;
        if (n.type === "agent") {
          key = `${agentIcon} ${n.title || n.id.split("/").pop() || n.id}`;
        } else if (n.type === "project") {
          const owner = n.managedBy;
          const ownerLabel = owner ? agentTitle.get(owner) || owner.replace(/^dna:\/\/agent\//, "") : null;
          key = ownerLabel ? `${projectIcon} ${ownerLabel}` : `${projectIcon} — unassigned`;
        } else {
          key = n.type;
        }
        if (!map.has(key)) map.set(key, []);
        map.get(key)!.push(n);
      }
    } else {
      for (const n of visible) {
        if (!map.has(n.type)) map.set(n.type, []);
        map.get(n.type)!.push(n);
      }
    }
    const cmp = (a: NodeSummary, b: NodeSummary): number => {
      const dir = sortDir === "asc" ? 1 : -1;
      const va = valueFor(a, sortKey, degree);
      const vb = valueFor(b, sortKey, degree);
      if (typeof va === "number" && typeof vb === "number") {
        return (va - vb) * dir;
      }
      return String(va).localeCompare(String(vb)) * dir;
    };
    for (const [, arr] of map) arr.sort(cmp);
    return Array.from(map.entries()).sort((a, b) => a[0].localeCompare(b[0]));
  }, [visible, sortKey, sortDir, degree, preset, nodes]);

  const handleSort = (k: SortKey) => {
    if (k === sortKey) {
      setSortDir(sortDir === "asc" ? "desc" : "asc");
    } else {
      setSortKey(k);
      setSortDir("asc");
    }
  };

  const toggleGroup = (type: string) => {
    setCollapsed((prev) => {
      const next = new Set(prev);
      if (next.has(type)) next.delete(type);
      else next.add(type);
      return next;
    });
  };

  const sortIndicator = (k: SortKey) =>
    sortKey === k ? (sortDir === "asc" ? " ▲" : " ▼") : "";

  return (
    <div className="absolute inset-0 overflow-y-auto bg-ink-950/40">
      {/* Sticky header */}
      <div className="sticky top-0 z-10 grid grid-cols-[80px_1fr_2fr_1.5fr_90px_60px] gap-3 px-4 py-2 text-[10px] font-mono uppercase tracking-wider text-slate-400 bg-ink-900/95 border-b border-ink-700/80 backdrop-blur">
        <button
          onClick={() => handleSort("type")}
          className="text-left hover:text-slate-200 transition-colors"
        >
          {t("list.col.type")}{sortIndicator("type")}
        </button>
        <button
          onClick={() => handleSort("id")}
          className="text-left hover:text-slate-200 transition-colors truncate"
        >
          {t("list.col.id")}{sortIndicator("id")}
        </button>
        <button
          onClick={() => handleSort("title")}
          className="text-left hover:text-slate-200 transition-colors truncate"
        >
          {t("list.col.title")}{sortIndicator("title")}
        </button>
        <button
          onClick={() => handleSort("managedBy")}
          className="text-left hover:text-slate-200 transition-colors truncate"
        >
          {t("list.col.managedBy")}{sortIndicator("managedBy")}
        </button>
        <button
          onClick={() => handleSort("status")}
          className="text-left hover:text-slate-200 transition-colors truncate"
        >
          {t("list.col.status")}{sortIndicator("status")}
        </button>
        <button
          onClick={() => handleSort("edges")}
          className="text-right hover:text-slate-200 transition-colors"
        >
          {t("list.col.edges")}{sortIndicator("edges")}
        </button>
      </div>

      {/* Groups */}
      {groups.length === 0 && (
        <div className="px-4 py-8 text-center text-sm text-slate-500">
          {t("list.empty")}
        </div>
      )}
      {groups.map(([groupKey, items]) => {
        const isCollapsed = collapsed.has(groupKey);
        // For empire grouping, all items in a group might be different types; pick first
        const groupColor = isEmpireLayout(preset)
          ? colorForType(items[0]?.type || "")
          : colorForType(groupKey);
        return (
          <div key={groupKey}>
            <button
              onClick={() => toggleGroup(groupKey)}
              className="sticky top-9 z-[5] w-full flex items-center gap-2 px-4 py-1.5 text-[11px] font-mono bg-ink-800/95 border-b border-ink-700/60 backdrop-blur hover:bg-ink-700/80 transition-colors text-left"
            >
              <span className="text-slate-500 w-3">{isCollapsed ? "▶" : "▼"}</span>
              <span
                className="w-2 h-2 rounded-full shrink-0"
                style={{ background: groupColor }}
              />
              <span className="text-slate-200 font-semibold">{groupKey}</span>
              <span className="text-slate-500">·</span>
              <span className="text-slate-400">{items.length}</span>
            </button>
            {!isCollapsed &&
              items.map((n) => {
                const active = selectedId === n.id;
                return (
                  <button
                    key={n.id}
                    onClick={() => onSelect(n.id)}
                    className={
                      "w-full grid grid-cols-[80px_1fr_2fr_1.5fr_90px_60px] gap-3 px-4 py-1.5 text-[12px] " +
                      "border-b border-ink-800/60 transition-colors text-left " +
                      (active
                        ? "bg-cyan-500/10 hover:bg-cyan-500/20"
                        : "hover:bg-ink-800/60")
                    }
                  >
                    <span
                      className="chip text-[10px] truncate self-center"
                      style={{ background: colorForType(n.type) + "22", color: colorForType(n.type), borderColor: colorForType(n.type) + "55" }}
                    >
                      {n.type}
                    </span>
                    <span className="font-mono text-[11px] text-slate-400 truncate self-center" title={n.id}>
                      {shortId(n.id)}
                    </span>
                    <span className="text-slate-200 truncate self-center" title={n.title || ""}>
                      {n.title || n.id.split("/").pop()}
                    </span>
                    <span className="font-mono text-[10px] text-slate-500 truncate self-center" title={n.managedBy || ""}>
                      {n.managedBy ? shortId(n.managedBy) : "—"}
                    </span>
                    <span className="text-[11px] self-center truncate">
                      {renderStatus(n.status)}
                    </span>
                    <span className="font-mono text-[11px] text-slate-400 text-right self-center">
                      {degree.get(n.id) || 0}
                    </span>
                  </button>
                );
              })}
          </div>
        );
      })}
    </div>
  );
}

function valueFor(n: NodeSummary, key: SortKey, degree: Map<string, number>): string | number {
  switch (key) {
    case "type":
      return n.type;
    case "id":
      return n.id;
    case "title":
      return (n.title || n.id).toLowerCase();
    case "managedBy":
      return (n.managedBy || "").toLowerCase();
    case "status":
      return (n.status || "").toLowerCase();
    case "edges":
      return degree.get(n.id) || 0;
  }
}

function shortId(id: string): string {
  // dna://type/slug → type/slug
  return id.replace(/^dna:\/\//, "");
}

function renderStatus(s?: string): JSX.Element {
  if (!s) return <span className="text-slate-600">—</span>;
  const color =
    s === "active" || s === "ok" || s === "done"
      ? "text-emerald-400"
      : s === "deprecated" || s === "stale" || s === "blocked"
      ? "text-rose-400"
      : s === "todo" || s === "wip" || s === "draft"
      ? "text-amber-400"
      : "text-slate-300";
  return <span className={color}>{s}</span>;
}
