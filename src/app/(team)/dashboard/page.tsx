import Link from "next/link";
import {
  IndianRupee, TrendingUp, Wallet, Briefcase, PlaneTakeoff, ListChecks, CalendarClock, Users2, Activity, Layers, ArrowRight,
  AlertCircle, Clock, PieChart, Stamp, Ticket, Hotel,
} from "lucide-react";
import { requireTeam } from "@/lib/auth";
import { createClient } from "@/lib/supabase/server";
import { Avatar, Badge, Card, Kpi, Money, Progress, ServiceIcon, StatusBadge, cx } from "@/components/ui";
import { TaskList } from "@/components/task-list";
import { dueBucket, type TaskRow } from "@/lib/tasks";
import { DateRange } from "@/components/date-range";
import { TrendChart } from "@/components/charts";
import { ActivityList } from "@/components/activity";
import { NewButton } from "@/components/list-tools";
import { TicketUploadButton } from "@/components/ticket-upload";
import { CASE_STATUSES, SERVICE_LABEL, SERVICES, STATUS_LABEL, VISA_STATUS_TONE } from "@/lib/constants";
import { fdate, inr, inrShort, todayIST } from "@/lib/format";
import { resolveRange, type RangeSP as SP } from "@/lib/range";

export const metadata = { title: "Dashboard" };

const TASK_SEL = "id, title, due_at, priority, status, alert, assigned_to, case_id, assignee:profiles!tasks_assigned_to_fkey(full_name), case:cases(max_id, title), customer_id, customer:customers(full_name)";

type Money = {
  sales: number; cost: number; profit: number; due_from_clients: number;
  by_service: { service: string; profit: number; sale: number }[];
  by_staff: { id: string; name: string; cases: number; tasks_done: number; profit: number }[];
};

function prevRange(from: string, to: string) {
  const d = (s: string) => new Date(s + "T00:00:00Z").getTime();
  const len = Math.round((d(to) - d(from)) / 86400e3) + 1;
  const pTo = new Date(d(from) - 86400e3);
  const pFrom = new Date(pTo.getTime() - (len - 1) * 86400e3);
  return { from: pFrom.toISOString().slice(0, 10), to: pTo.toISOString().slice(0, 10) };
}
const pct = (cur: number, prev: number) => (prev ? ((cur - prev) / Math.abs(prev)) * 100 : null);

function greeting() {
  const h = Number(new Intl.DateTimeFormat("en-IN", { hour: "numeric", hour12: false, timeZone: "Asia/Kolkata" }).format(new Date()));
  return h < 12 ? "Good morning" : h < 17 ? "Good afternoon" : "Good evening";
}

