import Link from "next/link";
import type { ComponentProps, ReactNode } from "react";
import { Plane, BedDouble, ShieldCheck, TrainFront, Bus, Sparkles, Stamp, ChevronLeft, Inbox, ArrowUpRight, ArrowDownRight, type LucideIcon } from "lucide-react";
import { STATUS_LABEL, STATUS_TONE, type Tone } from "@/lib/constants";
import { inr } from "@/lib/format";

export function cx(...c: (string | false | null | undefined)[]) {
  return c.filter(Boolean).join(" ");
}

const TONES: Record<Tone, string> = {
  grey: "bg-gray-100 text-gray-700 ring-gray-200/70",
  blue: "bg-blue-50 text-blue-700 ring-blue-200/70",
  amber: "bg-amber-50 text-amber-800 ring-amber-200/70",
  green: "bg-emerald-50 text-emerald-700 ring-emerald-200/70",
  red: "bg-red-50 text-red-700 ring-red-200/70",
  coral: "bg-coral-soft text-coral-dark ring-coral/25",
};
const DOTS: Record<Tone, string> = {
  grey: "bg-gray-400", blue: "bg-blue-500", amber: "bg-amber-500", green: "bg-emerald-500", red: "bg-red-500", coral: "bg-coral",
};

export function Badge({ tone = "grey", children, className, dot }: { tone?: Tone; children: ReactNode; className?: string; dot?: boolean }) {
  return (
    <span className={cx("inline-flex items-center gap-1.5 rounded-full px-2 py-0.5 text-xs font-medium whitespace-nowrap ring-1 ring-inset", TONES[tone], className)}>
      {dot && <span className={cx("h-1.5 w-1.5 rounded-full", DOTS[tone])} />}
      {children}
    </span>
  );
}

export function StatusBadge({ status }: { status: string }) {
  return <Badge dot tone={STATUS_TONE[status] ?? "grey"}>{STATUS_LABEL[status] ?? status}</Badge>;
}

export function Card({ children, className, title, sub, icon: Icon, action, pad = true }: { children: ReactNode; className?: string; title?: ReactNode; sub?: ReactNode; icon?: LucideIcon; action?: ReactNode; pad?: boolean }) {
  return (
    <section className={cx("animate-fade-up overflow-hidden rounded-[14px] border border-line bg-white shadow-soft", className)}>
      {(title || action) && (
        <header className="flex items-center justify-between gap-3 border-b border-line px-4 py-3">
          <div className="flex min-w-0 items-center gap-2.5">
            {Icon && <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-lg bg-gray-50 text-gray-500 ring-1 ring-inset ring-line"><Icon className="h-4 w-4" /></span>}
            <div className="min-w-0">
              <h2 className="truncate text-sm font-semibold tracking-[-0.005em]">{title}</h2>
              {sub && <p className="truncate text-xs text-muted">{sub}</p>}
            </div>
          </div>
          {action}
        </header>
      )}
      <div className={pad ? "p-4" : ""}>{children}</div>
    </section>
  );
}

// ---------------------------------------------------------------- avatars
const AV = [
  "bg-rose-100 text-rose-700", "bg-amber-100 text-amber-800", "bg-emerald-100 text-emerald-700", "bg-sky-100 text-sky-700",
  "bg-violet-100 text-violet-700", "bg-teal-100 text-teal-700", "bg-orange-100 text-orange-700", "bg-indigo-100 text-indigo-700",
];
function hash(s: string) { let h = 0; for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) | 0; return Math.abs(h); }
function inits(name: string) { return name.split(/\s+/).filter(Boolean).slice(0, 2).map((x) => x[0]?.toUpperCase()).join(""); }

export function Avatar({ name, size = "md", className, title }: { name?: string | null; size?: "xs" | "sm" | "md" | "lg" | "xl"; className?: string; title?: string }) {
  const n = name?.trim() || "?";
  const sz = { xs: "h-5 w-5 text-[9px]", sm: "h-6 w-6 text-[10px]", md: "h-8 w-8 text-xs", lg: "h-10 w-10 text-sm", xl: "h-14 w-14 text-lg" }[size];
  return (
    <span title={title ?? n} className={cx("inline-flex shrink-0 select-none items-center justify-center rounded-full font-semibold ring-2 ring-white", sz, AV[hash(n) % AV.length], className)}>
      {inits(n)}
    </span>
  );
}

/** Avatar + name on one line (tables, lists). */
export function Person({ name, sub, size = "sm" }: { name?: string | null; sub?: ReactNode; size?: "xs" | "sm" | "md" }) {
  if (!name) return <span className="text-muted">—</span>;
  return (
    <span className="inline-flex min-w-0 items-center gap-2">
      <Avatar name={name} size={size} />
      <span className="min-w-0">
        <span className="block truncate">{name}</span>
        {sub && <span className="block truncate text-xs text-muted">{sub}</span>}
      </span>
    </span>
  );
}

