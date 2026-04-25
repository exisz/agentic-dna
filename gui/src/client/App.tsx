import { useEffect, useMemo, useState } from "react";
import MeshGraph from "./components/MeshGraph";
import NodesList from "./components/NodesList";
import NodeDetailPanel from "./components/NodeDetail";
import SearchBar from "./components/SearchBar";
import StatsPanel from "./components/StatsPanel";
import {
  Edge,
  NodeSummary,
  Stats,
  Preset,
  fetchConfig,
  presetAllowedTypes,
  getPresetOptions,
  getPresetIds,
} from "./lib";
import { LanguageToggle, useI18n } from "./i18n";

type ViewMode = "graph" | "list";
const VIEW_STORAGE_KEY = "dna.ui.view";
const PRESET_STORAGE_KEY = "dna.ui.preset";

function readStoredView(): ViewMode {
  if (typeof window === "undefined") return "graph";
  try {
    const v = window.localStorage.getItem(VIEW_STORAGE_KEY);
    if (v === "graph" || v === "list") return v;
  } catch {
    /* ignore */
  }
  return "graph";
}

function readStoredPreset(): Preset {
  if (typeof window === "undefined") return "all";
  try {
    const v = window.localStorage.getItem(PRESET_STORAGE_KEY);
    if (v) return v;
  } catch {
    /* ignore */
  }
  return "all";
}

