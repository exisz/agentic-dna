import { useMemo, useState } from "react";
import { NodeSummary, Preset, Stats, colorForType, getPreset } from "../lib";
import { useI18n } from "../i18n";

interface Props {
  stats: Stats | null;
  activeTypes: Set<string>;
  onToggleType: (t: string) => void;
  preset: Preset;
  presetAllowed: Set<string> | null;
  nodes: NodeSummary[];
  onSelect: (id: string) => void;
}

export default function StatsPanel({
  stats,
  activeTypes,
  onToggleType,
  preset,
  presetAllowed,
  nodes,
  onSelect,
}: Props) {
  const { t } = useI18n();
  if (!stats) {
    return (
      <div className="panel p-4 animate-pulse">
        <div className="h-4 w-24 bg-ink-700 rounded mb-3" />
        <div className="h-16 bg-ink-700/50 rounded" />
      </div>
    );
  }

  if (isEmpireLayout(preset)) {
    return <EmpireStatsPanel stats={stats} nodes={nodes} onSelect={onSelect} />;
  }

  // Filter type list by preset (when preset is not "all")
  const sortedTypes = Object.entries(stats.by_type)
    .filter(([type]) => !presetAllowed || presetAllowed.has(type))
    .sort((a, b) => b[1] - a[1]);

  return (
    <div className="panel p-4 space-y-4 animate-fade-in">
      <div>
        <div className="text-[11px] uppercase tracking-widest text-slate-400 mb-2">
          {t("stats.mesh")}
        </div>
        <div className="grid grid-cols-3 gap-2">
          <Stat label={t("stats.nodes")} value={stats.total_nodes} accent="text-accent-cyan" />
          <Stat label={t("stats.edges")} value={stats.total_edges} accent="text-accent-violet" />
          <Stat
            label={t("stats.dead")}
            value={stats.dead_links}
            accent={stats.dead_links > 0 ? "text-accent-rose" : "text-slate-400"}
          />
        </div>
      </div>

      <div>
        <div className="flex items-center justify-between mb-2">
          <div className="text-[11px] uppercase tracking-widest text-slate-400">
            {t("stats.types")} · {sortedTypes.length}
          </div>
          {activeTypes.size > 0 && (
            <button
              onClick={() => activeTypes.forEach(onToggleType)}
              className="text-[10px] text-slate-500 hover:text-slate-300"
            >
              {t("stats.clear")}
            </button>
          )}
        </div>
        <div className="space-y-1 max-h-[40vh] overflow-y-auto pr-1">
          {sortedTypes.map(([type, n]) => {
            const active = activeTypes.size === 0 || activeTypes.has(type);
            return (
              <button
                key={type}
                onClick={() => onToggleType(type)}
                className={`w-full flex items-center justify-between gap-2 px-2.5 py-1.5 rounded-md text-xs transition border ${
                  active
                    ? "bg-ink-800/80 border-ink-600/70 hover:border-ink-500"
                    : "bg-ink-900/40 border-transparent opacity-40 hover:opacity-70"
                }`}
              >
                <span className="flex items-center gap-2 min-w-0">
                  <span
                    className="w-2.5 h-2.5 rounded-full shrink-0"
                    style={{ backgroundColor: colorForType(type), boxShadow: `0 0 8px ${colorForType(type)}66` }}
                  />
                  <span className="truncate font-mono text-slate-300">{type}</span>
                </span>
                <span className="text-slate-400 font-mono">{n}</span>
              </button>
            );
          })}
        </div>
      </div>

      <div className="text-[10px] text-slate-500 font-mono">
        {t("stats.scanned")} {new Date(stats.generated_at).toLocaleString()}
      </div>
    </div>
  );
}

function Stat({ label, value, accent }: { label: string; value: number; accent: string }) {
  return (
    <div className="bg-ink-800/60 rounded-lg px-2 py-2 border border-ink-700/50">
      <div className={`text-xl font-semibold tabular-nums ${accent}`}>{value}</div>
      <div className="text-[10px] uppercase tracking-wider text-slate-500">{label}</div>
    </div>
  );
}

// Whether a given preset id triggers the agent-centric "empire" layout/UI.
// Anchored on `preset.layout === "cluster"` (config-driven) plus the legacy
// preset ids (`empire`, `overview`) for back-compat.
export function isEmpireLayout(presetId: string): boolean {
  if (presetId === "empire" || presetId === "overview") return true;
  const p = getPreset(presetId);
  return !!p && (p.layout === "cluster" || p.layout === "empire");
}