export default async function Dashboard({ searchParams }: { searchParams: Promise<SP> }) {
  const me = await requireTeam();
  const sp = await searchParams;
  const range = resolveRange(sp);
  const prev = prevRange(range.from, range.to);
  const sb = await createClient();
  const boss = me.role === "boss";
  const profitOk = me.can_see_profit;

  const weekAhead = new Date(Date.now() + 8 * 86400e3).toISOString();
  const tasksQ = sb.from("tasks").select(TASK_SEL).neq("status", "done").lte("due_at", weekAhead).order("due_at");
  const none = Promise.resolve({ data: null });
  const [{ data: tasks }, { data: travel }, money, moneyPrev, trend, { data: pipe }, activity, { data: other }, imports] = await Promise.all([
    boss ? tasksQ : tasksQ.eq("assigned_to", me.id),
    // one row per departing flight leg, rail or bus journey (outbound and return each count; hotels and visas don't)
    sb.rpc("departures", { p_from: todayIST(), p_to: todayIST(7) }),
    profitOk ? sb.rpc("dashboard_money", { p_from: range.from, p_to: range.to }) : none,
    profitOk ? sb.rpc("dashboard_money", { p_from: prev.from, p_to: prev.to }) : none,
    profitOk ? sb.rpc("dashboard_trend", { p_months: 6 }) : none,
    sb.rpc("dashboard_pipeline"),
    boss ? sb.from("activity_log").select("*").order("created_at", { ascending: false }).limit(7) : none,
    sb.rpc("service_dates", { p_from: todayIST(), p_to: todayIST(7) }),
    sb.from("ticket_imports").select("id, status, file_name, created_at, channel", { count: "exact" }).in("status", ["received", "processing", "needs_review", "failed"]).order("created_at").limit(5),
  ]);
  const m = money.data as Money | null;
  const mp = moneyPrev.data as Money | null;
  const tr = ((trend.data ?? []) as { month: string; sales: number; profit: number; cases: number }[]).map((r) => ({ ...r, sales: Number(r.sales), profit: Number(r.profit), cases: Number(r.cases) }));
  const t = (tasks ?? []) as unknown as TaskRow[];
  type Dep = { case_id: string; max_id: string; customer: string; line_id: string; service: string; dep_date: string; dep_time: string | null; from_code: string | null; to_code: string | null; carrier: string | null; leg: number; legs: number };
  const trips = ((travel ?? []) as Dep[]).sort((a, b) => (a.dep_date + (a.dep_time ?? "")).localeCompare(b.dep_date + (b.dep_time ?? "")));
  const otherDates = (other ?? []) as { case_id: string; max_id: string; customer: string; line_id: string; service: string; kind: string; on_date: string; label: string | null }[];
  const pendingImports = (imports.data ?? []) as { id: string; status: string; file_name: string; created_at: string; channel: string }[];
  const pendingImportCount = imports.count ?? pendingImports.length;
  const pipeline = (pipe ?? []) as { status: string; cases: number; sale: number; due: number }[];
  const openCases = pipeline.filter((p) => !["completed", "cancelled"].includes(p.status)).reduce((a, p) => a + Number(p.cases), 0);
  const overdue = t.filter((x) => dueBucket(x) === "overdue").length;
  const today = t.filter((x) => dueBucket(x) === "today").length;
  const first = me.full_name.split(" ")[0];
  const dateLine = new Intl.DateTimeFormat("en-IN", { weekday: "long", day: "numeric", month: "long", timeZone: "Asia/Kolkata" }).format(new Date());

  return (
    <>
      {/* hero */}
      <section className="animate-fade-up relative mb-6 overflow-hidden rounded-[18px] bg-navy px-6 py-6 text-white shadow-lift md:px-8 md:py-7">
        <div className="bg-dots absolute inset-0 opacity-60" />
        <div className="absolute -right-24 -top-24 h-72 w-72 rounded-full bg-coral/35 blur-3xl" />
        <div className="absolute -bottom-32 right-40 h-64 w-64 rounded-full bg-sky-500/20 blur-3xl" />
        <svg className="absolute right-8 top-1/2 hidden h-28 w-72 -translate-y-1/2 text-white/15 lg:block" viewBox="0 0 280 110" fill="none" aria-hidden>
          <path d="M6 96C70 92 96 30 160 34s84 40 114-22" stroke="currentColor" strokeWidth="2" strokeDasharray="5 7" strokeLinecap="round" />
          <circle cx="6" cy="96" r="5" fill="currentColor" />
          <path d="m262 6 14 4-9 11-2-6-6-2 3-7Z" fill="#fff" fillOpacity=".55" />
        </svg>
        <div className="relative flex flex-wrap items-end justify-between gap-5">
          <div className="min-w-0">
            <div className="text-[13px] font-medium text-slate-400">{dateLine}</div>
            <h1 className="mt-1 text-[26px] font-semibold leading-tight tracking-[-0.025em] md:text-[30px]">{greeting()}, {first}</h1>
            <div className="mt-3 flex flex-wrap gap-2 text-[13px]">
              <HeroChip href="/tasks?due=overdue" icon={AlertCircle} hot={overdue > 0}>{overdue} overdue</HeroChip>
              <HeroChip href="/tasks?due=today" icon={Clock}>{today} due today</HeroChip>
              <HeroChip href="#departures" icon={PlaneTakeoff}>{trips.length} departure{trips.length === 1 ? "" : "s"} this week</HeroChip>
              <HeroChip href="/cases?status=open" icon={Briefcase}>{openCases} open cases</HeroChip>
              {pendingImportCount > 0 && <HeroChip href="/imports" icon={Ticket} hot>{pendingImportCount} ticket{pendingImportCount === 1 ? "" : "s"} to review</HeroChip>}
            </div>
          </div>
          <div className="flex flex-wrap gap-2">
            <TicketUploadButton />

            <NewButton kind="task" label="Task" variant="secondary" className="!border-white/15 !bg-white/10 !text-white !shadow-none hover:!bg-white/20" />
            <NewButton kind="case" label="New case" />
          </div>
        </div>
      </section>

      {profitOk && m && (
        <>
          <div className="mb-3 flex flex-wrap items-center justify-between gap-3">
            <div>
              <h2 className="text-[15px] font-semibold tracking-[-0.01em]">Business overview</h2>
              <p className="text-xs text-muted">{range.label} · compared with the previous period</p>
            </div>
            <DateRange />
          </div>
          <div className="mb-6 grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-4">
            <Kpi label="Sales" value={inr(m.sales)} icon={IndianRupee} tone="blue" delta={mp ? pct(m.sales, mp.sales) : null} sub="vs previous" spark={tr.map((x) => x.sales)} />
            <Kpi label="Profit (incl. commission)" value={<span className={m.profit < 0 ? "text-red-600" : ""}>{inr(m.profit)}</span>} icon={TrendingUp} tone="green"
              delta={mp ? pct(m.profit, mp.profit) : null} sub={m.sales ? `${Math.round((m.profit / m.sales) * 1000) / 10}% margin` : "vs previous"} spark={tr.map((x) => x.profit)} />
            <Kpi label="Due from clients" value={inr(m.due_from_clients)} icon={Wallet} tone="amber" sub="All open balances" />
            <Kpi label="Supplier cost" value={inr(m.cost)} icon={Layers} tone="violet" delta={mp ? pct(m.cost, mp.cost) : null} deltaGood="down" sub="vs previous" />
          </div>
        </>
      )}

      <div className="grid gap-5 xl:grid-cols-3">
        {/* left column (2/3) */}
        <div className="min-w-0 space-y-5 xl:col-span-2">
          {profitOk && tr.length > 0 && (
            <Card title="Performance" sub="Monthly trend" icon={TrendingUp}>
              <TrendChart data={tr} />
            </Card>
          )}
          {pendingImports.length > 0 && (
            <Card title="Tickets to review" sub={`${pendingImportCount} waiting · nothing is added to a case until someone confirms`} icon={Ticket} pad={false}
              action={<Link href="/imports" className="text-xs link">All imports</Link>}>
              <ul className="divide-y divide-line">
                {pendingImports.map((i) => (
                  <li key={i.id}>
                    <Link href={`/imports/${i.id}`} className="flex items-center gap-3 px-4 py-2.5 text-sm hover:bg-[#fafbfc]">
                      <span className="min-w-0 flex-1 truncate">{i.file_name}{i.channel === "portal" && <span className="ml-1 text-xs text-muted">· from the client</span>}</span>
                      <StatusBadge status={i.status} />
                    </Link>
                  </li>
                ))}
              </ul>
            </Card>
          )}
          {boss ? <TasksByStaff tasks={t} /> : <MyDay tasks={t} />}
          {boss ? <PaymentsDue /> : <MyOpenCases userId={me.id} />}
          {boss && m && <StaffBoard rows={m.by_staff} />}
        </div>

        {/* right column (1/3) */}
        <div className="min-w-0 space-y-5">
          <Pipeline rows={pipeline} />
          <VisaTracker />
          <Card title="Departures" sub="Next 7 days" icon={PlaneTakeoff} pad={false} className="scroll-mt-24" >
            <div id="departures" />
            {trips.length === 0 ? <p className="p-4 text-sm text-muted">No one is travelling in the next 7 days.</p> : (
              <ul className="divide-y divide-line">
                {trips.slice(0, 10).map((l) => {
                  const d = new Date(l.dep_date + "T00:00:00");
                  const isToday = l.dep_date === todayIST();
                  return (
                    <li key={`${l.line_id}-${l.leg}`}>
                      <Link href={`/cases/${l.case_id}?tab=bookings`} className="flex items-center gap-3 px-4 py-2.5 transition-colors hover:bg-[#fafbfc]">
                        <span className={cx("flex w-11 shrink-0 flex-col items-center rounded-[10px] py-1 ring-1 ring-inset", isToday ? "bg-coral text-white ring-coral" : "bg-gray-50 ring-line")}>
                          <span className={cx("text-[10px] font-semibold uppercase", isToday ? "text-white/80" : "text-coral-dark")}>{d.toLocaleDateString("en-IN", { month: "short" })}</span>
                          <span className="text-[15px] font-semibold leading-tight">{d.getDate()}</span>
                        </span>
                        <span className="min-w-0 flex-1">
                          <span className="block truncate text-sm font-medium">{l.customer}</span>
                          <span className="flex items-center gap-1.5 truncate text-xs text-muted">
                            <ServiceIcon service={l.service} className="h-3.5 w-3.5 shrink-0" />
                            <span className="truncate">
                              {[l.from_code && l.to_code ? `${l.from_code} → ${l.to_code}` : SERVICE_LABEL[l.service as keyof typeof SERVICE_LABEL], l.dep_time, l.carrier].filter(Boolean).join(" · ")}
                              {l.legs > 1 && ` · leg ${l.leg} of ${l.legs}`}
                            </span>
                          </span>
                        </span>
                        <span className="font-mono text-[11px] font-semibold text-gray-500">{l.max_id}</span>
                      </Link>
                    </li>
                  );
                })}
              </ul>
            )}
            {otherDates.length > 0 && (
              <div className="border-t border-line">
                <div className="px-4 pb-1 pt-2.5 text-[11px] font-semibold uppercase tracking-wide text-muted">Hotel and visa dates (not departures)</div>
                <ul className="divide-y divide-line">
                  {otherDates.slice(0, 6).map((o) => (
                    <li key={`${o.line_id}-${o.kind}`}>
                      <Link href={`/cases/${o.case_id}?tab=bookings`} className="flex items-center gap-3 px-4 py-2 text-xs hover:bg-[#fafbfc]">
                        {o.service === "hotel" ? <Hotel className="h-3.5 w-3.5 text-muted" /> : <Stamp className="h-3.5 w-3.5 text-muted" />}
                        <span className="w-16 shrink-0 tabular">{fdate(o.on_date)}</span>
                        <span className="min-w-0 flex-1 truncate">{o.kind === "check_in" ? "Check-in" : o.kind === "check_out" ? "Check-out" : "Appointment"}: {o.label} · {o.customer}</span>
                        <span className="font-mono font-semibold text-gray-500">{o.max_id}</span>
                      </Link>
                    </li>
                  ))}
                </ul>
              </div>
            )}
          </Card>
          {profitOk && m && <ProfitByService rows={m.by_service} />}
          {boss && activity.data && (
            <Card title="Recent activity" icon={Activity}>
              <ActivityList items={activity.data} />
            </Card>
          )}
        </div>
      </div>
    </>
  );
}