export default function App() {
  const { t } = useI18n();
  const [nodes, setNodes] = useState<NodeSummary[]>([]);
  const [edges, setEdges] = useState<Edge[]>([]);
  const [stats, setStats] = useState<Stats | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [search, setSearch] = useState("");
  const [filterTypes, setFilterTypes] = useState<Set<string>>(new Set());
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [view, setView] = useState<ViewMode>(() => readStoredView());
  const [preset, setPresetState] = useState<Preset>(() => readStoredPreset());
  const [configReady, setConfigReady] = useState(false);

  const setPreset = (p: Preset) => {
    setPresetState(p);
    // Reset manual type filters when switching presets
    setFilterTypes(new Set());
    try {
      window.localStorage.setItem(PRESET_STORAGE_KEY, p);
    } catch {
      /* ignore */
    }
  };

  const setViewPersist = (v: ViewMode) => {
    setView(v);
    try {
      window.localStorage.setItem(VIEW_STORAGE_KEY, v);
    } catch {
      /* ignore */
    }
  };

  useEffect(() => {
    // Load config first, then load mesh data. Both can fail independently.
    fetchConfig().finally(() => {
      setConfigReady(true);
      // If stored preset doesn't exist in config, fall back to "all".
      const presetIds = getPresetIds();
      if (!presetIds.includes(preset)) {
        setPresetState("all");
      }
    });
    Promise.all([
      fetch("/api/nodes").then((r) => r.json()),
      fetch("/api/stats").then((r) => r.json()),
    ])
      .then(([nodesRes, statsRes]) => {
        if (nodesRes.error) throw new Error(nodesRes.error);
        setNodes(nodesRes.nodes);
        setEdges(nodesRes.edges);
        setStats(statsRes);
      })
      .catch((e) => setError(String(e?.message || e)))
      .finally(() => setLoading(false));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Compute effective allowed types from preset (config-driven)
  const presetAllowed = useMemo<Set<string> | null>(() => {
    void configReady; // re-eval after config loads
    return presetAllowedTypes(preset);
  }, [preset, configReady]);

  // Effective filter combines preset ∩ user toggle (toggle filters within preset)
  const effectiveFilterTypes = useMemo<Set<string>>(() => {
    if (!presetAllowed) return filterTypes;
    if (filterTypes.size === 0) return presetAllowed;
    const out = new Set<string>();
    for (const t of filterTypes) if (presetAllowed.has(t)) out.add(t);
    return out.size > 0 ? out : presetAllowed;
  }, [presetAllowed, filterTypes]);

  // Search hits (id set) — null when no search
  const searchHits = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q) return null;
    return new Set(
      nodes
        .filter(
          (n) =>
            n.id.toLowerCase().includes(q) ||
            (n.title || "").toLowerCase().includes(q) ||
            n.type.toLowerCase().includes(q),
        )
        .map((n) => n.id),
    );
  }, [search, nodes]);

  const searchResults = useMemo(() => {
    if (!searchHits) return [];
    return nodes.filter((n) => searchHits.has(n.id)).slice(0, 8);
  }, [searchHits, nodes]);

  const toggleType = (t: string) => {
    setFilterTypes((prev) => {
      const next = new Set(prev);
      if (next.has(t)) next.delete(t);
      else next.add(t);
      return next;
    });
  };

  return (
    <div className="h-screen w-screen flex flex-col overflow-hidden">
      {/* Top bar */}
      <header className="flex items-center gap-4 px-5 py-3 border-b border-ink-800/80 bg-ink-950/60 backdrop-blur z-20">
        <div className="flex items-center gap-2.5 shrink-0">
          <div className="w-8 h-8 rounded-lg bg-gradient-to-br from-accent-violet to-accent-cyan flex items-center justify-center text-lg shadow-lg">
            🧬
          </div>
          <div>
            <div className="font-semibold tracking-tight leading-none">{t("app.title")}</div>
            <div className="text-[10px] text-slate-400 font-mono">{t("app.subtitle")}</div>
          </div>
        </div>
        <div className="flex-1 max-w-xl relative">
          <SearchBar value={search} onChange={setSearch} />
          {searchResults.length > 0 && (
            <div className="absolute top-full left-0 right-0 mt-1.5 panel py-1 max-h-[60vh] overflow-y-auto z-30 animate-fade-in">
              {searchResults.map((r) => (
                <button
                  key={r.id}
                  onClick={() => {
                    setSelectedId(r.id);
                    setSearch("");
                  }}
                  className="w-full text-left px-3 py-1.5 hover:bg-ink-700/60 flex items-baseline gap-2 group"
                >
                  <span className="chip text-[10px]">{r.type}</span>
                  <span className="text-sm text-slate-200 truncate">
                    {r.title || r.id.split("/").pop()}
                  </span>
                  <span className="text-[10px] text-slate-500 font-mono ml-auto truncate group-hover:text-slate-400">
                    {r.id}
                  </span>
                </button>
              ))}
            </div>
          )}
        </div>
        <div className="hidden md:flex items-center gap-3 text-[11px] text-slate-400 font-mono shrink-0">
          {stats && (
            <>
              <span>{stats.total_nodes} {t("header.nodes")}</span>
              <span className="text-slate-600">·</span>
              <span>{stats.total_edges} {t("header.edges")}</span>
              {stats.dead_links > 0 && (
                <>
                  <span className="text-slate-600">·</span>
                  <span className="text-accent-rose">{stats.dead_links} {t("header.dead")}</span>
                </>
              )}
            </>
          )}
        </div>
        <ViewToggle view={view} onChange={setViewPersist} />
        <PresetToggle preset={preset} onChange={setPreset} />
        <LanguageToggle />
      </header>

      {/* Main */}
      <main className="flex-1 flex min-h-0 relative">
        {/* Left rail: stats */}
        <div className="w-72 shrink-0 p-3 overflow-y-auto">
          <StatsPanel
            stats={stats}
            activeTypes={filterTypes}
            onToggleType={toggleType}
            preset={preset}
            presetAllowed={presetAllowed}
            nodes={nodes}
            onSelect={setSelectedId}
          />
        </div>

        {/* Graph */}
        <div className="flex-1 relative min-w-0">
          {loading && (
            <div className="absolute inset-0 grid place-items-center text-slate-400 text-sm">
              <div className="flex flex-col items-center gap-3">
                <div className="w-10 h-10 rounded-full border-2 border-accent-cyan/30 border-t-accent-cyan animate-spin" />
                <div>{t("loading.mesh")}</div>
              </div>
            </div>
          )}
          {error && (
            <div className="absolute inset-0 grid place-items-center p-8">
              <div className="panel p-6 max-w-md text-center">
                <div className="text-2xl mb-2">⚠️</div>
                <div className="text-sm text-accent-rose mb-2">{t("error.title")}</div>
                <div className="text-xs font-mono text-slate-400 break-words">{error}</div>
                <div className="text-xs text-slate-500 mt-3">
                  {t("error.hint")} <code className="chip">dna mesh scan</code>
                </div>
              </div>
            </div>
          )}
          {!loading && !error && view === "graph" && (
            <MeshGraph
              nodes={nodes}
              edges={edges}
              selectedId={selectedId}
              onSelect={setSelectedId}
              filterTypes={effectiveFilterTypes}
              searchHits={searchHits}
              preset={preset}
            />
          )}
          {!loading && !error && view === "list" && (
            <NodesList
              nodes={nodes}
              edges={edges}
              selectedId={selectedId}
              onSelect={setSelectedId}
              filterTypes={effectiveFilterTypes}
              searchHits={searchHits}
              preset={preset}
            />
          )}
        </div>

        {/* Right rail: detail */}
        {selectedId && (
          <div className="absolute right-3 top-3 bottom-3 z-10">
            <NodeDetailPanel
              nodeId={selectedId}
              onClose={() => setSelectedId(null)}
              onNavigate={(id) => setSelectedId(id)}
              preset={preset}
            />
          </div>
        )}
      </main>
    </div>
  );
}

