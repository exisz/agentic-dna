import { useEffect, useState } from "react";
import { NodeDetail, Preset, colorForType, presetHiddenFields, integrationUrl, getConfig } from "../lib";
import { useI18n } from "../i18n";

interface Props {
  nodeId: string | null;
  onClose: () => void;
  onNavigate: (id: string) => void;
  preset?: Preset;
}

export default function NodeDetailPanel({ nodeId, onClose, onNavigate, preset = "all" }: Props) {
  const { t } = useI18n();
  const [data, setData] = useState<NodeDetail | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!nodeId) {
      setData(null);
      return;
    }
    setLoading(true);
    setError(null);
    fetch(`/api/node/${encodeURIComponent(nodeId)}`)
      .then((r) => r.json())
      .then((j) => {
        if (j.error) setError(j.error);
        else setData(j);
      })
      .catch((e) => setError(String(e)))
      .finally(() => setLoading(false));
  }, [nodeId]);

  if (!nodeId) return null;
  const color = colorForType(data?.type || "");

  return (
    <aside className="panel w-[420px] max-w-[90vw] flex flex-col overflow-hidden animate-slide-in">
      <header
        className="px-4 py-3 border-b border-ink-700/60 flex items-start gap-3"
        style={{ borderTop: `2px solid ${color}` }}
      >
        <div
          className="mt-1 w-2.5 h-2.5 rounded-full shrink-0"
          style={{ backgroundColor: color, boxShadow: `0 0 10px ${color}` }}
        />
        <div className="flex-1 min-w-0">
          <div className="text-[10px] uppercase tracking-widest text-slate-400 font-mono">
            {data?.type || "…"}
          </div>
          <div className="text-base font-semibold text-slate-100 truncate">
            {data?.title || nodeId.split("/").pop()}
          </div>
          <div className="text-[11px] text-slate-500 font-mono truncate">{nodeId}</div>
        </div>
        <button
          onClick={onClose}
          className="text-slate-400 hover:text-slate-200 text-lg leading-none"
          aria-label={t("detail.close")}
        >
          ×
        </button>
      </header>

      <div className="flex-1 overflow-y-auto p-4 space-y-5">
        {loading && <div className="text-xs text-slate-400">{t("detail.loading")}</div>}
        {error && <div className="text-xs text-accent-rose">⚠ {error}</div>}

        {data && (
          <>
            {/* Path */}
            <Section title={t("detail.source")}>
              <div className="text-[11px] font-mono text-slate-400 break-all">
                {data.path}
              </div>
            </Section>

            {/* Frontmatter */}
            {(() => {
              const allFields = data.fields || {};
              const hidden = presetHiddenFields(preset);
              const visibleEntries = Object.entries(allFields).filter(([k]) =>
                hidden.size === 0 ? true : !hidden.has(k),
              );
              if (visibleEntries.length === 0) return null;
              return (
                <Section title={`${t("detail.frontmatter")} · ${visibleEntries.length}`}>
                  <dl className="space-y-1.5">
                    {visibleEntries.map(([k, v]) => (
                      <FieldRow key={k} k={k} v={v} onNavigate={onNavigate} />
                    ))}
                  </dl>
                </Section>
              );
            })()}

            {/* Outbound */}
            {data.outbound.length > 0 && (
              <Section title={`${t("detail.outbound")} · ${data.outbound.length}`}>
                <div className="flex flex-wrap gap-1.5">
                  {dedup(data.outbound).map((id) => (
                    <NodeChip key={id} id={id} onNavigate={onNavigate} />
                  ))}
                </div>
              </Section>
            )}

            {/* Inbound */}
            {data.inbound.length > 0 && (
              <Section title={`${t("detail.inbound")} · ${data.inbound.length}`}>
                <div className="flex flex-wrap gap-1.5">
                  {data.inbound.map((n) => (
                    <NodeChip key={n.id} id={n.id} type={n.type} title={n.title} onNavigate={onNavigate} />
                  ))}
                </div>
              </Section>
            )}

            {/* Body */}
            {data.body.trim().length > 0 && (
              <Section title={t("detail.body")}>
                <div className="body-text bg-ink-950/60 rounded-lg p-3 border border-ink-700/40 max-h-[40vh] overflow-y-auto">
                  {data.body.trim()}
                </div>
              </Section>
            )}
          </>
        )}
      </div>
    </aside>
  );
}

function dedup(xs: string[]): string[] {
  return Array.from(new Set(xs));
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section>
      <div className="text-[10px] uppercase tracking-widest text-slate-400 mb-1.5">
        {title}
      </div>
      {children}
    </section>
  );
}

function NodeChip({
  id,
  type,
  title,
  onNavigate,
}: {
  id: string;
  type?: string;
  title?: string;
  onNavigate: (id: string) => void;
}) {
  // Try to derive type from id if not provided
  const inferredType = type || id.match(/^dna:\/\/([^/]+)\//)?.[1] || "";
  const color = colorForType(inferredType);
  const label = title || id.replace(/^dna:\/\//, "");
  return (
    <button
      onClick={() => onNavigate(id)}
      className="chip hover:border-accent-cyan/60 hover:bg-ink-700 transition truncate max-w-full"
      title={id}
    >
      <span
        className="w-1.5 h-1.5 rounded-full shrink-0"
        style={{ backgroundColor: color }}
      />
      <span className="truncate">{label}</span>
    </button>
  );
}

function FieldRow({
  k,
  v,
  onNavigate,
}: {
  k: string;
  v: any;
  onNavigate: (id: string) => void;
}) {
  // Check if this field is the source of an integration link
  const integrations = getConfig().integrations || {};
  let integrationLink: string | null = null;
  for (const [name, def] of Object.entries(integrations)) {
    if (def.field === k && typeof v === "string") {
      integrationLink = integrationUrl(name, v);
      if (integrationLink) break;
    }
  }
  return (
    <div className="grid grid-cols-[110px,1fr] gap-2 text-[11px]">
      <dt className="font-mono text-slate-500 truncate" title={k}>{k}</dt>
      <dd className="font-mono text-slate-300 break-words">
        {integrationLink ? (
          <a
            href={integrationLink}
            target="_blank"
            rel="noreferrer noopener"
            className="text-accent-cyan hover:underline break-all"
          >
            {String(v)} ↗
          </a>
        ) : (
          renderValue(v, onNavigate)
        )}
      </dd>
    </div>
  );
}

function renderValue(v: any, onNavigate: (id: string) => void): React.ReactNode {
  if (v == null) return <span className="text-slate-500">—</span>;
  if (typeof v === "string") {
    if (v.startsWith("dna://")) {
      return (
        <button
          onClick={() => onNavigate(v)}
          className="text-accent-cyan hover:underline break-all text-left"
        >
          {v}
        </button>
      );
    }
    return <span>{v}</span>;
  }
  if (typeof v === "number" || typeof v === "boolean") return <span>{String(v)}</span>;
  if (Array.isArray(v)) {
    return (
      <ul className="space-y-0.5">
        {v.map((x, i) => (
          <li key={i} className="pl-2 border-l border-ink-700">
            {renderValue(x, onNavigate)}
          </li>
        ))}
      </ul>
    );
  }
  if (typeof v === "object") {
    return (
      <div className="space-y-0.5">
        {Object.entries(v).map(([k, x]) => (
          <div key={k} className="grid grid-cols-[80px,1fr] gap-1.5">
            <span className="text-slate-500">{k}</span>
            <span>{renderValue(x, onNavigate)}</span>
          </div>
        ))}
      </div>
    );
  }
  return <span>{String(v)}</span>;
}
