import Link from "next/link";
import { Download } from "lucide-react";
import { requireTeam } from "@/lib/auth";
import { createClient } from "@/lib/supabase/server";
import { REPORTS, runReport, type Col, type Report } from "@/lib/reports";
import { Card, Chips, Empty, Money, PageHeader, Table, btnClass, cx } from "@/components/ui";
import { DateRange } from "@/components/date-range";
import { PrintButton, ReportCustomerFilter } from "./client";
import { SERVICES, SERVICE_LABEL } from "@/lib/constants";
import { fdate } from "@/lib/format";

export const metadata = { title: "Reports" };
type SP = Record<string, string | undefined>;

export default async function ReportsPage({ searchParams }: { searchParams: Promise<SP> }) {
  const me = await requireTeam();
  const sp = await searchParams;
  const allowed = REPORTS.filter((r) => !("profit" in r && r.profit) || me.can_see_profit);
  const key = allowed.some((r) => r.key === sp.r) ? sp.r! : allowed[0].key;
  const sb = await createClient();
  const [{ data: staff }, { data: suppliers }] = await Promise.all([
    sb.from("profiles").select("id, full_name").in("role", ["boss", "staff"]).eq("active", true).order("full_name"),
    sb.from("suppliers").select("id, name").order("name"),
  ]);
  let report: Report | null = null;
  let error = "";
  try { report = await runReport(key, sp); } catch (e) { error = e instanceof Error ? e.message : "Could not run report"; }
  const qs = new URLSearchParams(Object.entries({ ...sp, r: key }).filter(([, v]) => v) as [string, string][]).toString();
  const uses = { date: ["pnl", "sales", "upcoming"].includes(key), service: ["pnl", "sales", "upcoming"].includes(key), staff: ["pnl", "sales", "upcoming", "client_dues"].includes(key), supplier: ["pnl", "sales", "upcoming", "supplier_dues"].includes(key), customer: ["pnl", "sales", "upcoming", "client_dues"].includes(key) };

  return (
    <>
      <PageHeader title="Reports" sub={!me.can_see_profit ? "Profit reports are visible to the boss and to staff the boss allows." : undefined}
        action={<><PrintButton /><a className={btnClass("primary")} href={`/api/export?type=report&${qs}`}><Download className="h-4 w-4" />Export to Excel</a></>} />
      <div className="no-print mb-3 space-y-2">
        <div className="flex flex-wrap gap-1.5">
          {allowed.map((r) => (
            <Link key={r.key} href={`?r=${r.key}`} className={cx("rounded-lg border px-3 py-1.5 text-sm", key === r.key ? "border-coral bg-coral-soft font-medium text-coral-dark" : "border-line bg-white text-muted hover:text-ink")}>{r.label}</Link>
          ))}
        </div>
        <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
          {uses.date && <DateRange />}
          {key === "expiry" && <Chips param="months" current={sp.months} base={sp} allLabel="6 months" items={[{ value: "1", label: "1 month" }, { value: "3", label: "3 months" }, { value: "12", label: "12 months" }]} />}
        </div>
        <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
          {uses.service && <Chips param="service" current={sp.service} base={{ ...sp, r: key }} allLabel="All services" items={SERVICES.map((s) => ({ value: s, label: SERVICE_LABEL[s] }))} />}
          {uses.staff && <Chips param="staff" current={sp.staff} base={{ ...sp, r: key }} allLabel="All staff" items={(staff ?? []).map((s) => ({ value: s.id, label: s.full_name }))} />}
        </div>
        <div className="flex flex-wrap gap-3">
          {uses.supplier && <SupplierSelect suppliers={suppliers ?? []} current={sp.supplier} sp={{ ...sp, r: key }} />}
          {uses.customer && <ReportCustomerFilter />}
        </div>
      </div>
      {error && <Card><p className="text-red-600">{error}</p></Card>}
      {report && (
        <div className="space-y-4">
          <div><h2 className="text-base font-semibold">{report.title}</h2><p className="text-[13px] text-muted">{report.sub}</p></div>
          {report.sections ? report.sections.map((s) => (
            <Card key={s.title} title={s.title} pad={false}>{s.rows.length ? <ReportTable cols={s.cols} rows={s.rows} /> : <Empty text="No data for this period." />}</Card>
          )) : (
            <Card pad={false}>{report.rows.length ? <ReportTable cols={report.cols} rows={report.rows} totals={report.totals} link={report.link} /> : <Empty text="Nothing to show for these filters." />}</Card>
          )}
        </div>
      )}
    </>
  );
}

function cell(c: Col, v: unknown) {
  if (c.money) return <Money value={v as number} profit={c.profit} />;
  if (c.date) return fdate(v as string) || "—";
  if (c.pct) return v === null || v === undefined ? "—" : `${v}%`;
  return v === null || v === undefined || v === "" ? "—" : String(v);
}

function ReportTable({ cols, rows, totals, link }: { cols: Col[]; rows: Record<string, unknown>[]; totals?: Record<string, unknown>; link?: (r: Record<string, unknown>) => string | null }) {
  return (
    <Table head={cols.map((c) => c.label)} foot={totals && <tr>{cols.map((c) => <td key={c.key} data-label={c.label}>{totals[c.key] !== undefined ? cell(c, totals[c.key]) : ""}</td>)}</tr>}>
      {rows.map((r, i) => {
        const href = link?.(r);
        return (
          <tr key={i} className={cx(href && "relative hover:bg-gray-50")}>
            {cols.map((c, j) => (
              <td key={c.key} data-label={c.label} className={cx(c.key === "max_id" && "font-mono text-[13px] font-semibold", c.key === "days" && Number(r.days) < 0 && "text-red-600")}>
                {j === 0 && href ? <Link href={href} className="after:absolute after:inset-0">{cell(c, r[c.key])}</Link> : cell(c, r[c.key])}
              </td>
            ))}
          </tr>
        );
      })}
    </Table>
  );
}

function SupplierSelect({ suppliers, current, sp }: { suppliers: { id: string; name: string }[]; current?: string; sp: SP }) {
  return (
    <form className="flex items-center gap-2" action="">
      {Object.entries(sp).filter(([k, v]) => v && k !== "supplier").map(([k, v]) => <input key={k} type="hidden" name={k} value={v} />)}
      <select name="supplier" defaultValue={current ?? ""} className="field !w-56">
        <option value="">All suppliers</option>{suppliers.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
      </select>
      <button className={btnClass("secondary", "sm")}>Apply</button>
    </form>
  );
}