function ViewToggle({
  view,
  onChange,
}: {
  view: "graph" | "list";
  onChange: (v: "graph" | "list") => void;
}) {
  const { t } = useI18n();
  const opts: Array<{ id: "graph" | "list"; icon: string; key: string }> = [
    { id: "graph", icon: "📊", key: "view.graph" },
    { id: "list", icon: "📋", key: "view.list" },
  ];
  return (
    <div
      className="hidden sm:flex items-center gap-0.5 px-1 py-1 rounded-lg bg-ink-800/60 border border-ink-600/60 shrink-0"
      role="tablist"
      aria-label={t("view.toggle")}
    >
      {opts.map((o) => {
        const active = view === o.id;
        return (
          <button
            key={o.id}
            type="button"
            role="tab"
            aria-selected={active}
            onClick={() => onChange(o.id)}
            title={t(o.key)}
            className={
              "flex items-center gap-1 px-2 py-1 rounded text-[11px] font-mono transition-colors " +
              (active
                ? "bg-cyan-500/20 text-cyan-200 border border-cyan-500/40"
                : "text-slate-400 hover:text-slate-200 hover:bg-ink-700/60 border border-transparent")
            }
          >
            <span className="text-[13px] leading-none">{o.icon}</span>
            <span>{t(o.key)}</span>
          </button>
        );
      })}
    </div>
  );
}

function PresetToggle({
  preset,
  onChange,
}: {
  preset: Preset;
  onChange: (p: Preset) => void;
}) {
  const { t } = useI18n();
  const options = getPresetOptions();
  return (
    <div
      className="hidden md:flex items-center gap-0.5 px-1 py-1 rounded-lg bg-ink-800/60 border border-ink-600/60 shrink-0"
      role="tablist"
      aria-label={t("preset.title")}
    >
      {options.map((o) => {
        const active = preset === o.id;
        // Try i18n key first (preset.<id>); fall back to config label.
        const i18nKey = `preset.${o.id}`;
        const i18nLabel = t(i18nKey);
        const label = i18nLabel === i18nKey ? o.label : i18nLabel;
        return (
          <button
            key={o.id}
            type="button"
            role="tab"
            aria-selected={active}
            onClick={() => onChange(o.id)}
            title={label}
            className={
              "flex items-center gap-1 px-2 py-1 rounded text-[11px] font-mono transition-colors " +
              (active
                ? "bg-violet-500/20 text-violet-200 border border-violet-500/40"
                : "text-slate-400 hover:text-slate-200 hover:bg-ink-700/60 border border-transparent")
            }
          >
            <span className="text-[13px] leading-none">{o.icon}</span>
            <span>{label}</span>
          </button>
        );
      })}
    </div>
  );
}