const CHIP: Record<string, string> = {
  coral: "bg-coral-soft text-coral-dark", green: "bg-emerald-50 text-emerald-600", blue: "bg-sky-50 text-sky-600",
  amber: "bg-amber-50 text-amber-600", violet: "bg-violet-50 text-violet-600", grey: "bg-gray-100 text-gray-600", red: "bg-red-50 text-red-600",
};
export function IconChip({ icon: Icon, tone = "grey", className }: { icon: LucideIcon; tone?: keyof typeof CHIP; className?: string }) {
  return <span className={cx("flex h-9 w-9 shrink-0 items-center justify-center rounded-[10px]", CHIP[tone], className)}><Icon className="h-[18px] w-[18px]" /></span>;
}

/** KPI tile: icon, big number, optional change vs previous period and a sparkline. */
export function Kpi({ label, value, icon, tone = "grey", sub, delta, deltaGood = "up", spark }: {
  label: string; value: ReactNode; icon: LucideIcon; tone?: keyof typeof CHIP; sub?: ReactNode;
  delta?: number | null; deltaGood?: "up" | "down"; spark?: number[];
}) {
  const good = delta == null ? null : deltaGood === "up" ? delta >= 0 : delta <= 0;
  return (
    <div className="animate-fade-up relative overflow-hidden rounded-[14px] border border-line bg-white p-4 shadow-soft transition-shadow hover:shadow-lift">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="text-[13px] font-medium text-muted">{label}</div>
          <div className="mt-1.5 truncate text-[22px] font-semibold leading-tight tracking-[-0.02em] tabular">{value}</div>
        </div>
        <IconChip icon={icon} tone={tone} />
      </div>
      <div className="mt-2 flex items-end justify-between gap-2">
        <div className="flex min-w-0 items-center gap-1.5 text-xs text-muted">
          {delta != null && Number.isFinite(delta) && (
            <span className={cx("inline-flex items-center gap-0.5 rounded-full px-1.5 py-0.5 font-semibold", good ? "bg-emerald-50 text-emerald-700" : "bg-red-50 text-red-600")}>
              {delta >= 0 ? <ArrowUpRight className="h-3 w-3" /> : <ArrowDownRight className="h-3 w-3" />}
              {Math.abs(Math.round(delta))}%
            </span>
          )}
          {sub && <span className="truncate">{sub}</span>}
        </div>
        {spark && spark.length > 1 && <Sparkline values={spark} />}
      </div>
    </div>
  );
}

export function Sparkline({ values, className }: { values: number[]; className?: string }) {
  const w = 72, h = 24, max = Math.max(...values), min = Math.min(0, ...values);
  const pts = values.map((v, i) => [(i / (values.length - 1)) * w, h - 2 - ((v - min) / (max - min || 1)) * (h - 4)]);
  const d = pts.map((p, i) => `${i ? "L" : "M"}${p[0].toFixed(1)},${p[1].toFixed(1)}`).join(" ");
  return (
    <svg width={w} height={h} viewBox={`0 0 ${w} ${h}`} className={cx("shrink-0 overflow-visible", className)} aria-hidden>
      <path d={`${d} L${w},${h} L0,${h} Z`} fill="var(--color-coral)" opacity="0.1" />
      <path d={d} fill="none" stroke="var(--color-coral)" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
      <circle cx={pts.at(-1)![0]} cy={pts.at(-1)![1]} r="2.5" fill="var(--color-coral)" stroke="#fff" strokeWidth="1.5" />
    </svg>
  );
}

/** Thin progress bar. */
export function Progress({ value, className, tone = "coral" }: { value: number; className?: string; tone?: "coral" | "green" | "amber" }) {
  const c = { coral: "bg-coral", green: "bg-emerald-500", amber: "bg-amber-500" }[tone];
  return (
    <div className={cx("h-1.5 overflow-hidden rounded-full bg-gray-100", className)}>
      <div className={cx("h-full rounded-full transition-[width] duration-500", c)} style={{ width: `${Math.max(0, Math.min(100, value))}%` }} />
    </div>
  );
}