function HeroChip({ href, icon: I, children, hot }: { href: string; icon: typeof Clock; children: React.ReactNode; hot?: boolean }) {
  return (
    <Link href={href} className={cx("inline-flex items-center gap-1.5 rounded-full px-3 py-1 font-medium ring-1 ring-inset backdrop-blur transition-colors",
      hot ? "bg-coral/90 text-white ring-coral hover:bg-coral" : "bg-white/[0.07] text-slate-200 ring-white/10 hover:bg-white/[0.14]")}>
      <I className="h-3.5 w-3.5" />{children}
    </Link>
  );
}

function Pipeline({ rows }: { rows: { status: string; cases: number; sale: number; due: number }[] }) {
  const flow = CASE_STATUSES.filter((s) => s !== "cancelled");
  const data = flow.map((s) => {
    const r = rows.find((x) => x.status === s);
    return { s, n: Number(r?.cases ?? 0), sale: Number(r?.sale ?? 0) };
  });
  const max = Math.max(1, ...data.map((d) => d.n));
  const cancelled = Number(rows.find((x) => x.status === "cancelled")?.cases ?? 0);
  return (
    <Card title="Case pipeline" sub="All cases by stage" icon={PieChart} action={<Link href="/cases?view=board" className="inline-flex items-center gap-1 text-xs link">Board <ArrowRight className="h-3 w-3" /></Link>}>
      <div className="space-y-3">
        {data.map((d) => (
          <Link key={d.s} href={`/cases?status=${d.s}`} className="group block" title={`${STATUS_LABEL[d.s]}: ${d.n} cases, ${inr(d.sale)} sale value`}>
            <div className="mb-1 flex items-center justify-between text-[13px]">
              <StatusBadge status={d.s} />
              <span className="tabular text-muted"><b className="font-semibold text-ink">{d.n}</b>{d.sale > 0 && <> · {inrShort(d.sale)}</>}</span>
            </div>
            <div className="h-2 overflow-hidden rounded-full bg-gray-100">
              <div className="h-full rounded-full bg-navy/80 transition-all group-hover:bg-coral" style={{ width: `${(d.n / max) * 100}%`, minWidth: d.n ? 6 : 0 }} />
            </div>
          </Link>
        ))}
      </div>
      {cancelled > 0 && <p className="mt-3 text-xs text-muted">{cancelled} cancelled case{cancelled === 1 ? "" : "s"} not shown.</p>}
    </Card>
  );
}