// ─────────────────────────────────────────────────────────────────────────────
// Empire Overview stats — agents (with managed projects) + project tally
// ─────────────────────────────────────────────────────────────────────────────
function EmpireStatsPanel({
  stats,
  nodes,
  onSelect,
}: {
  stats: Stats;
  nodes: NodeSummary[];
  onSelect: (id: string) => void;
}) {
  const { t } = useI18n();
  const [expanded, setExpanded] = useState<Set<string>>(new Set());

  const { agents, projectsByAgent, unassigned, totals } = useMemo(() => {
    const agents = nodes.filter((n) => n.type === "agent");
    const projects = nodes.filter((n) => n.type === "project");
    const projectsByAgent = new Map<string, NodeSummary[]>();
    const unassigned: NodeSummary[] = [];
    for (const a of agents) projectsByAgent.set(a.id, []);
    let active = 0;
    let shadow = 0;
    for (const p of projects) {
      const isShadow = p.status === "shadow" || p.status === "stale";
      if (isShadow) shadow++;
      else active++;
      const owner = p.managedBy;
      if (owner && projectsByAgent.has(owner)) {
        projectsByAgent.get(owner)!.push(p);
      } else {
        unassigned.push(p);
      }
    }
    // Sort projects within each agent by title
    const sortFn = (a: NodeSummary, b: NodeSummary) =>
      (a.title || a.id).localeCompare(b.title || b.id);
    for (const arr of projectsByAgent.values()) arr.sort(sortFn);
    unassigned.sort(sortFn);
    agents.sort((a, b) => (a.title || a.id).localeCompare(b.title || b.id));
    return {
      agents,
      projectsByAgent,
      unassigned,
      totals: { agents: agents.length, projects: projects.length, active, shadow },
    };
  }, [nodes]);

  const toggle = (id: string) => {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  return (
    <div className="panel p-4 space-y-4 animate-fade-in">
      <div>
        <div className="text-[11px] uppercase tracking-widest text-slate-400 mb-2">
          🏛️ {t("empire.title")}
        </div>
        <div className="grid grid-cols-2 gap-2">
          <Stat label={t("empire.agents")} value={totals.agents} accent="text-accent-cyan" />
          <Stat label={t("empire.projects")} value={totals.projects} accent="text-accent-fuchsia" />
        </div>
        <div className="flex items-center gap-3 mt-2 text-[10px] font-mono text-slate-500">
          <span className="text-emerald-400">●</span>
          <span>{totals.active} {t("empire.projects.active")}</span>
          <span className="text-slate-600">·</span>
          <span className="text-slate-400">●</span>
          <span>{totals.shadow} {t("empire.projects.shadow")}</span>
        </div>
      </div>

      <div>
        <div className="text-[11px] uppercase tracking-widest text-slate-400 mb-2">
          {t("empire.agents")} · {agents.length}
        </div>
        <div className="space-y-1 max-h-[55vh] overflow-y-auto pr-1">
          {agents.map((a) => {
            const projects = projectsByAgent.get(a.id) || [];
            const isOpen = expanded.has(a.id);
            return (
              <div key={a.id} className="rounded-md border border-ink-700/60 bg-ink-800/40">
                <div className="flex items-center">
                  <button
                    onClick={() => toggle(a.id)}
                    className="px-2 py-1.5 text-slate-500 hover:text-slate-300"
                    aria-label={isOpen ? "collapse" : "expand"}
                  >
                    {isOpen ? "▼" : "▶"}
                  </button>
                  <button
                    onClick={() => onSelect(a.id)}
                    className="flex-1 flex items-center justify-between gap-2 pr-2.5 py-1.5 text-xs text-left hover:bg-ink-700/40 rounded-r-md"
                  >
                    <span className="flex items-center gap-2 min-w-0">
                      <span
                        className="w-2.5 h-2.5 rounded-full shrink-0"
                        style={{
                          backgroundColor: colorForType("agent"),
                          boxShadow: `0 0 8px ${colorForType("agent")}66`,
                        }}
                      />
                      <span className="truncate text-slate-200">
                        {a.title || a.id.split("/").pop()}
                      </span>
                    </span>
                    <span className="text-slate-400 font-mono shrink-0">{projects.length}</span>
                  </button>
                </div>
                {isOpen && (
                  <div className="px-2 pb-2 space-y-0.5">
                    {projects.length === 0 && (
                      <div className="text-[10px] text-slate-600 italic px-3 py-1">
                        {t("empire.noProjects")}
                      </div>
                    )}
                    {projects.map((p) => (
                      <button
                        key={p.id}
                        onClick={() => onSelect(p.id)}
                        className="w-full flex items-center gap-2 px-3 py-1 text-[11px] text-left rounded hover:bg-ink-700/40"
                      >
                        <span
                          className="w-1.5 h-1.5 rounded-full shrink-0"
                          style={{ backgroundColor: colorForType("project") }}
                        />
                        <span className="truncate text-slate-300">
                          {p.title || p.id.split("/").pop()}
                        </span>
                        {p.status && (
                          <span
                            className={
                              "ml-auto text-[9px] font-mono shrink-0 " +
                              (p.status === "shadow" || p.status === "stale"
                                ? "text-slate-500"
                                : "text-emerald-400")
                            }
                          >
                            {p.status}
                          </span>
                        )}
                      </button>
                    ))}
                  </div>
                )}
              </div>
            );
          })}

          {unassigned.length > 0 && (
            <div className="rounded-md border border-ink-700/60 bg-ink-900/40 mt-2">
              <div className="px-3 py-1.5 text-[10px] uppercase tracking-wider text-slate-500 font-mono">
                {t("empire.unassigned")} · {unassigned.length}
              </div>
              <div className="px-2 pb-2 space-y-0.5">
                {unassigned.map((p) => (
                  <button
                    key={p.id}
                    onClick={() => onSelect(p.id)}
                    className="w-full flex items-center gap-2 px-3 py-1 text-[11px] text-left rounded hover:bg-ink-700/40"
                  >
                    <span
                      className="w-1.5 h-1.5 rounded-full shrink-0"
                      style={{ backgroundColor: colorForType("project") }}
                    />
                    <span className="truncate text-slate-300">
                      {p.title || p.id.split("/").pop()}
                    </span>
                  </button>
                ))}
              </div>
            </div>
          )}
        </div>
      </div>

      <div className="text-[10px] text-slate-500 font-mono">
        {t("stats.scanned")} {new Date(stats.generated_at).toLocaleString()}
      </div>
    </div>
  );
}