type BtnVariant = "primary" | "secondary" | "ghost" | "danger";
const BTN: Record<BtnVariant, string> = {
  primary: "bg-linear-to-b from-[#fb8080] to-coral text-white border border-coral-dark/40 shadow-[0_1px_2px_rgba(225,79,79,0.25),inset_0_1px_0_rgba(255,255,255,0.18)] hover:from-coral hover:to-coral-dark",
  secondary: "bg-white text-ink border border-[#dfe2e8] shadow-[0_1px_2px_rgba(16,24,40,0.05)] hover:bg-gray-50 hover:border-[#c9cdd6]",
  ghost: "text-ink hover:bg-gray-100 border border-transparent",
  danger: "bg-white text-red-600 border border-red-200 hover:bg-red-50",
};
export function btnClass(variant: BtnVariant = "secondary", size: "sm" | "md" = "md") {
  return cx(
    "inline-flex items-center justify-center gap-1.5 rounded-[9px] font-medium transition-all active:scale-[0.98] disabled:opacity-50 disabled:pointer-events-none whitespace-nowrap",
    size === "sm" ? "h-8 px-2.5 text-[13px]" : "h-9 px-3.5 text-sm",
    BTN[variant],
  );
}
export function Button({ variant = "secondary", size = "md", className, ...p }: ComponentProps<"button"> & { variant?: BtnVariant; size?: "sm" | "md" }) {
  return <button type="button" {...p} className={cx(btnClass(variant, size), className)} />;
}
export function LinkButton({ variant = "secondary", size = "md", className, ...p }: ComponentProps<typeof Link> & { variant?: BtnVariant; size?: "sm" | "md" }) {
  return <Link {...p} className={cx(btnClass(variant, size), className)} />;
}

export function PageHeader({ title, sub, action, back }: { title: ReactNode; sub?: ReactNode; action?: ReactNode; back?: { href: string; label: string } }) {
  return (
    <div className="mb-6">
      {back && (
        <Link href={back.href} className="mb-2 inline-flex items-center gap-0.5 rounded-md text-xs font-medium text-muted hover:text-ink">
          <ChevronLeft className="h-3.5 w-3.5" />{back.label}
        </Link>
      )}
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="min-w-0">
          <h1 className="text-[22px] font-semibold leading-tight tracking-[-0.02em]">{title}</h1>
          {sub && <div className="mt-1 text-[13px] text-muted">{sub}</div>}
        </div>
        {action && <div className="flex flex-wrap items-center gap-2">{action}</div>}
      </div>
    </div>
  );
}

export function Empty({ text, action, icon: Icon = Inbox }: { text: string; action?: ReactNode; icon?: LucideIcon }) {
  return (
    <div className="flex flex-col items-center gap-3 px-4 py-12 text-center text-muted">
      <span className="flex h-12 w-12 items-center justify-center rounded-2xl bg-gray-50 ring-1 ring-inset ring-line"><Icon className="h-5 w-5 text-gray-400" /></span>
      <p>{text}</p>
      {action}
    </div>
  );
}

export function Field({ label, children, hint, required, className }: { label: string; children: ReactNode; hint?: string; required?: boolean; className?: string }) {
  return (
    <label className={cx("block", className)}>
      <span className="mb-1 block text-[13px] font-medium text-ink">
        {label}
        {required && <span className="text-coral"> *</span>}
      </span>
      {children}
      {hint && <span className="mt-1 block text-xs text-muted">{hint}</span>}
    </label>
  );
}

export function Money({ value, profit, className }: { value: number | string | null | undefined; profit?: boolean; className?: string }) {
  const n = Number(value ?? 0);
  return (
    <span className={cx("tabular", profit && n > 0 && "text-emerald-700", profit && n < 0 && "text-red-600", className)}>
      {value === null || value === undefined ? "—" : inr(n)}
    </span>
  );
}

export function LossDot({ show }: { show: boolean }) {
  if (!show) return null;
  return <span title="Loss-making" className="inline-block h-2 w-2 shrink-0 rounded-full bg-red-500" />;
}

export const SERVICE_ICON = { flight: Plane, hotel: BedDouble, visa: Stamp, insurance: ShieldCheck, rail: TrainFront, bus: Bus, other: Sparkles } as const;
export function ServiceIcon({ service, className = "h-4 w-4" }: { service: string; className?: string }) {
  const I = SERVICE_ICON[service as keyof typeof SERVICE_ICON] ?? Sparkles;
  return <I className={className} aria-label={service} />;
}

export function Stat({ label, value, sub, tone }: { label: string; value: ReactNode; sub?: ReactNode; tone?: "green" | "red" }) {
  return (
    <div className="animate-fade-up rounded-[14px] border border-line bg-white p-4 shadow-soft">
      <div className="text-[13px] font-medium text-muted">{label}</div>
      <div className={cx("mt-1 text-xl font-semibold tracking-[-0.015em] tabular", tone === "green" && "text-emerald-700", tone === "red" && "text-red-600")}>{value}</div>
      {sub && <div className="mt-0.5 text-xs text-muted">{sub}</div>}
    </div>
  );
}