function MyDay({ tasks }: { tasks: TaskRow[] }) {
  const groups = [
    { key: "overdue", label: "Overdue", cls: "text-red-600 bg-red-50/60" },
    { key: "today", label: "Today", cls: "bg-gray-50" },
    { key: "week", label: "Next 7 days", cls: "bg-gray-50" },
  ] as const;
  return (
    <Card title="My day" sub="Tasks and reminders" icon={ListChecks} action={<Link href="/tasks" className="text-xs link">All tasks</Link>} pad={false}>
      {tasks.length === 0 && <p className="p-4 text-sm text-muted">Nothing due. Enjoy the calm.</p>}
      {groups.map((g) => {
        const list = tasks.filter((x) => dueBucket(x) === g.key);
        if (!list.length) return null;
        return (
          <div key={g.key}>
            <div className={cx("px-4 py-1.5 text-[11px] font-semibold uppercase tracking-[0.05em]", g.cls)}>{g.label} · {list.length}</div>
            <TaskList tasks={list} showAssignee={false} />
          </div>
        );
      })}
    </Card>
  );
}

function TasksByStaff({ tasks }: { tasks: TaskRow[] }) {
  const urgent = tasks.filter((x) => ["overdue", "today"].includes(dueBucket(x)));
  const byStaff = new Map<string, TaskRow[]>();
  urgent.forEach((x) => { const k = x.assignee?.full_name ?? "Unassigned"; byStaff.set(k, [...(byStaff.get(k) ?? []), x]); });
  return (
    <Card title="Overdue and due today" sub="Across the team" icon={ListChecks} action={<Link href="/tasks" className="text-xs link">All tasks</Link>} pad={false}>
      {urgent.length === 0 && <p className="p-4 text-sm text-muted">Nothing overdue or due today. 🎉</p>}
      {[...byStaff.entries()].map(([name, list]) => {
        const over = list.filter((x) => dueBucket(x) === "overdue").length;
        return (
          <div key={name}>
            <div className="flex items-center justify-between bg-gray-50 px-4 py-1.5 text-xs font-medium">
              <span className="flex items-center gap-2"><Avatar name={name} size="xs" />{name}</span>
              {over > 0 && <span className="rounded-full bg-red-50 px-2 py-0.5 text-[11px] font-semibold text-red-600">{over} overdue</span>}
            </div>
            <TaskList tasks={list} showAssignee={false} />
          </div>
        );
      })}
    </Card>
  );
}

