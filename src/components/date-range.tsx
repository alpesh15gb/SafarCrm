"use client";
import { useState } from "react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { cx } from "./ui";
import { customRangeError } from "@/lib/range";

const OPTS = [{ v: "", l: "This month" }, { v: "last_month", l: "Last month" }, { v: "fy", l: "This FY" }, { v: "custom", l: "Custom" }];

export function DateRange() {
  const router = useRouter();
  const path = usePathname();
  const sp = useSearchParams();
  const cur = sp.get("range") ?? "";
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
        <CustomDates key={`${sp.get("r") ?? ""}:${sp.get("from") ?? ""}:${sp.get("to") ?? ""}`}
          initialFrom={sp.get("from") ?? ""} initialTo={sp.get("to") ?? ""} apply={go} />
      )}
    </div>
  );
}

function CustomDates({ initialFrom, initialTo, apply }: { initialFrom: string; initialTo: string; apply: (dates: { from: string; to: string }) => void }) {
  const [from, setFrom] = useState(initialFrom);
  const [to, setTo] = useState(initialTo);
  const [submitted, setSubmitted] = useState(false);
  const problem = customRangeError(from, to);
  const error = submitted ? problem : null;
  return (
    <div className="space-y-1">
      <div className="flex flex-wrap items-center gap-1">
        <label className="flex items-center gap-1 text-xs text-muted">From<input type="date" aria-label="From" aria-invalid={!!error} className="field !h-8 !min-h-0 !w-36 !py-0 text-xs" value={from} onChange={(e) => setFrom(e.target.value)} /></label>
        <label className="flex items-center gap-1 text-xs text-muted">To<input type="date" aria-label="To" aria-invalid={!!error} className="field !h-8 !min-h-0 !w-36 !py-0 text-xs" value={to} onChange={(e) => setTo(e.target.value)} /></label>
        <button type="button" className="rounded-full border border-line px-2.5 py-1 text-xs" onClick={() => {
          setSubmitted(true);
          if (!problem) apply({ from, to });
        }}>Apply</button>
      </div>
      {error && <p role="alert" className="text-xs text-red-600">{error}</p>}
    </div>
  );
}