/** Link-based tabs (state in the URL so tabs are shareable and need no JS) */
export function Tabs({ tabs, active, base }: { tabs: { key: string; label: ReactNode }[]; active: string; base: string }) {
  return (
    <nav className="no-print -mx-4 mb-5 flex gap-1 overflow-x-auto border-b border-line px-4 md:mx-0 md:px-0">
      {tabs.map((t) => (
        <Link
          key={t.key}
          href={`${base}${base.includes("?") ? "&" : "?"}tab=${t.key}`}
          scroll={false}
          className={cx(
            "-mb-px whitespace-nowrap border-b-2 px-3 py-2.5 text-sm font-medium transition-colors",
            active === t.key ? "border-coral text-ink" : "border-transparent text-muted hover:border-gray-300 hover:text-ink",
          )}
        >
          {t.label}
        </Link>
      ))}
    </nav>
  );
}

export function Chips({ items, param, current, base, allLabel = "All" }: { items: { value: string; label: string }[]; param: string; current?: string; base: Record<string, string | undefined>; allLabel?: string }) {
  const href = (v?: string) => {
    const q = new URLSearchParams();
    Object.entries(base).forEach(([k, val]) => val && k !== param && k !== "page" && q.set(k, val));
    if (v) q.set(param, v);
    const s = q.toString();
    return s ? `?${s}` : "?";
  };
  return (
    <div className="flex flex-wrap gap-1.5">
      {[{ value: "", label: allLabel }, ...items].map((i) => (
        <Link
          key={i.value}
          href={href(i.value || undefined)}
          scroll={false}
          className={cx(
            "rounded-full border px-3 py-1 text-xs font-medium transition-colors",
            (current ?? "") === i.value ? "border-navy bg-navy text-white shadow-sm" : "border-line bg-white text-muted hover:border-gray-300 hover:text-ink",
          )}
        >
          {i.label}
        </Link>
      ))}
    </div>
  );
}

export function Pager({ page, total, perPage, base }: { page: number; total: number; perPage: number; base: Record<string, string | undefined> }) {
  const pages = Math.max(1, Math.ceil(total / perPage));
  if (pages <= 1) return <div className="px-4 py-3 text-xs text-muted">{total} record{total === 1 ? "" : "s"}</div>;
  const href = (p: number) => {
    const q = new URLSearchParams();
    Object.entries(base).forEach(([k, v]) => v && k !== "page" && q.set(k, v));
    q.set("page", String(p));
    return `?${q}`;
  };
  return (
    <div className="flex items-center justify-between px-4 py-3 text-xs text-muted">
      <span>
        {(page - 1) * perPage + 1}–{Math.min(page * perPage, total)} of {total}
      </span>
      <div className="flex gap-1">
        {page > 1 && <Link className={btnClass("secondary", "sm")} href={href(page - 1)}>Previous</Link>}
        {page < pages && <Link className={btnClass("secondary", "sm")} href={href(page + 1)}>Next</Link>}
      </div>
    </div>
  );
}

/** Plain table with sticky header. Rows become cards on phones (cells need data-label). */
export function Table({ head, children, foot, className }: { head: ReactNode[]; children: ReactNode; foot?: ReactNode; className?: string }) {
  return (
    <div className={cx("overflow-x-auto p-2 md:p-0", className)}>
      <table className="rtable w-full text-left text-sm">
        <thead className="sticky top-0 z-10 bg-[#fafbfc] text-[11px] uppercase tracking-[0.04em] text-gray-500">
          <tr>
            {head.map((h, i) => (
              <th key={i} className="whitespace-nowrap border-b border-line px-4 py-2.5 font-semibold">{h}</th>
            ))}
          </tr>
        </thead>
        <tbody className="[&_tr]:transition-colors [&_tr:hover]:bg-[#fafbfc] [&_td]:border-b [&_td]:border-line [&_td]:px-4 [&_td]:py-3 [&_tr:last-child_td]:border-b-0">{children}</tbody>
        {foot && <tfoot className="bg-gray-50 font-medium [&_td]:border-t [&_td]:border-line [&_td]:px-4 [&_td]:py-2.5">{foot}</tfoot>}
      </table>
    </div>
  );
}

export function KV({ items, cols = 2 }: { items: [string, ReactNode][]; cols?: 2 | 3 | 4 }) {
  const shown = items.filter(([, v]) => v !== null && v !== undefined && v !== "" && v !== false);
  if (!shown.length) return <p className="text-muted">Nothing added yet.</p>;
  return (
    <dl className={cx("grid gap-x-6 gap-y-3", cols === 2 && "sm:grid-cols-2", cols === 3 && "sm:grid-cols-3", cols === 4 && "sm:grid-cols-2 lg:grid-cols-4")}>
      {shown.map(([k, v]) => (
        <div key={k} className="min-w-0">
          <dt className="text-xs text-muted">{k}</dt>
          <dd className="mt-0.5 break-words">{v}</dd>
        </div>
      ))}
    </dl>
  );
}