async function PaymentsDue() {
  const sb = await createClient();
  const [{ data: clients }, { data: sups }] = await Promise.all([sb.rpc("report_client_dues"), sb.rpc("report_supplier_dues")]);
  const c = (clients ?? []) as { case_id: string; max_id: string; customer: string; due: number; due_since: string }[];
  const s = ((sups ?? []) as { supplier_id: string; name: string; due: number; oldest_due: string | null }[]).filter((x) => x.due > 0);
  const cTot = c.reduce((a, r) => a + Number(r.due), 0);
  const sTot = s.reduce((a, r) => a + Number(r.due), 0);
  return (
    <Card title="Payments due" sub="Money to collect and to pay" icon={CalendarClock} action={<Link href="/reports?r=client_dues" className="text-xs link">Report</Link>} pad={false}>
      <div className="grid divide-line sm:grid-cols-2 sm:divide-x">
        <div>
          <div className="flex items-baseline justify-between bg-emerald-50/50 px-4 py-2">
            <span className="text-[11px] font-semibold uppercase tracking-[0.05em] text-emerald-700">To collect</span>
            <span className="text-sm font-semibold tabular">{inr(cTot)}</span>
          </div>
          {c.length === 0 && <p className="px-4 py-3 text-sm text-muted">Nothing due.</p>}
          {c.slice(0, 6).map((r) => (
            <Link key={r.case_id} href={`/cases/${r.case_id}?tab=payments`} className="flex items-center justify-between gap-2 border-b border-line px-4 py-2.5 text-sm last:border-0 hover:bg-[#fafbfc]">
              <span className="flex min-w-0 items-center gap-2"><Avatar name={r.customer} size="sm" /><span className="min-w-0"><span className="block truncate">{r.customer}</span><span className="block font-mono text-[11px] text-muted">{r.max_id}</span></span></span>
              <Money value={r.due} className="font-medium" />
            </Link>
          ))}
        </div>
        <div>
          <div className="flex items-baseline justify-between bg-amber-50/50 px-4 py-2">
            <span className="text-[11px] font-semibold uppercase tracking-[0.05em] text-amber-700">To pay suppliers</span>
            <span className="text-sm font-semibold tabular">{inr(sTot)}</span>
          </div>
          {s.length === 0 && <p className="px-4 py-3 text-sm text-muted">Nothing due.</p>}
          {s.slice(0, 6).map((r) => (
            <Link key={r.supplier_id} href={`/suppliers/${r.supplier_id}`} className="flex items-center justify-between gap-2 border-b border-line px-4 py-2.5 text-sm last:border-0 hover:bg-[#fafbfc]">
              <span className="min-w-0"><span className="block truncate">{r.name}</span>
                {r.oldest_due && <span className={cx("block text-[11px]", r.oldest_due <= todayIST() ? "font-medium text-red-600" : "text-muted")}>{r.oldest_due <= todayIST() ? "Overdue since " : "Due "}{fdate(r.oldest_due)}</span>}
              </span>
              <Money value={r.due} className="font-medium" />
            </Link>
          ))}
        </div>
      </div>
    </Card>
  );
}

