import { fdate, fyRange, monthRange } from "./format.ts";

export type RangeSP = { range?: string; from?: string; to?: string };

export class RangeValidationError extends Error {}

export function customRangeError(from?: string, to?: string): string | null {
  if (!from || !to) return "Choose both From and To dates.";
  for (const value of [from, to]) {
    const date = new Date(`${value}T00:00:00Z`);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(value) || Number.isNaN(date.getTime()) || date.toISOString().slice(0, 10) !== value) {
      return "Enter valid From and To dates.";
    }
  }
  if (from > to) return "From must be on or before To.";
  return null;
}

export function resolveRange(sp: RangeSP) {
  if (sp.range === "last_month") return { ...monthRange(-1), label: "Last month" };
  if (sp.range === "fy") { const f = fyRange(); return { from: f.from, to: f.to, label: `This financial year (${f.label})` }; }
  if (sp.range === "custom" && sp.from && sp.to) {
    const error = customRangeError(sp.from, sp.to);
    if (error) throw new RangeValidationError(error);
    return { from: sp.from, to: sp.to, label: `${fdate(sp.from)} to ${fdate(sp.to)}` };
  }
  if (sp.range === "custom") return { ...monthRange(0), label: "This month (pick From and To, then press Apply)" };
  return { ...monthRange(0), label: "This month" };
}
