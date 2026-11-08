import { fdate, fyRange, monthRange } from "./format";

export type RangeSP = { range?: string; from?: string; to?: string };

export function resolveRange(sp: RangeSP) {
  if (sp.range === "last_month") return { ...monthRange(-1), label: "Last month" };
  if (sp.range === "fy") { const f = fyRange(); return { from: f.from, to: f.to, label: `This financial year (${f.label})` }; }
  if (sp.range === "custom" && sp.from && sp.to) return { from: sp.from, to: sp.to, label: `${fdate(sp.from)} to ${fdate(sp.to)}` };
  return { ...monthRange(0), label: "This month" };
}
