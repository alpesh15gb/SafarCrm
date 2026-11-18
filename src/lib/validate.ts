// Checks shared by the booking form (browser) and saveLine (server), so a half-filled booking is never saved.
import type { Service } from "./constants.ts";
import { fdate } from "./format.ts";
import { sectorTimeIssues } from "./flight-time.ts";

const DATE_PAIRS: [string, string, string, boolean][] = [
  // [first, second, message, must be strictly after]
  ["check_in", "check_out", "Check-out must be after check-in.", true],
  ["start_date", "end_date", "The policy end date can't be before its start date.", false],
  ["valid_from", "valid_to", "The visa's 'valid until' date can't be before 'valid from'.", false],
  ["applied_on", "expected_by", "The decision date can't be before the date applied.", false],
];

/** What's wrong with a booking, in plain words, or null when it can be saved.
 *  Owner, 2026-11-18: a booking is the ticket file plus prices; sectors, PNR, hotel name and the like are no longer
 *  typed in, so nothing is required. Details an older booking already has are still checked for obvious mistakes. */
export function lineProblem(service: Service, d: Record<string, unknown>): string | null {
  const v = (k: string) => String(d[k] ?? "").trim();
  if (service === "flight") {
    // only sectors someone actually filled in (an untouched blank sector is ignored)
    const sectors = (Array.isArray(d.sectors) ? (d.sectors as Record<string, string>[]) : [])
      .filter((s) => ["from", "to", "date", "airline", "flight_no", "dep", "arr"].some((k) => String(s[k] ?? "").trim()));
    let prev = "";
    for (const [i, s] of sectors.entries()) {
      const from = String(s.from ?? "").trim().toUpperCase(), to = String(s.to ?? "").trim().toUpperCase();
      const n = sectors.length > 1 ? `Sector ${i + 1}: ` : "";
      const cap = (t: string) => (n ? t : t[0].toUpperCase() + t.slice(1));
      if (!/^[A-Z]{3}$/.test(from) || !/^[A-Z]{3}$/.test(to)) return n + cap("enter the From and To airport codes (3 letters, like BOM and DXB).");
      if (from === to) return n + cap("from and To are the same airport.");
      const timeProblem = sectorTimeIssues(s, `Sector ${i + 1}`).find((issue) => issue.tone === "red");
      if (timeProblem) return timeProblem.text;
      if (s.date && prev && s.date < prev) return n + cap(`the date ${fdate(s.date)} is before the previous sector.`);
      if (s.date) prev = s.date;
    }
  }
  for (const [a, b, msg, strict] of DATE_PAIRS) {
    if (v(a) && v(b) && (strict ? v(b) <= v(a) : v(b) < v(a))) return msg;
  }
  return null;
}

export function tripDatesProblem(start?: string | null, end?: string | null): string | null {
  return start && end && end < start ? "The trip can't end before it starts." : null;
}
