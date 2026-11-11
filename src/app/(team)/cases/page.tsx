import Link from "next/link";
import { Download, KanbanSquare, List } from "lucide-react";
import { requireTeam } from "@/lib/auth";
import { createClient } from "@/lib/supabase/server";
import { listCases, PER_PAGE, type SP } from "@/lib/queries";
import { Card, Chips, Empty, LossDot, Money, PageHeader, Pager, Person, ServiceIcon, StatusBadge, Table, LinkButton, btnClass, cx } from "@/components/ui";
import { CaseBoard, WorkCell, type BoardCase, type WorkSummary } from "./board";
import { NewButton, SearchBox } from "@/components/list-tools";
import { TicketUploadButton } from "@/components/ticket-upload";
import { CASE_STATUSES, SERVICES, SERVICE_LABEL, STATUS_LABEL } from "@/lib/constants";
import { fdate } from "@/lib/format";

export const metadata = { title: "Cases" };

export default async function CasesPage({ searchParams }: { searchParams: Promise<SP> }) {
  const me = await requireTeam();
  const sp = await searchParams;
  const sb = await createClient();
  const board = sp.view === "board";
  // the list opens on open cases; "All" shows everything, and a search looks through every case
  const listSp: SP = { ...sp, status: sp.status === "all" ? undefined : sp.status ?? (sp.q ? undefined : "open") };
  const [{ rows, count, page }, { data: staff }] = await Promise.all([
    board ? boardCases(sp) : listCases(listSp),
    sb.from("profiles").select("id, full_name").in("role", ["boss", "staff"]).eq("active", true).order("full_name"),
  ]);
  // work summary per case: owner, next action, overdue tasks, pending imports and the main blocker (separate from the booking stage)
  const { data: wsData } = rows.length ? await sb.rpc("case_work_summary", { p_cases: rows.map((r) => r.id) }) : { data: [] };
  const work = new Map(((wsData ?? []) as WorkSummary[]).map((w) => [w.case_id, w]));
  const qs = new URLSearchParams(Object.entries(sp).filter(([k, v]) => v && k !== "page" && k !== "view") as [string, string][]).toString();
  const viewHref = (v: string) => `/cases?${new URLSearchParams(Object.entries({ ...sp, view: v, page: undefined, ...(v === "board" ? { status: undefined } : {}) }).filter(([, x]) => x) as [string, string][])}`;
  const filtered = Object.keys(sp).some((k) => k !== "page" && sp[k]);

  return (
    <>
      <PageHeader
        title="Cases"
        sub={`Every job has its own MAX ID · ${count} ${board ? "on the board" : "found"}`}
        action={
          <>
            <div className="inline-flex rounded-[10px] bg-gray-200/60 p-0.5">
              {[{ v: "list", l: "List", I: List }, { v: "board", l: "Board", I: KanbanSquare }].map(({ v, l, I }) => (
                <Link key={v} href={viewHref(v)} scroll={false}
                  className={cx("inline-flex items-center gap-1.5 rounded-lg px-3 py-1.5 text-[13px] font-medium transition-all", (board ? "board" : "list") === v ? "bg-white text-ink shadow-[0_1px_3px_rgba(16,24,40,0.12)]" : "text-muted hover:text-ink")}>
                  <I className="h-4 w-4" />{l}
                </Link>
              ))}
            </div>
            <a className={btnClass("secondary")} href={`/api/export?export=cases&${qs}`}><Download className="h-4 w-4" />Export to Excel</a>
            <TicketUploadButton />
            <NewButton kind="case" label="New case" />
          </>
        }
      />
      <div className="mb-4 space-y-2.5">
        <SearchBox placeholder="Search MAX ID, title, destination, customer name or mobile" />
        {!board && <Chips param="status" current={sp.status === "open" ? undefined : sp.status ?? (sp.q ? "all" : undefined)} base={sp} allLabel="Open" items={[{ value: "all", label: "All" }, ...CASE_STATUSES.map((s) => ({ value: s, label: STATUS_LABEL[s] }))]} />}
        <Chips param="work" current={sp.work} base={sp} allLabel="Any next step" items={[
          { value: "no_next", label: "No next step" }, { value: "overdue", label: "Next step overdue" },
          { value: "this_week", label: "Next step this week" }, { value: "waiting", label: "Waiting" },
        ]} />
        <Chips param="service" current={sp.service} base={sp} allLabel="All services" items={SERVICES.map((s) => ({ value: s, label: SERVICE_LABEL[s] }))} />
        <div className="flex flex-wrap gap-x-4 gap-y-2">
          <Chips param="date" current={sp.date} base={sp} allLabel="Any date" items={[
            { value: "travelling", label: "Travelling now" }, { value: "upcoming", label: "Travel in next 30 days" },
            { value: "this_month", label: "Created this month" }, { value: "last_month", label: "Created last month" },
          ]} />
          {(me.role === "boss" || me.can_see_all_cases) && (
            <Chips param="staff" current={sp.staff} base={sp} allLabel="All staff" items={[{ value: me.id, label: "Mine" }, ...(staff ?? []).filter((s) => s.id !== me.id).map((s) => ({ value: s.id, label: s.full_name }))]} />
          )}
        </div>
      </div>
      {board ? <CaseBoard cases={rows.map((r): BoardCase => ({
        id: r.id, max_id: r.max_id, title: r.title, status: r.status, travel_start: r.travel_start, destination: r.destination,
        customer: r.customer?.full_name ?? null, staff: r.staff?.full_name ?? null,
        services: Array.from(new Set(r.lines.filter((l) => l.status !== "cancelled").map((l) => l.service))),
        due: Number(r.money?.due ?? 0), sale: Number(r.money?.sale ?? 0),
        loss: me.can_see_profit && r.money?.profit != null && Number(r.money.profit) < 0,
        work: work.get(r.id) ?? null,
      }))} /> : (
      <Card pad={false}>
        {rows.length === 0 ? (
          filtered ? <Empty text="No cases match these filters." action={<LinkButton href="/cases">Clear filters</LinkButton>} />
            : <Empty text="No cases yet. Create your first MAX ID." action={<NewButton kind="case" label="New case" />} />
        ) : (
          <Table head={["MAX ID", "Case", "Travel", "Services", "Staff", "Status", "Work", "Due from client", ...(me.can_see_profit ? ["Profit"] : [])]}>
            {rows.map((r) => {
              const loss = me.can_see_profit && r.money?.profit != null && Number(r.money.profit) < 0;
              return (
                <tr key={r.id} className="relative">
                  <td data-label="MAX ID" className="whitespace-nowrap font-mono text-[13px] font-semibold">
                    <Link href={`/cases/${r.id}`} className="inline-flex items-center gap-1.5 after:absolute after:inset-0">
                      <LossDot show={loss} />{r.max_id}
                    </Link>
                  </td>
                  <td data-label="Case">
                    <div className="max-w-[320px] truncate font-medium">{r.title}</div>
                    <div className="text-xs text-muted">{r.customer?.full_name}{r.destination && ` · ${r.destination}`}</div>
                  </td>
                  <td data-label="Travel" className="whitespace-nowrap">{r.travel_start ? `${fdate(r.travel_start)}${r.travel_end ? " → " + fdate(r.travel_end) : ""}` : <span className="text-muted">—</span>}</td>
                  <td data-label="Services">
                    <span className="inline-flex gap-1">
                      {Array.from(new Set(r.lines.filter((l) => l.status !== "cancelled").map((l) => l.service))).map((s) => (
                        <span key={s} className="flex h-6 w-6 items-center justify-center rounded-md bg-gray-100 text-gray-600"><ServiceIcon service={s} className="h-3.5 w-3.5" /></span>
                      ))}
                    </span>
                  </td>
                  <td data-label="Staff" className="whitespace-nowrap"><Person name={r.staff?.full_name} size="xs" /></td>
                  <td data-label="Status"><StatusBadge status={r.status} /></td>
                  <td data-label="Work"><WorkCell w={work.get(r.id)} kase={{ id: r.id, max_id: r.max_id, title: r.title }} /></td>
                  <td data-label="Due from client" className="text-right md:text-left">{Number(r.money?.due) > 0 ? <Money value={r.money?.due} /> : <span className="text-muted">—</span>}</td>
                  {me.can_see_profit && <td data-label="Profit"><Money value={r.money?.profit} profit /></td>}
                </tr>
              );
            })}
          </Table>
        )}
        <Pager page={page} total={count} perPage={PER_PAGE} base={sp} />
      </Card>
      )}
    </>
  );
}

/** Board: every open case, plus the 25 most recently completed. */
async function boardCases(sp: SP) {
  const base = { ...sp, page: undefined, view: undefined };
  const [open, done] = await Promise.all([listCases({ ...base, status: "open" }, true), listCases({ ...base, status: "completed" })]);
  return { rows: [...open.rows, ...done.rows], count: open.count + Math.min(done.count, 25), page: 1 };
}
