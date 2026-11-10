// Flight sector dates and times, read only from what was entered or extracted.
// Arrival day = arr_date − date. When arr_date is missing we say so; we never infer "+1" from arr < dep.
// Pure module (no imports) so it can be unit-tested with plain Node.

export type SectorTime = {
  from?: string; to?: string;
  date?: string;      // departure local date, YYYY-MM-DD
  dep?: string;       // departure local time, HH:MM
  arr_date?: string;  // arrival local date, YYYY-MM-DD
  arr?: string;       // arrival local time, HH:MM
  dep_tz?: string;    // IANA zone of the departure airport, when known
  arr_tz?: string;    // IANA zone of the arrival airport, when known
};

export type TimeIssue = { tone: "red" | "amber"; text: string };

const DATE = /^\d{4}-\d{2}-\d{2}$/;
const TIME = /^([01]\d|2[0-3]):[0-5]\d$/;

const dayNo = (d: string) => Date.UTC(Number(d.slice(0, 4)), Number(d.slice(5, 7)) - 1, Number(d.slice(8, 10))) / 86400000;

export const isDate = (d?: string | null): d is string => !!d && DATE.test(d) && !Number.isNaN(dayNo(d));
export const isTime = (t?: string | null): t is string => !!t && TIME.test(t);

/** Days between departure and arrival dates (−1 across the date line, 0, +1, +2 …), or null when either is unknown. */
export function dayOffset(depDate?: string | null, arrDate?: string | null): number | null {
  if (!isDate(depDate) || !isDate(arrDate)) return null;
  return dayNo(arrDate) - dayNo(depDate);
}

/** "+1", "+2", "−1" for display, "" for same day, null when the arrival date isn't recorded. */
export function offsetLabel(s: SectorTime): string | null {
  const o = dayOffset(s.date, s.arr_date);
  if (o === null) return null;
  if (o === 0) return "";
  return o > 0 ? `+${o}` : `−${-o}`;
}

/** UTC offset of a zone at an instant, in minutes (e.g. Asia/Kolkata → 330). Throws on an unknown zone. */
export function zoneOffsetMinutes(tz: string, atMs: number): number {
  const f = new Intl.DateTimeFormat("en-US", {
    timeZone: tz, hourCycle: "h23", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit",
  });
  const p = Object.fromEntries(f.formatToParts(new Date(atMs)).map((x) => [x.type, x.value]));
  const wall = Date.UTC(Number(p.year), Number(p.month) - 1, Number(p.day), Number(p.hour), Number(p.minute), Number(p.second));
  return Math.round((wall - Math.floor(atMs / 1000) * 1000) / 60000);
}

export function isZone(tz?: string | null): tz is string {
  if (!tz) return false;
  try { new Intl.DateTimeFormat("en-US", { timeZone: tz }); return true; } catch { return false; }
}

/** The instant (ms since epoch) of a local date + time in a zone, or null when anything is unknown. */
export function instant(date?: string | null, time?: string | null, tz?: string | null): number | null {
  if (!isDate(date) || !isTime(time) || !isZone(tz)) return null;
  const guess = Date.UTC(Number(date.slice(0, 4)), Number(date.slice(5, 7)) - 1, Number(date.slice(8, 10)), Number(time.slice(0, 2)), Number(time.slice(3, 5)));
  // two passes settle daylight-saving edges
  let ms = guess - zoneOffsetMinutes(tz, guess) * 60000;
  ms = guess - zoneOffsetMinutes(tz, ms) * 60000;
  return ms;
}

/** Flying time in minutes, only when both ends have date, time and zone. */
export function durationMinutes(s: SectorTime): number | null {
  const a = instant(s.date, s.dep, s.dep_tz), b = instant(s.arr_date, s.arr, s.arr_tz);
  return a === null || b === null ? null : Math.round((b - a) / 60000);
}

/** Checks on one sector's dates and times. Unknowns are reported as unknown, never filled in. */
export function sectorTimeIssues(s: SectorTime, label = ""): TimeIssue[] {
  const out: TimeIssue[] = [];
  const at = label ? `${label}: ` : "";
  if (s.date && !isDate(s.date)) out.push({ tone: "red", text: `${at}the departure date is not a valid date.` });
  if (s.arr_date && !isDate(s.arr_date)) out.push({ tone: "red", text: `${at}the arrival date is not a valid date.` });
  if (s.dep && !isTime(s.dep)) out.push({ tone: "red", text: `${at}the departure time should look like 06:45.` });
  if (s.arr && !isTime(s.arr)) out.push({ tone: "red", text: `${at}the arrival time should look like 06:45.` });
  if (s.dep_tz && !isZone(s.dep_tz)) out.push({ tone: "red", text: `${at}unknown departure time zone “${s.dep_tz}”.` });
  if (s.arr_tz && !isZone(s.arr_tz)) out.push({ tone: "red", text: `${at}unknown arrival time zone “${s.arr_tz}”.` });
  const off = dayOffset(s.date, s.arr_date);
  if (s.arr && !s.arr_date) out.push({ tone: "amber", text: `${at}arrival date not recorded. Enter it from the ticket rather than guessing the day.` });
  if (off !== null && (off < -1 || off > 3)) out.push({ tone: "red", text: `${at}arrives ${off > 0 ? off + " days after" : -off + " days before"} it departs. Check the dates.` });
  const mins = durationMinutes(s);
  if (mins !== null) {
    if (mins <= 0) out.push({ tone: "red", text: `${at}with these dates, times and time zones it lands before it takes off. One of them is wrong.` });
    else if (mins > 20 * 60) out.push({ tone: "amber", text: `${at}about ${Math.round(mins / 60)} hours in the air. Check the arrival date.` });
  } else if (off === 0 && isTime(s.dep) && isTime(s.arr) && s.arr < s.dep && (!s.dep_tz || !s.arr_tz || s.dep_tz === s.arr_tz)) {
    out.push({ tone: "amber", text: `${at}arrives earlier in the day than it departs on the same date. If it lands the next day, change the arrival date.` });
  }
  return out;
}