async function MyOpenCases({ userId }: { userId: string }) {
  const sb = await createClient();
  const { data } = await sb.from("cases").select("id, max_id, title, status, travel_start, customer:customers!cases_customer_id_fkey(full_name)").eq("assigned_to", userId).not("status", "in", "(completed,cancelled)").order("travel_start", { nullsFirst: false }).limit(10);
  const rows = (data ?? []) as unknown as { id: string; max_id: string; title: string; status: string; travel_start: string | null; customer: { full_name: string } | null }[];
  return (
    <Card title="My open cases" icon={Briefcase} action={<Link href={`/cases?staff=${userId}&status=open`} className="text-xs link">All</Link>} pad={false}>
      {rows.length === 0 && <p className="p-4 text-sm text-muted">No open cases.</p>}
      {rows.map((c) => (
        <Link key={c.id} href={`/cases/${c.id}`} className="flex items-center gap-3 border-b border-line px-4 py-2.5 last:border-0 hover:bg-[#fafbfc]">
          <Avatar name={c.customer?.full_name} size="md" />
          <span className="min-w-0 flex-1">
            <span className="block truncate text-sm font-medium">{c.title}</span>
            <span className="block text-xs text-muted"><span className="font-mono font-semibold">{c.max_id}</span> · {c.customer?.full_name}{c.travel_start && ` · ${fdate(c.travel_start)}`}</span>
          </span>
          <StatusBadge status={c.status} />
        </Link>
      ))}
    </Card>
  );
}

function StaffBoard({ rows }: { rows: Money["by_staff"] }) {
  const max = Math.max(1, ...rows.map((r) => Math.abs(Number(r.profit))));
  return (
    <Card title="Team performance" sub="Cases, tasks and booking profit (before case expenses) in this period" icon={Users2} pad={false}>
      <ul className="divide-y divide-line">
        {[...rows].sort((a, b) => Number(b.profit) - Number(a.profit)).map((s, i) => (
          <li key={s.id} className="grid grid-cols-[auto_1fr_auto] items-center gap-3 px-4 py-3 sm:grid-cols-[auto_1fr_90px_90px_1.2fr]">
            <span className="relative">
              <Avatar name={s.name} size="lg" />
              {i === 0 && Number(s.profit) > 0 && <span className="absolute -right-1 -top-1 text-sm" title="Top performer">🏆</span>}
            </span>
            <span className="min-w-0">
              <span className="block truncate text-sm font-medium">{s.name}</span>
              <span className="block text-xs text-muted sm:hidden">{s.cases} cases · {s.tasks_done} tasks done</span>
            </span>
            <span className="hidden text-center sm:block"><span className="block text-sm font-semibold tabular">{s.cases}</span><span className="text-[11px] text-muted">cases</span></span>
            <span className="hidden text-center sm:block"><span className="block text-sm font-semibold tabular">{s.tasks_done}</span><span className="text-[11px] text-muted">tasks done</span></span>
            <span className="min-w-0">
              <span className="mb-1 flex justify-end"><Money value={s.profit} profit className="text-sm font-semibold" /></span>
              <Progress value={(Math.abs(Number(s.profit)) / max) * 100} tone={Number(s.profit) < 0 ? "amber" : "green"} className="hidden sm:block" />
            </span>
          </li>
        ))}
      </ul>
    </Card>
  );
}

