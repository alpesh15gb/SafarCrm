import { notFound } from "next/navigation";
import Link from "next/link";
import { requireTeam } from "@/lib/auth";
import { createClient } from "@/lib/supabase/server";
import { Check, IndianRupee, Layers, TrendingUp, Wallet, Receipt } from "lucide-react";
import { Avatar, Card, IconChip, Money, PageHeader, Tabs, cx } from "@/components/ui";
import { STATUS_LABEL } from "@/lib/constants";
import type { PaxSource } from "@/lib/iata";

type PaxRow = PaxSource & { id: string; full_name: string; dob: string | null; passport_expiry: string | null; mobile: string };
import { MaxId } from "@/components/client";
import { fdate, prettyPhone, inr } from "@/lib/format";
import { CaseHeaderControls } from "./header-controls";
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
  { key: "payments", label: "Payments and P&L" },
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
    .select("*, customer:customers!cases_customer_id_fkey(id, full_name, mobile, whatsapp, email, family_id, code), staff:profiles!cases_assigned_to_fkey(id, full_name), creator:profiles!cases_created_by_fkey(full_name)")
    .eq("id", id)
    .maybeSingle();
  if (!c) notFound();

  const [{ data: money }, { data: travellers }, { data: lines }, { data: lineMoney }, { data: openTasks }] = await Promise.all([
    sb.from("v_case_money").select("*").eq("case_id", id).single(),
    sb.from("case_travellers").select("customer:customers(id, full_name, title, first_name, middle_name, last_name, passport_surname, passport_given_name, gender, dob, passport_expiry, mobile)").eq("case_id", id),
    sb.from("booking_lines").select("*, supplier:suppliers(id, name)").eq("case_id", id).order("sort").order("service_date", { nullsFirst: false }).order("created_at"),
    sb.from("v_line_money").select("line_id, billed, sale, cost, profit, margin").eq("case_id", id),
    sb.from("tasks").select("id", { count: "exact", head: true }).eq("case_id", id).neq("status", "done").then((r) => ({ data: r.count })),
  ]);
  const trav = (travellers ?? []).map((t) => t.customer as unknown as PaxRow);
  const customer = c.customer as { id: string; full_name: string; mobile: string; whatsapp: string | null; email: string | null; family_id: string | null; code: string };
  const lm = new Map((lineMoney ?? []).map((m) => [m.line_id, m]));
  const linesWithMoney = (lines ?? []).map((l) => ({ ...l, money: lm.get(l.id) })) as Line[];

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
        action={<CaseHeaderControls kase={{ id: c.id, status: c.status, assigned_to: c.assigned_to, max_id: c.max_id, cancel_reason: c.cancel_reason }} />}
      />

      <StatusSteps status={c.status} />

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
      {tab === "files" && <FilesLoader caseId={id} maxId={c.max_id} customer={customer} travellerIds={trav.map((t) => t.id)} lines={linesWithMoney} />}
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

const FLOW = ["enquiry", "quoted", "confirmed", "booked", "completed"];
/** Where this case sits in Enquiry → Completed. */
function StatusSteps({ status }: { status: string }) {
  if (status === "cancelled") {
    return <div className="mb-4 rounded-xl border border-red-200 bg-red-50 px-4 py-2.5 text-sm font-medium text-red-700">This case is cancelled.</div>;
  }
  const at = FLOW.indexOf(status);
  return (
    <ol className="no-print mb-4 flex items-center overflow-x-auto rounded-[14px] border border-line bg-white px-4 py-3 shadow-soft">
      {FLOW.map((s, i) => {
        const done = i < at, cur = i === at;
        return (
          <li key={s} className={cx("flex items-center", i < FLOW.length - 1 && "flex-1")}>
            <span className="flex shrink-0 items-center gap-2">
              <span className={cx("flex h-6 w-6 items-center justify-center rounded-full text-[11px] font-semibold",
                done ? "bg-emerald-500 text-white" : cur ? "bg-coral text-white ring-4 ring-coral/15" : "bg-gray-100 text-gray-400")}>
                {done ? <Check className="h-3.5 w-3.5" /> : i + 1}
              </span>
              <span className={cx("whitespace-nowrap text-[13px]", cur ? "font-semibold text-ink" : done ? "font-medium text-ink" : "text-muted")}>{STATUS_LABEL[s]}</span>
            </span>
            {i < FLOW.length - 1 && <span className={cx("mx-3 h-0.5 min-w-6 flex-1 rounded-full", i < at ? "bg-emerald-400" : "bg-gray-200")} />}
          </li>
        );
      })}
    </ol>
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
    sb.from("payment_allocations").select("amount, payment:payments(id, pay_date, mode, reference, supplier:suppliers(name))").eq("case_id", caseId),
  ]);
  return (
    <PaymentsTab
      status={status}
      caseId={caseId}
      lines={lines}
      money={money}
      payments={payments ?? []}
      expenses={expenses ?? []}
      suppliers={suppliers ?? []}
      supplierPayments={(allocs ?? []) as unknown as { amount: number; payment: { id: string; pay_date: string; mode: string; reference: string | null; supplier: { name: string } | null } }[]}
    />
  );
}

async function FilesLoader(p: { caseId: string; maxId: string; customer: { full_name: string; mobile: string; whatsapp: string | null; email: string | null }; travellerIds: string[]; lines: Line[] }) {
  const sb = await createClient();
  const [files, { data: docs }] = await Promise.all([
    filesFor(p.caseId),
    sb.from("customer_documents").select("id, doc_type, file_name, expiry, customer:customers(full_name)").in("customer_id", p.travellerIds).not("storage_path", "is", null),
  ]);
  return <FilesTab {...p} files={files} docs={(docs ?? []) as unknown as { id: string; doc_type: string; file_name: string; expiry: string | null; customer: { full_name: string } }[]} />;
}

async function TasksLoader({ caseId, maxId, title }: { caseId: string; maxId: string; title: string }) {
  const sb = await createClient();
  const { data } = await sb
    .from("tasks")
    .select("id, title, due_at, priority, status, alert, assigned_to, case_id, assignee:profiles!tasks_assigned_to_fkey(full_name), case:cases(max_id, title)")
    .eq("case_id", caseId)
    .order("status")
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

