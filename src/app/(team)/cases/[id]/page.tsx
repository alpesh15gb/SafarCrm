import { notFound } from "next/navigation";
import Link from "next/link";
import { requireTeam } from "@/lib/auth";
import { createClient } from "@/lib/supabase/server";
import { IndianRupee, Layers, TrendingUp, Wallet, Receipt } from "lucide-react";
import { Avatar, Card, IconChip, Money, PageHeader, Tabs, cx } from "@/components/ui";
import type { PaxSource } from "@/lib/iata";

type PaxRow = PaxSource & { id: string; full_name: string; dob: string | null; passport_expiry: string | null; mobile: string };
import { MaxId } from "@/components/client";
import { fdate, prettyPhone, inr } from "@/lib/format";
import { CaseHeaderControls } from "./header-controls";
import { FinishLine, NextStepBar, type FinishItem } from "./next-step";
import { StageSteps } from "./stage-steps";
import { CaseDocs, type InvoiceRow } from "./case-docs";
import type { WorkSummary } from "../board";
import { OverviewTab } from "./overview";
import { BookingsTab, type Line } from "./bookings";
import { PaymentsTab } from "./payments";
import { FilesTab, type FileRow } from "./files";
import { TaskList, type TaskRow } from "@/components/task-list";
import { ActivityList } from "@/components/activity";