/** Single-series horizontal bars: magnitude per service, one hue, direct labels, no legend. */
function ProfitByService({ rows }: { rows: { service: string; profit: number; sale: number }[] }) {
  const data = SERVICES.filter((s) => s !== "other" || rows.some((r) => r.service === "other")).map((s) => ({ s, p: Number(rows.find((r) => r.service === s)?.profit ?? 0), sale: Number(rows.find((r) => r.service === s)?.sale ?? 0) }));
  const max = Math.max(1, ...data.map((d) => Math.abs(d.p)));
  return (
    <Card title="Profit by service" sub="This period, before case expenses" icon={Layers}>
      <div className="space-y-3" role="table" aria-label="Profit by service">
        {data.map((d) => (
          <div key={d.s} role="row" className="group" title={`${SERVICE_LABEL[d.s]}: profit ${inr(d.p)} on sales of ${inr(d.sale)}`}>
            <div className="mb-1 flex items-center justify-between text-[13px]">
              <span role="rowheader" className="flex items-center gap-2 font-medium">
                <span className="flex h-6 w-6 items-center justify-center rounded-md bg-gray-100 text-gray-600"><ServiceIcon service={d.s} className="h-3.5 w-3.5" /></span>
                {SERVICE_LABEL[d.s]}
              </span>
              <span role="cell" className={cx("tabular font-semibold", d.p < 0 && "text-red-600")}>{inr(d.p)}</span>
            </div>
            <div className="h-2 overflow-hidden rounded-full bg-gray-100">
              <div className={cx("h-full rounded-full transition-all", d.p < 0 ? "bg-red-400" : "bg-coral group-hover:bg-coral-dark")} style={{ width: `${(Math.abs(d.p) / max) * 100}%`, minWidth: d.p ? 4 : 0 }} />
            </div>
          </div>
        ))}
      </div>
    </Card>
  );
}

/** Visa applications still in progress, soonest appointment first. */
async function VisaTracker() {
  const sb = await createClient();
  const { data } = await sb.from("booking_lines")
    .select("id, details, case:cases!inner(id, max_id, status, customer:customers!cases_customer_id_fkey(full_name))")
    .eq("service", "visa").neq("status", "cancelled").neq("case.status", "cancelled").order("service_date", { nullsFirst: false }).limit(60);
  const done = ["Approved", "Rejected", "Passport collected"];
  const rows = ((data ?? []) as unknown as { id: string; details: Record<string, string>; case: { id: string; max_id: string; customer: { full_name: string } | null } }[])
    .filter((r) => !done.includes(r.details?.application_status));
  if (!rows.length) return null;
  return (
    <Card title="Visa applications" sub={`${rows.length} in progress`} icon={Stamp} pad={false} action={<Link href="/cases?service=visa&status=open" className="text-xs link">All</Link>}>
      <ul className="divide-y divide-line">
        {rows.slice(0, 6).map((r) => {
          const st = r.details?.application_status || "Documents pending";
          const appt = r.details?.appointment_date;
          const soon = appt && appt >= todayIST() && appt <= todayIST(2);
          return (
            <li key={r.id}>
              <Link href={`/cases/${r.case.id}?tab=bookings`} className="flex items-center gap-3 px-4 py-2.5 transition-colors hover:bg-[#fafbfc]">
                <Avatar name={r.case.customer?.full_name} size="md" />
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-sm font-medium">{r.case.customer?.full_name}</span>
                  <span className="block truncate text-xs text-muted">{r.details?.country}</span>
                  <span className={cx("block truncate text-xs", soon ? "font-medium text-coral-dark" : "text-muted")}>
                    {appt ? `Appt ${fdate(appt)}${r.details?.appointment_time ? " " + r.details.appointment_time : ""}` : r.details?.expected_by ? `Decision by ${fdate(r.details.expected_by)}` : r.case.max_id}
                  </span>
                </span>
                <Badge dot tone={VISA_STATUS_TONE[st] ?? "grey"}>{st}</Badge>
              </Link>
            </li>
          );
        })}
      </ul>
    </Card>
  );
}
