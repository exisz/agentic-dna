import { createContext, useContext, useEffect, useState, ReactNode } from "react";

export type Lang = "zh" | "en";

type Dict = Record<string, string>;

const ZH: Dict = {
  "app.title": "DNA 网络",
  "app.subtitle": "可视化仪表盘",
  "search.placeholder": "按 ID、标题或类型搜索节点…  (⌘K)",
  "header.nodes": "节点",
  "header.edges": "边",
  "header.dead": "无效",
  "lang.toggle": "切换语言",
  "loading.mesh": "加载网络中…",
  "error.title": "无法加载网络",
  "error.hint": "请尝试在终端运行",
  "stats.mesh": "网络",
  "stats.nodes": "节点",
  "stats.edges": "边",
  "stats.dead": "无效",
  "stats.types": "类型",
  "stats.clear": "清除",
  "stats.scanned": "扫描于",
  "detail.source": "来源",
  "detail.frontmatter": "前置数据",
  "detail.outbound": "→ 出向",
  "detail.inbound": "← 入向",
  "detail.body": "正文",
  "detail.loading": "加载中…",
  "detail.close": "关闭",
  "graph.legend.hint": "悬停或选中节点以显示连接边",
  "view.graph": "图",
  "view.list": "列表",
  "view.toggle": "切换视图",
  "list.col.type": "类型",
  "list.col.id": "ID",
  "list.col.title": "标题",
  "list.col.managedBy": "管理者",
  "list.col.status": "状态",
  "list.col.edges": "边数",
  "list.empty": "无符合条件的节点",
  "preset.title": "视图预设",
  "preset.empire": "帝国总览",
  "preset.governance": "治理体系",
  "preset.infra": "基础设施",
  "preset.all": "全部",
  "empire.title": "帝国总览",
  "empire.agents": "代理",
  "empire.projects": "项目",
  "empire.projects.active": "活跃",
  "empire.projects.shadow": "影子",
  "empire.unassigned": "未指派",
  "empire.noProjects": "无项目",
  "empire.managedProjects": "管理的项目",
  "empire.goal": "目标",
};

const EN: Dict = {
  "app.title": "DNA Mesh",
  "app.subtitle": "visualization dashboard",
  "search.placeholder": "Search nodes by id, title, or type…  (⌘K)",
  "header.nodes": "nodes",
  "header.edges": "edges",
  "header.dead": "dead",
  "lang.toggle": "Toggle language",
  "loading.mesh": "Loading mesh…",
  "error.title": "Could not load mesh",
  "error.hint": "Try running",
  "stats.mesh": "Mesh",
  "stats.nodes": "Nodes",
  "stats.edges": "Edges",
  "stats.dead": "Dead",
  "stats.types": "Types",
  "stats.clear": "clear",
  "stats.scanned": "scanned",
  "detail.source": "Source",
  "detail.frontmatter": "Frontmatter",
  "detail.outbound": "→ Outbound",
  "detail.inbound": "← Inbound",
  "detail.body": "Body",
  "detail.loading": "Loading…",
  "detail.close": "Close",
  "graph.legend.hint": "Hover or select a node to reveal its edges",
  "view.graph": "Graph",
  "view.list": "List",
  "view.toggle": "Toggle view",
  "list.col.type": "Type",
  "list.col.id": "ID",
  "list.col.title": "Title",
  "list.col.managedBy": "Managed By",
  "list.col.status": "Status",
  "list.col.edges": "Edges",
  "list.empty": "No nodes match the current filters",
  "preset.title": "View preset",
  "preset.empire": "Empire Overview",
  "preset.governance": "Governance",
  "preset.infra": "Infrastructure",
  "preset.all": "All",
  "empire.title": "Empire Overview",
  "empire.agents": "Agents",
  "empire.projects": "Projects",
  "empire.projects.active": "active",
  "empire.projects.shadow": "shadow",
  "empire.unassigned": "Unassigned",
  "empire.noProjects": "no projects",
  "empire.managedProjects": "Managed projects",
  "empire.goal": "Goal",
};

const DICTS: Record<Lang, Dict> = { zh: ZH, en: EN };

interface I18nCtx {
  lang: Lang;
  setLang: (l: Lang) => void;
  t: (key: string) => string;
}

const Ctx = createContext<I18nCtx>({
  lang: "zh",
  setLang: () => {},
  t: (k) => k,
});

const STORAGE_KEY = "dna-ui-lang";

export function I18nProvider({ children }: { children: ReactNode }) {
  const [lang, setLangState] = useState<Lang>(() => {
    if (typeof window === "undefined") return "zh";
    const stored = window.localStorage.getItem(STORAGE_KEY);
    return stored === "en" ? "en" : "zh";
  });

  useEffect(() => {
    try {
      window.localStorage.setItem(STORAGE_KEY, lang);
    } catch {}
    if (typeof document !== "undefined") {
      document.documentElement.lang = lang === "zh" ? "zh-CN" : "en";
    }
  }, [lang]);

  const setLang = (l: Lang) => setLangState(l);
  const t = (key: string): string => DICTS[lang][key] ?? DICTS.en[key] ?? key;

  return <Ctx.Provider value={{ lang, setLang, t }}>{children}</Ctx.Provider>;
}

export function useI18n() {
  return useContext(Ctx);
}

export function LanguageToggle({ className = "" }: { className?: string }) {
  const { lang, setLang, t } = useI18n();
  const next: Lang = lang === "zh" ? "en" : "zh";
  return (
    <button
      onClick={() => setLang(next)}
      title={t("lang.toggle")}
      aria-label={t("lang.toggle")}
      className={
        "inline-flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg text-[11px] font-mono " +
        "border border-ink-600/60 bg-ink-800/60 hover:bg-ink-700 text-slate-300 " +
        "transition shrink-0 " +
        className
      }
    >
      <span>🌐</span>
      <span className={lang === "zh" ? "text-accent-cyan" : "text-slate-500"}>CN</span>
      <span className="text-slate-600">/</span>
      <span className={lang === "en" ? "text-accent-cyan" : "text-slate-500"}>EN</span>
    </button>
  );
}
