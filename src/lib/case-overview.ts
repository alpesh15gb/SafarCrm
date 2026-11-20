// The "Running cases" boxes on the dashboard (owner, 2026-11-20): how many active cases have flights, visas and other
// bookings, and how many have none yet, so the boss sees the workload at a glance. A case is counted in every box it
// has a booking for (flight + visa counts in both); cancelled bookings are ignored. "Active" is the same set as the
// dashboard's "N active cases" chip: the trip is not over yet, or the client still owes money.
// Every number is clickable: the case list (?box=flight.ticketed …) uses the same ids, so the list always matches it.
import { visaStage } from "./constants.ts";
import { todayIST } from "./format.ts";

export type OverviewLine = { case_id: string; service: string; status: string; visa_status?: string | null };
export type OverviewCase = { id: string; created_at: string; travel_start: string | null };

export type CaseOverview = {
  active: number;
  flight: { cases: number; ticketed: number; waiting: number; thisWeek: number; checkinDue: number };
  visa: { cases: number; notSubmitted: number; submitted: number; approved: number; refused: number };
  other: { cases: number; byService: { service: string; cases: number }[] };
  // active cases with no live booking yet, split three ways (each case in one only, most urgent first)
  noBooking: { cases: number; travelSoon: number; waitingLong: number; fresh: number };
  /** the case ids behind each number, by box key (see BOX_LABEL) */
  ids: Record<string, string[]>;
};

/** What each clickable number is called, for the case list's "Showing …" line. */
export const BOX_LABEL: Record<string, string> = {
  flight: "Flights", "flight.checkin": "Flights · web check-in due", "flight.week": "Flights · flying this week",
  "flight.ticketed": "Flights · ticketed", "flight.pending": "Flights · ticket pending",
  visa: "Visa", "visa.not_submitted": "Visa · not submitted", "visa.submitted": "Visa · submitted",
  "visa.approved": "Visa · approved", "visa.refused": "Visa · refused",
  other: "Other bookings", "other.hotel": "Other · hotel", "other.insurance": "Other · insurance", "other.rail": "Other · rail",
  "other.bus": "Other · bus", "other.other": "Other · other",
  none: "No booking yet", "none.soon": "No booking yet · travelling within 7 days", "none.waiting": "No booking yet · waiting over a week",
  "none.new": "No booking yet · new this week",
};

const OTHER_ORDER = ["hotel", "insurance", "rail", "bus", "other"];

/** flyingThisWeek: cases with a flight leaving in the next 7 days; checkinDue: cases with an open web check-in alert
 *  that is due now (the 48-hour window has opened and nobody has ticked it off). */
export function caseOverview(activeIds: Iterable<string>, lines: OverviewLine[],
  { flyingThisWeek = [], checkinDue = [], cases = [], today = todayIST() }:
  { flyingThisWeek?: Iterable<string>; checkinDue?: Iterable<string>; cases?: OverviewCase[]; today?: string } = {}): CaseOverview {
  const info = new Map(cases.map((c) => [c.id, c]));
  const day = (iso: string, add: number) => new Date(Date.parse(iso + "T00:00:00Z") + add * 86400e3).toISOString().slice(0, 10);
  const soon = day(today, 7), weekAgo = day(today, -7);
  const active = new Set(activeIds);
  const byCase = new Map<string, OverviewLine[]>();
  for (const l of lines) {
    if (!active.has(l.case_id) || l.status === "cancelled") continue;
    byCase.set(l.case_id, [...(byCase.get(l.case_id) ?? []), l]);
  }
  const week = new Set(flyingThisWeek);
  const checkin = new Set(checkinDue);
  const ids: Record<string, string[]> = {};
  const add = (key: string, id: string) => (ids[key] ??= []).push(id);

  for (const id of active) {
    const ls = byCase.get(id) ?? [];
    if (!ls.length) {
      add("none", id);
      const c = info.get(id);
      // travelling within 7 days and nothing booked is the urgent one; then cases opened over a week ago
      if (c?.travel_start && c.travel_start <= soon) add("none.soon", id);
      else if (c && c.created_at.slice(0, 10) < weekAgo) add("none.waiting", id);
      else add("none.new", id);
      continue;
    }
    const flights = ls.filter((l) => l.service === "flight");
    if (flights.length) {
      add("flight", id);
      // ticketed once every flight on the case is booked; one still pending keeps it waiting
      add(flights.some((l) => l.status === "pending") ? "flight.pending" : "flight.ticketed", id);
      if (week.has(id)) add("flight.week", id);
      if (checkin.has(id)) add("flight.checkin", id);
    }
    const visas = ls.filter((l) => l.service === "visa");
    if (visas.length) {
      add("visa", id);
      // the case is as far as its least advanced visa (one person still to submit keeps the case "not submitted")
      const steps = visas.map((l) => visaStage(l.visa_status));
      const worst = steps.reduce((a, b) => (b.step < a.step ? b : a));
      add(worst.step === 0 ? "visa.not_submitted" : worst.step === 1 ? "visa.submitted"
        : steps.some((s) => s.label === "Refused") ? "visa.refused" : "visa.approved", id);
    }
    const others = new Set(ls.filter((l) => l.service !== "flight" && l.service !== "visa").map((l) => l.service));
    if (others.size) {
      add("other", id);
      for (const s of others) add(`other.${s}`, id);
    }
  }
  const n = (k: string) => ids[k]?.length ?? 0;
  return {
    active: active.size,
    flight: { cases: n("flight"), ticketed: n("flight.ticketed"), waiting: n("flight.pending"), thisWeek: n("flight.week"), checkinDue: n("flight.checkin") },
    visa: { cases: n("visa"), notSubmitted: n("visa.not_submitted"), submitted: n("visa.submitted"), approved: n("visa.approved"), refused: n("visa.refused") },
    other: {
      cases: n("other"),
      byService: Object.keys(ids).filter((k) => k.startsWith("other.")).map((k) => ({ service: k.slice(6), cases: n(k) }))
        .sort((a, b) => b.cases - a.cases || OTHER_ORDER.indexOf(a.service) - OTHER_ORDER.indexOf(b.service)),
    },
    noBooking: { cases: n("none"), travelSoon: n("none.soon"), waitingLong: n("none.waiting"), fresh: n("none.new") },
    ids,
  };
}
