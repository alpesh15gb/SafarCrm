import Link from "next/link";
import { PlaneTakeoff, Stamp, Layers, ArrowRight, type LucideIcon } from "lucide-react";
import { IconChip, cx } from "@/components/ui";
import { SERVICE_LABEL, type Service } from "@/lib/constants";
import type { CaseOverview } from "@/lib/case-overview";

type Part = { label: string; n: number; dot: string; strong?: boolean };

/** Three boxes under the greeting (owner, 2026-11-20): running cases with flights, visas and other bookings. */
export function CaseOverviewBoxes({ o }: { o: CaseOverview }) {
  const plural = (n: number) => `case${n === 1 ? "" : "s"}`;
  return (
    <section aria-label="Running cases" className="animate-fade-up mb-6">
      <div className="mb-2.5 flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1 px-0.5">
        <h2 className="text-[15px] font-semibold tracking-[-0.01em]">Running cases <span className="font-normal text-muted">· {o.active} active</span></h2>
        <span className="text-xs text-muted">A case with a flight and a visa is counted in both.</span>
      </div>
      <div className="grid gap-3 sm:grid-cols-3">
        <Box href="/cases?quick=active&service=flight" icon={PlaneTakeoff} tone="blue" accent="bg-sky-500" title="Flights" n={o.flight.cases} unit={plural(o.flight.cases)}
          parts={[
            { label: "web check-in due", n: o.flight.checkinDue, dot: "bg-red-500", strong: true },
            { label: "flying this week", n: o.flight.thisWeek, dot: "bg-coral" },
            { label: "ticketed", n: o.flight.ticketed, dot: "bg-emerald-500" },
            { label: "ticket pending", n: o.flight.waiting, dot: "bg-amber-500" },
          ]} />
        <Box href="/cases?quick=active&service=visa" icon={Stamp} tone="violet" accent="bg-violet-500" title="Visa" n={o.visa.cases} unit={plural(o.visa.cases)}
          parts={[
            { label: "not submitted", n: o.visa.notSubmitted, dot: "bg-amber-500" },
            { label: "submitted", n: o.visa.submitted, dot: "bg-sky-500" },
            { label: "approved", n: o.visa.approved, dot: "bg-emerald-500" },
            { label: "refused", n: o.visa.refused, dot: "bg-red-500" },
          ]} />
        <Box href="/cases?quick=active&service=others" icon={Layers} tone="amber" accent="bg-amber-500" title="Other" n={o.other.cases} unit={plural(o.other.cases)}
          hint="Hotel, insurance, rail, bus…"
          parts={o.other.byService.map((s) => ({ label: SERVICE_LABEL[s.service as Service]?.toLowerCase() ?? s.service, n: s.cases, dot: "bg-gray-400" }))} />
      </div>
      {o.noBooking > 0 && (
        <p className="mt-2 px-0.5 text-xs text-muted">
          + {o.noBooking} active {plural(o.noBooking)} with no booking yet. <Link href="/cases?quick=active&service=none" className="link">See them</Link>
        </p>
      )}
    </section>
  );
}

function Box({ href, icon, tone, accent, title, n, unit, parts, hint }: {
  href: string; icon: LucideIcon; tone: "blue" | "violet" | "amber"; accent: string; title: string; n: number; unit: string; parts: Part[]; hint?: string;
}) {
  const shown = parts.filter((p) => p.n > 0);
  return (
    <Link href={href} className="group relative overflow-hidden rounded-[14px] border border-line bg-white p-4 shadow-soft transition-shadow hover:shadow-lift focus-visible:outline-2">
      <span className={cx("absolute inset-x-0 top-0 h-[3px]", accent)} aria-hidden />
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="text-[13px] font-medium text-muted">{title}</div>
          <div className="mt-1 flex items-baseline gap-1.5">
            <span className="text-[30px] font-semibold leading-none tracking-[-0.03em] tabular">{n}</span>
            <span className="text-[13px] text-muted">{unit}</span>
          </div>
        </div>
        <IconChip icon={icon} tone={tone} />
      </div>
      <ul className="mt-3 min-h-[44px] space-y-1 text-xs">
        {shown.length ? shown.map((p) => (
          <li key={p.label} className="flex items-center gap-2">
            <span className={cx("h-1.5 w-1.5 shrink-0 rounded-full", p.dot)} aria-hidden />
            <span className={cx("tabular", p.strong ? "font-semibold text-ink" : "font-medium text-gray-700")}>{p.n}</span>
            <span className={p.strong ? "font-medium text-ink" : "text-muted"}>{p.label}</span>
          </li>
        )) : <li className="text-muted">{n ? hint : "None running"}</li>}
      </ul>
      <span className="mt-2 flex items-center gap-1 text-xs font-medium text-muted transition-colors group-hover:text-coral-dark">
        Open the list <ArrowRight className="h-3 w-3 transition-transform group-hover:translate-x-0.5" />
      </span>
    </Link>
  );
}