export async function generateMetadata({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const sb = await createClient();
  const { data } = await sb.from("cases").select("max_id").eq("id", id).maybeSingle();
  return { title: data?.max_id ?? "Case" };
}

const TABS = [
  { key: "overview", label: "Overview" },
  { key: "bookings", label: "Bookings" },
  { key: "payments", label: "Payments" },
  { key: "files", label: "Files" },
  { key: "tasks", label: "Tasks" },
  { key: "activity", label: "Activity" },
];

export default async function CasePage({ params, searchParams }: { params: Promise<{ id: string }>; searchParams: Promise<{ tab?: string }> }) {
  const me = await requireTeam();
  const { id } = await params;
  const { tab = "overview" } = await searchParams;
  const sb = await createClient();

  const { data: c } = await sb
    .from("cases")
    .select("*, customer:customers!cases_customer_id_fkey(id, full_name, mobile, whatsapp, email, family_id, code, customer_type), staff:profiles!cases_assigned_to_fkey(id, full_name), creator:profiles!cases_created_by_fkey(full_name)")
    .eq("id", id)
    .maybeSingle();
  if (!c) notFound();

  const [{ data: money }, { data: travellers }, { data: lines }, { data: lineMoney }, { data: openTasks }, { data: workData }, { data: finishData }] = await Promise.all([
    sb.from("v_case_money").select("*").eq("case_id", id).single(),
    sb.from("case_travellers").select("customer:customers(id, full_name, title, first_name, middle_name, last_name, passport_surname, passport_given_name, gender, dob, passport_expiry, mobile)").eq("case_id", id),
    sb.from("booking_lines").select("*, supplier:suppliers(id, name)").eq("case_id", id).order("sort").order("service_date", { nullsFirst: false }).order("created_at"),
    sb.from("v_line_money").select("line_id, billed, sale, cost, profit, margin").eq("case_id", id),
    sb.from("tasks").select("id", { count: "exact", head: true }).eq("case_id", id).neq("status", "done").then((r) => ({ data: r.count })),
    sb.rpc("case_work_summary", { p_cases: [id] }),
    sb.rpc("case_finish_items", { p_case: id }),
  ]);
  const trav = (travellers ?? []).map((t) => t.customer as unknown as PaxRow);
  const customer = c.customer as { id: string; full_name: string; mobile: string; whatsapp: string | null; email: string | null; family_id: string | null; code: string; customer_type: string };
  const lm = new Map((lineMoney ?? []).map((m) => [m.line_id, m]));
  // supplier cost and commission never reach the browser of staff who may not see profit
  const hideCost = (l: Record<string, unknown>) => (me.can_see_profit ? l : { ...l, supplier_cost: null, commission_type: "amount", commission_value: null, commission_amount: null, refund_from_supplier: null, cancellation_charge: null });
  const linesWithMoney = (lines ?? []).map((l) => ({ ...hideCost(l), money: lm.get(l.id) })) as Line[];

  const profit = money?.profit as number | null;
  const tabs = TABS.map((t) => ({
    ...t,
    label: t.key === "bookings" ? `Bookings (${lines?.length ?? 0})` : t.key === "tasks" && openTasks ? `Tasks (${openTasks})` : t.label,
  }));

  return (
    <>
      <PageHeader
        back={{ href: "/cases", label: "Cases" }}
        title={<span className="flex flex-wrap items-center gap-2"><MaxId id={c.max_id} className="!text-xl" /> <span className="font-normal text-muted">·</span> <span>{c.title}</span></span>}
        sub={
          <span className="flex flex-wrap items-center gap-x-1.5 gap-y-1">
            <Avatar name={customer.full_name} size="xs" />
            <Link href={`/customers/${customer.id}`} className="link">{customer.full_name}</Link> · {prettyPhone(customer.mobile)}
            {c.travel_start && <> · {fdate(c.travel_start)}{c.travel_end && ` → ${fdate(c.travel_end)}`}</>}
            {c.destination && <> · {c.destination}</>}
          </span>
        }
        action={<CaseHeaderControls kase={{ id: c.id, status: c.status, assigned_to: c.assigned_to, max_id: c.max_id, cancel_reason: c.cancel_reason, work_state: c.work_state, waiting_reason: c.waiting_reason, waiting_follow_up_at: c.waiting_follow_up_at }} />}
      />

      <StageSteps status={c.status} />
      <NextStepBar w={((workData ?? []) as WorkSummary[])[0] ?? null} kase={{ id: c.id, max_id: c.max_id, title: c.title }} />
      {!["completed", "cancelled"].includes(c.status) && <FinishLine items={(finishData ?? []) as FinishItem[]} />}
      {(() => {
        // the case dates drive reminders (e.g. the check-in task): flag them when the bookings say otherwise
        const live = (lines ?? []).filter((l) => l.status !== "cancelled" && l.service_date).map((l) => l.service_date as string).sort();
        const first = live[0];
        if (!c.travel_start || !first || first === c.travel_start || c.status === "cancelled") return null;
        return (
          <div role="alert" className="mb-4 rounded-xl border border-amber-200 bg-amber-50 px-4 py-2.5 text-[13px] text-amber-900">
            The case says travel starts <b>{fdate(c.travel_start)}</b>, but the first booking is on <b>{fdate(first)}</b>.
            Update the case dates (Overview → Edit) so reminders and check-in tasks use the right day, and check any open tasks.
          </div>
        );
      })()}

      <div className={cx("mb-5 grid gap-3", me.can_see_profit ? "grid-cols-2 md:grid-cols-4" : "grid-cols-1 sm:grid-cols-3")}>
        <Strip label="Sale" icon={IndianRupee} tone="blue" value={<Money value={money?.sale} />} />
        {me.can_see_profit && <Strip label="Cost" icon={Layers} tone="violet" value={<Money value={money?.supplier_payable} />} />}
        {me.can_see_profit && (
          <Strip
            label="Profit"
            icon={TrendingUp}
            tone={profit !== null && profit < 0 ? "red" : "green"}
            value={<span className="flex items-center gap-2"><Money value={profit} profit />{profit !== null && profit < 0 && <span className="rounded-full bg-red-50 px-2 py-0.5 text-xs text-red-700">Loss</span>}</span>}
            sub={money?.margin != null ? `${money.margin}% margin` : undefined}
          />
        )}
        {!me.can_see_profit && <Strip label="Received" icon={Receipt} tone="green" value={<Money value={money?.received} />} />}
        {Number(money?.due) < 0
          ? <Strip label="Client credit" icon={Wallet} tone="blue" value={<Money value={-Number(money?.due)} className="text-sky-700" />} sub="Paid more than billed: refund or adjust" />
          : <Strip label="Due from client" icon={Wallet} tone="amber" value={<Money value={money?.due} className={Number(money?.due) > 0 ? "text-amber-700" : ""} />} sub={`Billed ${inr(money?.billed ?? 0)}`} />}
      </div>

      <Tabs tabs={tabs} active={tab} base={`/cases/${id}`} />

      {["overview", "bookings", "payments"].includes(tab) && <DocsLoader caseId={id} caseStatus={c.status} lines={linesWithMoney} />}

      {tab === "overview" && (
        <OverviewTab
          kase={c}
          customer={customer}
          travellers={trav}
          lines={linesWithMoney}
        />
      )}
      {tab === "bookings" && <BookingsLoader caseId={id} lines={linesWithMoney} travellers={trav} maxId={c.max_id} customer={customer} trip={{ start: c.travel_start, end: c.travel_end }} />}
      {tab === "payments" && <PaymentsLoader caseId={id} lines={linesWithMoney} money={money} status={c.status} />}
      {tab === "files" && <FilesLoader caseId={id} maxId={c.max_id} customer={customer} travellers={trav.map((t) => ({ id: t.id, full_name: t.full_name }))} lines={linesWithMoney} />}
      {tab === "tasks" && <TasksLoader caseId={id} maxId={c.max_id} title={c.title} />}
      {tab === "activity" && <ActivityLoader caseId={id} />}

      <div className="mt-6 text-xs text-muted">
        Created {fdate(c.created_at)} by {(c.creator as { full_name: string } | null)?.full_name ?? "—"} · Lead source {c.lead_source ?? "—"}
      </div>
    </>
  );
}

function Strip({ label, value, sub, icon, tone }: { label: string; value: React.ReactNode; sub?: string; icon: typeof Wallet; tone: "blue" | "violet" | "green" | "amber" | "red" }) {
  return (
    <div className="animate-fade-up flex items-center gap-3 rounded-[14px] border border-line bg-white px-4 py-3.5 shadow-soft">
      <IconChip icon={icon} tone={tone} />
      <div className="min-w-0">
        <div className="text-xs font-medium text-muted">{label}</div>
        <div className="text-lg font-semibold leading-tight tracking-[-0.015em] tabular">{value}</div>
        {sub && <div className="truncate text-xs text-muted">{sub}</div>}
      </div>
    </div>
  );
}

async function lookups() {
  const sb = await createClient();
  const { data } = await sb.from("lookups").select("kind, value, extra").eq("active", true).order("sort").order("value");
  const by: Record<string, { value: string; extra: Record<string, string> }[]> = {};
  (data ?? []).forEach((l) => (by[l.kind] ??= []).push(l as { value: string; extra: Record<string, string> }));
  return by;
}

async function filesFor(caseId: string) {
  const sb = await createClient();
  const { data } = await sb.from("files").select("*, uploader:profiles!files_uploaded_by_fkey(full_name)").eq("case_id", caseId).order("created_at", { ascending: false });
  return (data ?? []) as FileRow[];
}

async function BookingsLoader(p: { caseId: string; lines: Line[]; travellers: PaxRow[]; maxId: string; customer: { full_name: string; mobile: string; whatsapp: string | null; email: string | null }; trip: { start: string | null; end: string | null } }) {
  const [lk, files] = await Promise.all([lookups(), filesFor(p.caseId)]);
  return <BookingsTab {...p} lookups={lk} files={files} />;
}

async function PaymentsLoader({ caseId, lines, money, status }: { caseId: string; lines: Line[]; money: Record<string, unknown> | null; status: string }) {
  const sb = await createClient();
  const [{ data: payments }, { data: expenses }, { data: suppliers }, { data: allocs }] = await Promise.all([
    sb.from("payments").select("*, receiver:profiles!payments_received_by_fkey(full_name)").eq("case_id", caseId).eq("direction", "in").order("pay_date", { ascending: false }),
    sb.from("expenses").select("*").eq("case_id", caseId).order("exp_date"),
    sb.from("v_case_supplier_money").select("*").eq("case_id", caseId),
    sb.from("payment_allocations").select("amount, payment:payments(id, pay_date, mode, reference, supplier:suppliers(name, terms))").eq("case_id", caseId),
  ]);
  // advance each supplier still holds (only for people who may see supplier money)
  const supIds = Array.from(new Set(((suppliers ?? []) as { supplier_id: string }[]).map((s) => s.supplier_id)));
  const advanceRows = await Promise.all(supIds.map(async (sid) => [sid, Number((await sb.rpc("supplier_advance", { p_supplier: sid })).data ?? 0)] as const));
  return (
    <PaymentsTab
      status={status}
      caseId={caseId}
      lines={lines}
      money={money}
      payments={payments ?? []}
      expenses={expenses ?? []}
      suppliers={suppliers ?? []}
      advances={Object.fromEntries(advanceRows)}
      supplierPayments={(allocs ?? []) as unknown as { amount: number; payment: { id: string; pay_date: string; mode: string; reference: string | null; supplier: { name: string; terms?: string } | null } }[]}
    />
  );
}

async function FilesLoader(p: { caseId: string; maxId: string; customer: { full_name: string; mobile: string; whatsapp: string | null; email: string | null }; travellers: { id: string; full_name: string }[]; lines: Line[] }) {
  const sb = await createClient();
  const [files, { data: docs }] = await Promise.all([
    filesFor(p.caseId),
    sb.from("customer_documents").select("id, customer_id, doc_type, file_name, expiry, customer:customers(full_name)").in("customer_id", p.travellers.map((t) => t.id)).not("storage_path", "is", null),
  ]);
  return <FilesTab {...p} files={files} docs={(docs ?? []) as unknown as { id: string; customer_id: string; doc_type: string; file_name: string; expiry: string | null; customer: { full_name: string } }[]} />;
}

/** Estimate and invoices of the case, shown where prices and payments are worked on. */
async function DocsLoader({ caseId, caseStatus, lines }: { caseId: string; caseStatus: string; lines: Line[] }) {
  const sb = await createClient();
  const { data } = await sb.from("invoices").select("id, number, issued_on, total, status, cancel_reason, lines").eq("case_id", caseId).order("created_at", { ascending: false });
  return (
    <CaseDocs caseId={caseId} caseStatus={caseStatus} invoices={(data ?? []) as unknown as InvoiceRow[]}
      lines={lines.map((l) => ({ id: l.id, status: l.status, selling_price: Number(l.selling_price), gst: Number(l.gst) }))} />
  );
}

async function TasksLoader({ caseId, maxId, title }: { caseId: string; maxId: string; title: string }) {
  const sb = await createClient();
  const { data } = await sb
    .from("tasks")
    .select("id, title, due_at, priority, status, alert, assigned_to, case_id, assignee:profiles!tasks_assigned_to_fkey(full_name), case:cases(max_id, title)")
    .eq("case_id", caseId)
    // open tasks first (soonest due on top), finished ones after
    .order("completed_at", { ascending: false, nullsFirst: true })
    .order("due_at", { nullsFirst: false });
  return (
    <Card pad={false}>
      <TaskList tasks={(data ?? []) as unknown as TaskRow[]} showCase={false} newPreset={{ case: { id: caseId, label: maxId, sub: title } }} emptyText="No tasks on this case yet." />
    </Card>
  );
}

async function ActivityLoader({ caseId }: { caseId: string }) {
  const sb = await createClient();
  const { data } = await sb.from("activity_log").select("*").eq("case_id", caseId).order("created_at", { ascending: false }).limit(200);
  return <Card><ActivityList items={data ?? []} /></Card>;
}

