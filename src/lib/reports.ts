import "server-only";
import { createClient } from "./supabase/server";
import { resolveRange } from "./range";
import { SERVICE_LABEL, STATUS_LABEL, type Service } from "./constants";
import { fdate, todayIST } from "./format";

export type Col = { key: string; label: string; money?: boolean; profit?: boolean; date?: boolean; pct?: boolean };
export type Report = { title: string; sub: string; cols: Col[]; rows: Record<string, unknown>[]; totals?: Record<string, unknown>; link?: (r: Record<string, unknown>) => string | null; sections?: { title: string; cols: Col[]; rows: Record<string, unknown>[] }[] };

export const REPORTS = [
  { key: "pnl", label: "Profit and loss", profit: true },
  { key: "client_dues", label: "Client dues" },
  { key: "supplier_dues", label: "Supplier dues" },
  { key: "sales", label: "Sales by service and staff", profit: true },
  { key: "upcoming", label: "Upcoming travel" },
  { key: "expiry", label: "Document expiry" },
] as const;

const sum = (rows: Record<string, unknown>[], k: string) => rows.reduce((s, r) => s + Number(r[k] ?? 0), 0);

export async function runReport(key: string, sp: Record<string, string | undefined>): Promise<Report> {
  const sb = await createClient();
  const range = resolveRange(sp);
  const f = { p_service: sp.service || null, p_staff: sp.staff || null, p_supplier: sp.supplier || null, p_customer: sp.customer || null };
  const throwIf = (e: { message: string } | null) => { if (e) throw new Error(e.message); };

  if (key === "pnl") {
    const { data, error } = await sb.rpc("report_pnl", { p_from: range.from, p_to: range.to, ...f });
    throwIf(error);
    const rows = (data ?? []).map((r: Record<string, unknown>) => ({ ...r, status: STATUS_LABEL[String(r.status)] }));
    const sale = sum(rows, "sale"), profit = sum(rows, "profit");
    return {
      title: "Profit and loss", sub: `Cases booked ${range.label.toLowerCase()} (confirmed onwards)`,
      cols: [{ key: "max_id", label: "MAX ID" }, { key: "booked_on", label: "Booked", date: true }, { key: "customer", label: "Customer" }, { key: "staff", label: "Staff" }, { key: "status", label: "Status" },
        { key: "sale", label: "Sale", money: true }, { key: "cost", label: "Cost", money: true }, { key: "commission", label: "Commission", money: true },
        { key: "expenses", label: "Expenses", money: true }, { key: "profit", label: "Profit", money: true, profit: true }, { key: "margin", label: "Margin %", pct: true }],
      rows, link: (r) => `/cases/${r.case_id}?tab=payments`,
      totals: { max_id: `Total (${rows.length})`, sale, cost: sum(rows, "cost"), commission: sum(rows, "commission"), expenses: sum(rows, "expenses"), profit, margin: sale ? Math.round((profit / sale) * 1000) / 10 : null },
    };
  }
  if (key === "client_dues") {
    const { data, error } = await sb.rpc("report_client_dues", { p_staff: f.p_staff, p_customer: f.p_customer });
    throwIf(error);
    const rows = data ?? [];
    return {
      title: "Client dues", sub: "Who owes us, oldest first",
      cols: [{ key: "max_id", label: "MAX ID" }, { key: "customer", label: "Customer" }, { key: "mobile", label: "Mobile" }, { key: "staff", label: "Staff" },
        { key: "billed", label: "Billed", money: true }, { key: "received", label: "Received", money: true }, { key: "due", label: "Due", money: true },
        { key: "due_since", label: "Due since", date: true }, { key: "days", label: "Days" }],
      rows, link: (r) => `/cases/${r.case_id}?tab=payments`,
      totals: { max_id: `Total (${rows.length})`, billed: sum(rows, "billed"), received: sum(rows, "received"), due: sum(rows, "due") },
    };
  }
  if (key === "supplier_dues") {
    const { data, error } = await sb.rpc("report_supplier_dues", { p_supplier: f.p_supplier });
    throwIf(error);
    const rows = data ?? [];
    return {
      title: "Supplier dues", sub: "What we owe each supplier",
      cols: [{ key: "name", label: "Supplier" }, { key: "payable", label: "Payable", money: true }, { key: "paid", label: "Paid", money: true }, { key: "due", label: "Due", money: true }, { key: "oldest_due", label: "Oldest due date", date: true }],
      rows, link: (r) => `/suppliers/${r.supplier_id}`,
      totals: { name: `Total (${rows.length})`, payable: sum(rows, "payable"), paid: sum(rows, "paid"), due: sum(rows, "due") },
    };
  }
  if (key === "sales") {
    const { data, error } = await sb.rpc("report_sales", { p_from: range.from, p_to: range.to, ...f });
    throwIf(error);
    const all = (data ?? []) as { group_kind: string; group_key: string; bookings: number; sale: number; profit: number }[];
    const cols: Col[] = [{ key: "group_key", label: "" }, { key: "bookings", label: "Bookings" }, { key: "sale", label: "Sale", money: true }, { key: "profit", label: "Profit", money: true, profit: true }];
    const svc = all.filter((r) => r.group_kind === "service").map((r) => ({ ...r, group_key: SERVICE_LABEL[r.group_key as Service] ?? r.group_key }));
    const staff = all.filter((r) => r.group_kind === "staff");
    return {
      title: "Sales by service and staff", sub: `Bookings on cases booked ${range.label.toLowerCase()}`, cols, rows: [],
      sections: [
        { title: "By service", cols: [{ ...cols[0], label: "Service" }, ...cols.slice(1)], rows: svc },
        { title: "By staff", cols: [{ ...cols[0], label: "Staff" }, ...cols.slice(1)], rows: staff },
      ],
    };
  }
  if (key === "upcoming") {
    const from = sp.range ? range.from : todayIST();
    const to = sp.range ? range.to : todayIST(30);
    const { data, error } = await sb.rpc("report_upcoming", { p_from: from, p_to: to, ...f });
    throwIf(error);
    return {
      title: "Upcoming travel", sub: `Trips from ${fdate(from)} to ${fdate(to)}`,
      cols: [{ key: "service_date", label: "Date", date: true }, { key: "max_id", label: "MAX ID" }, { key: "customer", label: "Customer" }, { key: "mobile", label: "Mobile" },
        { key: "service", label: "Service" }, { key: "summary", label: "Details" }, { key: "line_status", label: "Status" }, { key: "staff", label: "Staff" }],
      rows: (data ?? []).map((r: Record<string, unknown>) => ({ ...r, service: SERVICE_LABEL[r.service as Service], line_status: STATUS_LABEL[String(r.line_status)] })),
      link: (r) => `/cases/${r.case_id}?tab=bookings`,
    };
  }
  if (key === "expiry") {
    const months = Number(sp.months) || 6;
    const { data, error } = await sb.rpc("report_doc_expiry", { p_months: months });
    throwIf(error);
    return {
      title: "Document expiry", sub: `Passports, visas and documents expired or expiring in the next ${months} months`,
      cols: [{ key: "expiry", label: "Expiry", date: true }, { key: "days", label: "Days left" }, { key: "customer", label: "Customer" }, { key: "mobile", label: "Mobile" }, { key: "document", label: "Document" }],
      rows: data ?? [], link: (r) => `/customers/${r.customer_id}?tab=documents`,
    };
  }
  throw new Error("Unknown report");
}
