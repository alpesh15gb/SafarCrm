"use client";
import { useState } from "react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { cx } from "./ui";

const OPTS = [{ v: "", l: "This month" }, { v: "last_month", l: "Last month" }, { v: "fy", l: "This FY" }, { v: "custom", l: "Custom" }];

export function DateRange() {
  const router = useRouter();
  const path = usePathname();
  const sp = useSearchParams();
  const cur = sp.get("range") ?? "";
  const [from, setFrom] = useState(sp.get("from") ?? "");
  const [to, setTo] = useState(sp.get("to") ?? "");
  const go = (patch: Record<string, string>) => {
    const p = new URLSearchParams(sp.toString());
    Object.entries(patch).forEach(([k, v]) => (v ? p.set(k, v) : p.delete(k)));
    router.replace(`${path}?${p}`, { scroll: false });
  };
  return (
    <div className="flex flex-wrap items-center gap-2">
      <div className="inline-flex rounded-[10px] bg-gray-200/60 p-0.5" role="tablist" aria-label="Date range">
        {OPTS.map((o) => (
          <button key={o.v} type="button" role="tab" aria-selected={cur === o.v} onClick={() => go(o.v === "custom" ? { range: "custom" } : { range: o.v, from: "", to: "" })}
            className={cx("rounded-lg px-3 py-1 text-xs font-medium transition-all", cur === o.v ? "bg-white text-ink shadow-[0_1px_3px_rgba(16,24,40,0.12)]" : "text-muted hover:text-ink")}>
            {o.l}
          </button>
        ))}
      </div>
      {cur === "custom" && (
        <span className="flex items-center gap-1">
          <label className="flex items-center gap-1 text-xs text-muted">From<input type="date" aria-label="From" className="field !h-8 !min-h-0 !w-36 !py-0 text-xs" value={from} onChange={(e) => setFrom(e.target.value)} /></label>
          <label className="flex items-center gap-1 text-xs text-muted">To<input type="date" aria-label="To" className="field !h-8 !min-h-0 !w-36 !py-0 text-xs" value={to} onChange={(e) => setTo(e.target.value)} /></label>
          <button type="button" className="rounded-full border border-line px-2.5 py-1 text-xs" onClick={() => from && to && go({ from, to })}>Apply</button>
        </span>
      )}
    </div>
  );
}
