import "server-only";
import { createClient } from "./supabase/server";
import { resolveRange } from "./range";
import { SERVICE_LABEL, STATUS_LABEL, type Service } from "./constants";
import { fdate } from "./format";
import { clientDueTiming, reportParams } from "./report-filters";

export type Col = { key: string; label: string; money?: boolean; profit?: boolean; date?: boolean; pct?: boolean };
export type Report = { title: string; sub: string; cols: Col[]; rows: Record<string, unknown>[]; totals?: Record<string, unknown>; link?: (r: Record<string, unknown>) => string | null; sections?: { title: string; cols: Col[]; rows: Record<string, unknown>[] }[];
  /** a second table under the main one (e.g. costs with no supplier under Supplier dues) */
  after?: { title: string; sub?: string; cols: Col[]; rows: Record<string, unknown>[]; totals?: Record<string, unknown>; link?: (r: Record<string, unknown>) => string | null } };

export const REPORTS = [
  { key: "pnl", label: "Profit and loss", profit: true },
  { key: "client_dues", label: "Client dues" },
  { key: "client_credits", label: "Client credits" },
  { key: "supplier_dues", label: "Supplier dues", profit: true },
  { key: "cashbook", label: "Cash and bank book", profit: true },
  { key: "sales", label: "Sales by service and staff", profit: true },
  { key: "upcoming", label: "Upcoming travel" },
  { key: "expiry", label: "Document expiry" },
] as const;

const sum = (rows: Record<string, unknown>[], k: string) => rows.reduce((s, r) => s + Number(r[k] ?? 0), 0);

/** Costs on bookings with no supplier (QA, 2026-11-18): they are not owed to anyone in the table above, so they are
 *  listed here until a supplier is put on the booking. Confirmed or cancelled-with-a-charge bookings only. */
async function unassignedCosts(sb: Awaited<ReturnType<typeof createClient>>) {
  const { data, error } = await sb.from("booking_lines")
    .select("id, service, summary, status, supplier_cost, refund_from_supplier, service_date, case:cases!inner(id, max_id, status, customer:customers!cases_customer_id_fkey(full_name))")
    .is("supplier_id", null).neq("status", "pending").neq("case.status", "cancelled").limit(500);
  if (error) throw new Error(error.message);
  type L = { id: string; service: string; summary: string | null; status: string; supplier_cost: number; refund_from_supplier: number | null; service_date: string | null; case: { id: string; max_id: string; customer: { full_name: string } | null } };
  const rows = ((data ?? []) as unknown as L[])
    .map((l) => ({ case_id: l.case.id, max_id: l.case.max_id, customer: l.case.customer?.full_name ?? "",
      booking: `${SERVICE_LABEL[l.service as Service] ?? l.service}${l.summary ? ` · ${l.summary}` : ""}${l.status === "cancelled" ? " (cancelled)" : ""}`,
      service_date: l.service_date,
      cost: Number(l.supplier_cost ?? 0) - (l.status === "cancelled" ? Number(l.refund_from_supplier ?? 0) : 0) }))
    .filter((r) => r.cost > 0.009);
  return {
    title: `Costs with no supplier (${rows.length})`,
    sub: "Not counted above, because there is no one to pay. Open the booking and choose the supplier, or leave it if it was paid directly (e.g. visa fees on the embassy site).",
    cols: [{ key: "max_id", label: "MAX ID" }, { key: "customer", label: "Customer" }, { key: "booking", label: "Booking" },
      { key: "service_date", label: "Date", date: true }, { key: "cost", label: "Cost", money: true }] as Col[],
    rows, totals: { max_id: `Total (${rows.length})`, cost: sum(rows, "cost") },
    link: (r: Record<string, unknown>) => `/cases/${r.case_id}?tab=bookings`,
  };
}

