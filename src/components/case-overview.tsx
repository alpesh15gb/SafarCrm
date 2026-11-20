import Link from "next/link";
import { PlaneTakeoff, Stamp, Layers, Inbox, ChevronRight, type LucideIcon } from "lucide-react";
import { IconChip, cx } from "@/components/ui";
import { SERVICE_LABEL, type Service } from "@/lib/constants";
import type { CaseOverview } from "@/lib/case-overview";

// box: the key the case list filters on (?box=…), so a click lists exactly the cases behind that number
type Part = { label: string; n: number; dot: string; box: string; strong?: boolean };
const list = (box: string) => `/cases?box=${encodeURIComponent(box)}`;

/** Four boxes under the greeting (owner, 2026-11-20): running cases with flights, visas, other bookings, and none yet.
 *  The big number opens all of that box's cases; each line under it opens just those (e.g. only the ticketed ones). */
export function CaseOverviewBoxes({ o }: { o: CaseOverview }) {
  const plural = (n: number) => `case${n === 1 ? "" : "s"}`;
  return (
    <section aria-label="Running cases" className="animate-fade-up mb-6">
      <div className="mb-2.5 flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1 px-0.5">
        <h2 className="text-[15px] font-semibold tracking-[-0.01em]">Running cases <span className="font-normal text-muted">· {o.active} active</span></h2>
        <span className="text-xs text-muted">Click any number to see those cases. A case with a flight and a visa is counted in both.</span>
      </div>
      <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
        <Box box="flight" icon={PlaneTakeoff} tone="blue" accent="bg-sky-500" title="Flights" n={o.flight.cases} unit={plural(o.flight.cases)}
          parts={[
            { label: "web check-in due", n: o.flight.checkinDue, dot: "bg-red-500", box: "flight.checkin", strong: true },
            { label: "flying this week", n: o.flight.thisWeek, dot: "bg-coral", box: "flight.week" },
            { label: "ticketed", n: o.flight.ticketed, dot: "bg-emerald-500", box: "flight.ticketed" },
            { label: "ticket pending", n: o.flight.waiting, dot: "bg-amber-500", box: "flight.pending" },
          ]} />
        <Box box="visa" icon={Stamp} tone="violet" accent="bg-violet-500" title="Visa" n={o.visa.cases} unit={plural(o.visa.cases)}
          parts={[
            { label: "not submitted", n: o.visa.notSubmitted, dot: "bg-amber-500", box: "visa.not_submitted" },
            { label: "submitted", n: o.visa.submitted, dot: "bg-sky-500", box: "visa.submitted" },
            { label: "approved", n: o.visa.approved, dot: "bg-emerald-500", box: "visa.approved" },
            { label: "refused", n: o.visa.refused, dot: "bg-red-500", box: "visa.refused" },
          ]} />
        <Box box="other" icon={Layers} tone="amber" accent="bg-amber-500" title="Other" n={o.other.cases} unit={plural(o.other.cases)}
          parts={o.other.byService.map((s) => ({ label: SERVICE_LABEL[s.service as Service]?.toLowerCase() ?? s.service, n: s.cases, dot: "bg-gray-400", box: `other.${s.service}` }))} />
        {/* owner, 2026-11-20: the enquiries still waiting for a booking get their own box */}
        <Box box="none" icon={Inbox} tone="grey" accent="bg-gray-400" title="No booking yet" n={o.noBooking.cases} unit={plural(o.noBooking.cases)}
          parts={[
            { label: "travelling within 7 days", n: o.noBooking.travelSoon, dot: "bg-red-500", box: "none.soon", strong: true },
            { label: "waiting over a week", n: o.noBooking.waitingLong, dot: "bg-amber-500", box: "none.waiting" },
            { label: "new this week", n: o.noBooking.fresh, dot: "bg-sky-500", box: "none.new" },
          ]} />
      </div>
    </section>
  );
}

function Box({ box, icon, tone, accent, title, n, unit, parts }: {
  box: string; icon: LucideIcon; tone: "blue" | "violet" | "amber" | "grey"; accent: string; title: string; n: number; unit: string; parts: Part[];
}) {
  const shown = parts.filter((p) => p.n > 0);
  return (
    <div className="relative overflow-hidden rounded-[14px] border border-line bg-white p-2 shadow-soft transition-shadow hover:shadow-lift">
      <span className={cx("absolute inset-x-0 top-0 h-[3px]", accent)} aria-hidden />
      <Link href={list(box)} className="group flex items-start justify-between gap-3 rounded-[10px] p-2 transition-colors hover:bg-[#fafbfc]">
        <div className="min-w-0">
          <div className="text-[13px] font-medium text-muted">{title}</div>
          <div className="mt-1 flex items-baseline gap-1.5">
            <span className="text-[30px] font-semibold leading-none tracking-[-0.03em] tabular">{n}</span>
            <span className="text-[13px] text-muted">{unit}</span>
            {n > 0 && <ChevronRight className="h-4 w-4 self-center text-gray-300 transition-transform group-hover:translate-x-0.5 group-hover:text-coral-dark" />}
          </div>
        </div>
        <IconChip icon={icon} tone={tone} />
      </Link>
      <ul className="mt-1 min-h-[52px] text-xs">
        {shown.length ? shown.map((p) => (
          <li key={p.box}>
            <Link href={list(p.box)} className="group flex items-center gap-2 rounded-md px-2 py-1 transition-colors hover:bg-gray-50">
              <span className={cx("h-1.5 w-1.5 shrink-0 rounded-full", p.dot)} aria-hidden />
              <span className={cx("tabular", p.strong ? "font-semibold text-ink" : "font-medium text-gray-700")}>{p.n}</span>
              <span className={cx("flex-1", p.strong ? "font-medium text-ink" : "text-muted")}>{p.label}</span>
              <ChevronRight className="h-3 w-3 text-gray-300 opacity-0 transition-opacity group-hover:opacity-100" />
            </Link>
          </li>
        )) : <li className="px-2 py-1 text-muted">None running</li>}
      </ul>
    </div>
  );
}
