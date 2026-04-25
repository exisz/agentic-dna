import { useEffect, useRef } from "react";
import { useI18n } from "../i18n";

interface Props {
  value: string;
  onChange: (v: string) => void;
  placeholder?: string;
}
export default function SearchBar({ value, onChange, placeholder }: Props) {
  const ref = useRef<HTMLInputElement>(null);
  const { t } = useI18n();
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key === "k") {
        e.preventDefault();
        ref.current?.focus();
        ref.current?.select();
      }
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, []);
  return (
    <div className="relative w-full">
      <span className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-slate-400 text-sm">
        🔍
      </span>
      <input
        ref={ref}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder || t("search.placeholder")}
        className="w-full pl-9 pr-16 py-2.5 rounded-xl bg-ink-800/70 border border-ink-700 focus:border-accent-cyan/60 focus:outline-none focus:ring-2 focus:ring-accent-cyan/20 text-sm font-mono placeholder:text-slate-500"
      />
      <kbd className="hidden sm:inline-flex absolute right-3 top-1/2 -translate-y-1/2 text-[10px] text-slate-400 px-1.5 py-0.5 rounded border border-ink-600 bg-ink-900/60 font-mono">
        ⌘K
      </kbd>
    </div>
  );
}