export async function runReport(key: string, input: Record<string, string | undefined>): Promise<Report> {
  const sp = reportParams(key, input);
  const sb = await createClient();
  const range = resolveRange(sp);
  const f = { p_service: sp.service || null, p_staff: sp.staff || null, p_supplier: sp.supplier || null, p_customer: sp.customer || null };
  const throwIf = (e: { message: string } | null) => { if (e) throw new Error(e.message); };

  if (key === "pnl") {
    const { data, error } = await sb.rpc("report_pnl", { p_from: range.from, p_to: range.to, ...f });
    throwIf(error);
    const rows = (data ?? []).map((r: Record<string, unknown>) => ({ ...r, status: STATUS_LABEL[String(r.status)] }));
    const sale = sum(rows, "sale"), profit = sum(rows, "profit");
    const bookingFilter = !!(sp.service || sp.supplier);
    return {
      title: "Profit and loss", sub: `Cases booked ${range.label.toLowerCase()} (confirmed onwards)`
        + (bookingFilter ? ". Sales, cost and commission cover matching bookings. Full case expenses are deducted once per case. Totals from separate filters can overlap." : ""),
      cols: [{ key: "max_id", label: "MAX ID" }, { key: "booked_on", label: "Booked", date: true }, { key: "customer", label: "Customer" }, { key: "staff", label: "Staff" }, { key: "status", label: "Status" },
        { key: "sale", label: "Sale", money: true }, { key: "cost", label: "Cost", money: true }, { key: "commission", label: "Commission", money: true },
        { key: "expenses", label: bookingFilter ? "Full case expenses" : "Expenses", money: true },
        { key: "profit", label: bookingFilter ? "Profit after case expenses" : "Profit", money: true, profit: true }, { key: "margin", label: "Margin %", pct: true }],
      rows, link: (r) => `/cases/${r.case_id}?tab=payments`,
      totals: { max_id: `Total (${rows.length})`, sale, cost: sum(rows, "cost"), commission: sum(rows, "commission"), expenses: sum(rows, "expenses"), profit, margin: sale ? Math.round((profit / sale) * 1000) / 10 : null },
    };
  }
  if (key === "client_dues") {
    const { data, error } = await sb.rpc("report_client_dues", { p_staff: f.p_staff, p_customer: f.p_customer });
    throwIf(error);
    const rows = (data ?? []).map((r: Record<string, unknown>) => ({ ...r, due_timing: clientDueTiming(r.days) }));
    return {
      title: "Client dues", sub: "Who owes us, oldest first. Includes confirmed cases, and enquiries or quotes once the client has paid an advance.",
      cols: [{ key: "max_id", label: "MAX ID" }, { key: "customer", label: "Customer" }, { key: "mobile", label: "Mobile" }, { key: "staff", label: "Staff" },
        { key: "billed", label: "Billed", money: true }, { key: "received", label: "Received", money: true }, { key: "due", label: "Due", money: true },
        { key: "due_since", label: "Due date", date: true }, { key: "due_timing", label: "Payment status" }],
      rows, link: (r) => `/cases/${r.case_id}?tab=payments`,
      totals: { max_id: `Total (${rows.length})`, billed: sum(rows, "billed"), received: sum(rows, "received"), due: sum(rows, "due") },
    };
  }
  if (key === "supplier_dues") {
    const { data, error } = await sb.rpc("report_supplier_dues", { p_supplier: f.p_supplier });
    throwIf(error);
    // money held by a supplier (wallet balance or advance) is shown on its own, never netted against what others are owed
    const rows = (data ?? []).map((r: Record<string, unknown>) => {
      const d = Number(r.due ?? 0);
      return { ...r, due: d > 0 ? d : 0, held: d < 0 ? -d : 0, oldest_due: d > 0 ? r.oldest_due : null };
    });
    return {
      title: "Supplier dues", sub: "What we owe each supplier, and money a supplier holds for us (wallet balance or advance)",
      cols: [{ key: "name", label: "Supplier" }, { key: "payable", label: "Payable", money: true }, { key: "paid", label: "Paid", money: true }, { key: "due", label: "We owe", money: true },
        { key: "held", label: "Wallet / advance", money: true }, { key: "oldest_due", label: "Oldest due date", date: true }],
      rows, link: (r) => `/suppliers/${r.supplier_id}`,
      totals: { name: `Total (${rows.length})`, payable: sum(rows, "payable"), paid: sum(rows, "paid"), due: sum(rows, "due"), held: sum(rows, "held") },
      after: await unassignedCosts(sb),
    };
  }
  if (key === "sales") {
    const { data, error } = await sb.rpc("report_sales", { p_from: range.from, p_to: range.to, ...f });
    throwIf(error);
    const all = (data ?? []) as { group_kind: string; group_key: string; bookings: number; sale: number; profit: number }[];
    const cols: Col[] = [{ key: "group_key", label: "" }, { key: "bookings", label: "Bookings" }, { key: "sale", label: "Sale", money: true }, { key: "profit", label: "Profit before case expenses", money: true, profit: true }];
    const svc = all.filter((r) => r.group_kind === "service").map((r) => ({ ...r, group_key: SERVICE_LABEL[r.group_key as Service] ?? r.group_key }));
    const staff = all.filter((r) => r.group_kind === "staff");
    return {
      title: "Sales by service and staff", sub: `Bookings on cases booked ${range.label.toLowerCase()}. Profit here is per booking, before case expenses (the Profit and loss report takes those off).`, cols, rows: [],
      sections: [
        { title: "By service", cols: [{ ...cols[0], label: "Service" }, ...cols.slice(1)], rows: svc },
        { title: "By staff", cols: [{ ...cols[0], label: "Staff" }, ...cols.slice(1)], rows: staff },
      ],
    };
  }
  if (key === "cashbook") {
    // each money account for the period, then every entry; one account chosen = a passbook with a running balance
    const [{ data: s, error: se }, { data: l, error: le }] = await Promise.all([
      sb.rpc("report_cashbook_summary", { p_from: range.from, p_to: range.to }),
      sb.rpc("report_cashbook_lines", { p_from: range.from, p_to: range.to, p_account: sp.account || null }),
    ]);
    throwIf(se); throwIf(le);
    const summary: Record<string, unknown>[] = ((s ?? []) as Record<string, unknown>[]).map((r) => ({ ...r, name: `${r.name}${r.last4 ? ` ••${r.last4}` : ""}` }));
    const one = sp.account ? summary.find((r) => r.account_id === sp.account) : null;
    let running = Number(one?.opening ?? 0);
    const lines = ((l ?? []) as Record<string, unknown>[]).map((r) => {
      running += Number(r.received ?? 0) - Number(r.paid ?? 0);
      return { ...r, balance: one ? Math.round(running * 100) / 100 : null };
    });
    const sumCols: Col[] = [{ key: "name", label: "Account" }, { key: "opening", label: "Opening", money: true }, { key: "money_in", label: "Money in", money: true },
      { key: "money_out", label: "Money out", money: true }, { key: "closing", label: "Closing", money: true }, { key: "entries", label: "Entries" }];
    const lineCols: Col[] = [{ key: "pay_date", label: "Date", date: true }, ...(one ? [] : [{ key: "account", label: "Account" }]), { key: "kind", label: "What" },
      { key: "party", label: "Client / supplier" }, { key: "max_id", label: "MAX ID" }, { key: "reference", label: "Reference" },
      { key: "received", label: "Received", money: true }, { key: "paid", label: "Paid", money: true }, ...(one ? [{ key: "balance", label: "Balance", money: true }] : [])];
    const withTotals = (rows: Record<string, unknown>[], cols: Col[], label: string) =>
      rows.length ? [...rows, Object.fromEntries(cols.map((c, i) => [c.key, i === 0 ? label : ["money_in", "money_out", "received", "paid", "entries"].includes(c.key) ? sum(rows, c.key) : null]))] : rows;
    return {
      title: one ? `Cash and bank book · ${one.name}` : "Cash and bank book",
      sub: `${range.label}. Money in and out of each account${one ? `, with the running balance from ${fdate(range.from)}` : ". Pick an account for its running balance"}. Payments saved without an account are listed by mode.`,
      cols: lineCols, rows: [],
      sections: [
        ...(one ? [] : [{ title: "Accounts", cols: sumCols, rows: withTotals(summary, sumCols, "Total") }]),
        { title: one ? `${one.name}: opening ${fdate(range.from)} ₹${Number(one.opening ?? 0).toLocaleString("en-IN")} · closing ₹${Number(one.closing ?? 0).toLocaleString("en-IN")}` : "Entries", cols: lineCols, rows: withTotals(lines, lineCols, "Total") },
      ],
    };
  }
  if (key === "client_credits") {
    const { data, error } = await sb.rpc("report_client_credits", { p_staff: f.p_staff, p_customer: f.p_customer });
    throwIf(error);
    const rows = (data ?? []).map((r: Record<string, unknown>) => ({ ...r, status: STATUS_LABEL[String(r.status)] }));
    return {
      title: "Client credits", sub: "Clients who paid more than they were billed, or are owed a refund after a cancellation. Refund or adjust each one.",
      cols: [{ key: "max_id", label: "MAX ID" }, { key: "customer", label: "Customer" }, { key: "mobile", label: "Mobile" }, { key: "staff", label: "Staff" }, { key: "status", label: "Status" },
        { key: "billed", label: "Billed", money: true }, { key: "received", label: "Received", money: true }, { key: "credit", label: "Credit", money: true }],
      rows, link: (r) => `/cases/${r.case_id}?tab=payments`,
      totals: { max_id: `Total (${rows.length})`, billed: sum(rows, "billed"), received: sum(rows, "received"), credit: sum(rows, "credit") },
    };
  }
  if (key === "upcoming") {
    const { from, to } = range;
    const { data, error } = await sb.rpc("report_upcoming", { p_from: from, p_to: to, ...f });
    throwIf(error);
    return {
      title: "Upcoming travel", sub: `Trips from ${fdate(from)} to ${fdate(to)}. Uses each booking's date; a case with no dated booking yet is listed by its trip start date.`,
      cols: [{ key: "service_date", label: "Date", date: true }, { key: "max_id", label: "MAX ID" }, { key: "customer", label: "Customer" }, { key: "mobile", label: "Mobile" },
        { key: "service", label: "Service" }, { key: "summary", label: "Details" }, { key: "line_status", label: "Status" }, { key: "staff", label: "Staff" }],
      rows: (data ?? []).map((r: Record<string, unknown>) => ({ ...r, // a visa row is dated by its application or appointment, not by travel: say so (QA, 2026-11-18)
        service: r.service === "trip" ? "Trip (case dates)" : r.service === "visa" ? "Visa (applied / appointment date, not travel)" : SERVICE_LABEL[r.service as Service], line_status: STATUS_LABEL[String(r.line_status)] })),
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
