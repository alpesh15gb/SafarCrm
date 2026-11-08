"use client";

import { useState } from "react";
import { cx } from "./ui";
import { inr, inrShort } from "@/lib/format";

function niceMax(v: number) {
  if (v <= 0) return 1;
  const p = Math.pow(10, Math.floor(Math.log10(v)));
  const f = v / p;
  return (f <= 1 ? 1 : f <= 2 ? 2 : f <= 2.5 ? 2.5 : f <= 5 ? 5 : 10) * p;
}

type Point = { month: string; sales: number; profit: number; cases: number };
const METRICS = [
  { key: "sales", label: "Sales", fmt: inrShort },
  { key: "profit", label: "Profit", fmt: inrShort },
  { key: "cases", label: "Bookings", fmt: (n: number) => String(n) },
] as const;
type MKey = (typeof METRICS)[number]["key"];

const monthLabel = (iso: string, long = false) =>
  new Date(iso + "T00:00:00").toLocaleDateString("en-IN", { month: long ? "long" : "short", year: long ? "numeric" : undefined });

/** Single-series monthly column chart with a metric switch, hover tooltips and a direct label on the latest month. */
export function TrendChart({ data }: { data: Point[] }) {
  const [metric, setMetric] = useState<MKey>("sales");
  const [hover, setHover] = useState<number | null>(null);
  const m = METRICS.find((x) => x.key === metric)!;
  const vals = data.map((d) => Number(d[metric]));
  const top = niceMax(Math.max(0, ...vals));
  const bottom = Math.min(0, ...vals) < 0 ? -niceMax(-Math.min(...vals)) : 0;
  const span = top - bottom;
  const zero = (top / span) * 100; // % from top where the baseline sits
  const ticks = [top, top / 2, ...(bottom < 0 ? [0, bottom] : [0])];
  const last = data.length - 1;

  return (
    <div>
      <div className="mb-4 flex items-center justify-between gap-3">
        <div>
          <div className="text-[22px] font-semibold tracking-[-0.02em] tabular">{m.key === "cases" ? vals.reduce((a, b) => a + b, 0) : inr(vals.reduce((a, b) => a + b, 0))}</div>
          <div className="text-xs text-muted">{m.label}, last {data.length} months (confirmed and later)</div>
        </div>
        <div className="inline-flex rounded-[10px] bg-gray-200/60 p-0.5" role="tablist" aria-label="Metric">
          {METRICS.map((x) => (
            <button key={x.key} type="button" role="tab" aria-selected={metric === x.key} onClick={() => setMetric(x.key)}
              className={cx("rounded-lg px-2.5 py-1 text-xs font-medium transition-all", metric === x.key ? "bg-white text-ink shadow-[0_1px_3px_rgba(16,24,40,0.12)]" : "text-muted hover:text-ink")}>
              {x.label}
            </button>
          ))}
        </div>
      </div>

      <div className="relative h-52 pl-12" onMouseLeave={() => setHover(null)}>
        {ticks.map((t) => (
          <div key={t} className="pointer-events-none absolute left-0 right-0 flex items-center" style={{ top: `${((top - t) / span) * 100}%` }}>
            <span className="w-11 -translate-y-1/2 pr-2 text-right text-[10.5px] text-gray-400 tabular">{m.fmt(t)}</span>
            <span className={cx("h-px flex-1 -translate-y-1/2", t === 0 ? "bg-gray-300" : "border-t border-dashed border-gray-200")} />
          </div>
        ))}
        <div className="relative flex h-full items-stretch gap-2">
          {data.map((d, i) => {
            const v = vals[i];
            const h = (Math.abs(v) / span) * 100;
            const neg = v < 0;
            return (
              <div key={d.month} className="relative flex-1 cursor-default" onMouseEnter={() => setHover(i)}>
                <div className={cx("absolute inset-x-0 top-0 bottom-0 rounded-lg transition-colors", hover === i && "bg-gray-100/70")} />
                <div
                  className={cx(
                    "absolute left-1/2 w-[min(60%,40px)] -translate-x-1/2 transition-all duration-500",
                    neg ? "rounded-b-[4px] bg-red-400" : "rounded-t-[4px]",
                    !neg && (hover === i || (hover === null && i === last) ? "bg-coral" : "bg-coral/55"),
                  )}
                  style={neg ? { top: `${zero}%`, height: `${h}%` } : { bottom: `${100 - zero}%`, height: `${h}%`, minHeight: v ? 2 : 0 }}
                />
                {i === last && hover === null && v !== 0 && (
                  <div className="absolute left-1/2 -translate-x-1/2 -translate-y-full whitespace-nowrap pb-1 text-[11px] font-semibold text-ink tabular"
                    style={{ top: `${neg ? zero : zero - h}%` }}>
                    {m.fmt(v)}
                  </div>
                )}
                {hover === i && (
                  <div className="animate-pop pointer-events-none absolute bottom-full left-1/2 z-10 mb-1 w-44 -translate-x-1/2 rounded-xl bg-navy px-3 py-2 text-xs text-slate-300 shadow-pop"
                    style={{ bottom: `${Math.min(100, 100 - zero + h) }%` }}>
                    <div className="mb-1 font-semibold text-white">{monthLabel(d.month, true)}</div>
                    <div className="flex justify-between"><span>Sales</span><span className="text-white tabular">{inr(d.sales)}</span></div>
                    <div className="flex justify-between"><span>Profit</span><span className={cx("tabular", d.profit < 0 ? "text-red-300" : "text-white")}>{inr(d.profit)}</span></div>
                    <div className="flex justify-between"><span>Bookings</span><span className="text-white tabular">{d.cases}</span></div>
                  </div>
                )}
              </div>
            );
          })}
        </div>
      </div>
      <div className="mt-2 flex gap-2 pl-12">
        {data.map((d, i) => (
          <div key={d.month} className={cx("flex-1 text-center text-[11px]", i === last ? "font-semibold text-ink" : "text-gray-400")}>{monthLabel(d.month)}</div>
        ))}
      </div>
      <table className="sr-only">
        <caption>{m.label} by month</caption>
        <tbody>{data.map((d) => <tr key={d.month}><th>{monthLabel(d.month, true)}</th><td>{inr(d.sales)}</td><td>{inr(d.profit)}</td><td>{d.cases}</td></tr>)}</tbody>
      </table>
    </div>
  );
}
