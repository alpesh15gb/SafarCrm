// The "Running cases" boxes on the dashboard (owner, 2026-11-20): how many active cases have flights, visas and other
// bookings, so the boss sees the workload at a glance. A case is counted in every box it has a booking for
// (flight + visa counts in both); cancelled bookings are ignored. "Active" is the same set as the dashboard's
// "N active cases" chip: the trip is not over yet, or the client still owes money.
import { visaStage } from "./constants.ts";

export type OverviewLine = { case_id: string; service: string; status: string; visa_status?: string | null };

export type CaseOverview = {
  active: number;
  flight: { cases: number; ticketed: number; waiting: number; thisWeek: number; checkinDue: number };
  visa: { cases: number; notSubmitted: number; submitted: number; approved: number; refused: number };
  other: { cases: number; byService: { service: string; cases: number }[] };
  noBooking: number;
};

const OTHER_ORDER = ["hotel", "insurance", "rail", "bus", "other"];

/** flyingThisWeek: cases with a flight leaving in the next 7 days; checkinDue: cases with an open web check-in alert
 *  that is due now (the 48-hour window has opened and nobody has ticked it off). */
export function caseOverview(activeIds: Iterable<string>, lines: OverviewLine[],
  { flyingThisWeek = [], checkinDue = [] }: { flyingThisWeek?: Iterable<string>; checkinDue?: Iterable<string> } = {}): CaseOverview {
  const active = new Set(activeIds);
  const byCase = new Map<string, OverviewLine[]>();
  for (const l of lines) {
    if (!active.has(l.case_id) || l.status === "cancelled") continue;
    byCase.set(l.case_id, [...(byCase.get(l.case_id) ?? []), l]);
  }
  const week = new Set(flyingThisWeek);
  const checkin = new Set(checkinDue);
  const out: CaseOverview = {
    active: active.size,
    flight: { cases: 0, ticketed: 0, waiting: 0, thisWeek: 0, checkinDue: 0 },
    visa: { cases: 0, notSubmitted: 0, submitted: 0, approved: 0, refused: 0 },
    other: { cases: 0, byService: [] },
    noBooking: 0,
  };
  const other = new Map<string, number>();
  for (const id of active) {
    const ls = byCase.get(id) ?? [];
    if (!ls.length) { out.noBooking++; continue; }
    const flights = ls.filter((l) => l.service === "flight");
    if (flights.length) {
      out.flight.cases++;
      // ticketed once every flight on the case is booked; one still pending keeps it waiting
      if (flights.some((l) => l.status === "pending")) out.flight.waiting++; else out.flight.ticketed++;
      if (week.has(id)) out.flight.thisWeek++;
      if (checkin.has(id)) out.flight.checkinDue++;
    }
    const visas = ls.filter((l) => l.service === "visa");
    if (visas.length) {
      out.visa.cases++;
      // the case is as far as its least advanced visa (one person still to submit keeps the case "not submitted")
      const steps = visas.map((l) => visaStage(l.visa_status));
      const worst = steps.reduce((a, b) => (b.step < a.step ? b : a));
      if (worst.step === 0) out.visa.notSubmitted++;
      else if (worst.step === 1) out.visa.submitted++;
      else if (steps.some((s) => s.label === "Refused")) out.visa.refused++;
      else out.visa.approved++;
    }
    const others = new Set(ls.filter((l) => l.service !== "flight" && l.service !== "visa").map((l) => l.service));
    if (others.size) {
      out.other.cases++;
      for (const s of others) other.set(s, (other.get(s) ?? 0) + 1);
    }
  }
  out.other.byService = [...other].map(([service, cases]) => ({ service, cases }))
    .sort((a, b) => b.cases - a.cases || OTHER_ORDER.indexOf(a.service) - OTHER_ORDER.indexOf(b.service));
  return out;
}
