import "server-only";
import { createClient } from "./supabase/server";
import { monthRange, todayIST } from "./format";

export const PER_PAGE = 25;
export type SP = Record<string, string | undefined>;

/** Runs a list query either for one page, or (exports) for every row, 1,000 at a time (the API's row cap). */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function fetchRows<T>(make: () => any, page: number, all: boolean): Promise<{ rows: T[]; count: number }> {
  if (!all) {
    const { data, count, error } = await make().range((page - 1) * PER_PAGE, page * PER_PAGE - 1);
    if (error) throw error;
    return { rows: (data ?? []) as T[], count: count ?? 0 };
  }
  const rows: T[] = [];
  let count = 0;
  for (let from = 0; ; from += 1000) {
    const { data, count: c, error } = await make().range(from, from + 999);
    if (error) throw error;
    rows.push(...((data ?? []) as T[]));
    count = c ?? rows.length;
    if ((data ?? []).length < 1000) break;
  }
  return { rows, count };
}

/** Looks rows up by id in small batches: a long id list in one request is rejected by the gateway (URL too long). */
export async function byIds<T>(ids: string[], run: (chunk: string[]) => PromiseLike<{ data: T[] | null; error: { message: string } | null }>) {
  const out: T[] = [];
  for (let i = 0; i < ids.length; i += 100) {
    const { data, error } = await run(ids.slice(i, i + 100));
    if (error) throw new Error(error.message);
    out.push(...(data ?? []));
  }
  return out;
}

export type CaseRow = {
  id: string; max_id: string; title: string; status: string; travel_start: string | null; travel_end: string | null;
  destination: string | null; created_at: string; assigned_to: string | null;
  customer: { id: string; full_name: string; mobile: string } | null;
  staff: { full_name: string } | null;
  lines: { service: string; status: string }[];
  money?: { billed: number; received: number; due: number; profit: number | null; margin: number | null; sale: number };
};

export async function listCases(sp: SP, all = false) {
  const sb = await createClient();
  const page = Math.max(1, Number(sp.page) || 1);
  const sel = `id, max_id, title, status, travel_start, travel_end, destination, created_at, assigned_to,
    customer:customers!cases_customer_id_fkey(id, full_name, mobile), staff:profiles!cases_assigned_to_fkey(full_name),
    lines:booking_lines${sp.service ? "!inner" : ""}(service, status)`;
  // "what the case needs next" filter: the ids come from the database (open cases only), then the usual filters apply
  let workIds: string[] | null = null;
  if (sp.work) {
    const { data } = await sb.rpc("cases_by_work", { p_kind: sp.work });
    workIds = ((data ?? []) as unknown as string[]).map(String);
    if (!workIds.length) workIds = ["00000000-0000-0000-0000-000000000000"];
  }
  const make = () => {
  let q = sb.from("cases").select(sel, { count: "exact" });
  if (workIds) q = q.in("id", workIds);
  if (sp.status === "open") q = q.not("status", "in", "(completed,cancelled)");
  else if (sp.status) q = q.eq("status", sp.status);
  if (sp.service) q = q.eq("booking_lines.service", sp.service);
  if (sp.staff) q = q.eq("assigned_to", sp.staff);
  if (sp.customer) q = q.eq("customer_id", sp.customer);
  if (sp.date === "upcoming") q = q.gte("travel_start", todayIST()).lte("travel_start", todayIST(30));
  if (sp.date === "travelling") q = q.lte("travel_start", todayIST()).gte("travel_end", todayIST());
  if (sp.date === "this_month" || sp.date === "last_month") {
    const r = monthRange(sp.date === "this_month" ? 0 : -1);
    q = q.gte("created_at", r.from + "T00:00:00+05:30").lte("created_at", r.to + "T23:59:59+05:30");
  }
  if (sp.q) {
    const t = sp.q.replace(/[,()%]/g, "").trim();
    const digits = t.replace(/\D/g, "");
    q = q.or(`title.ilike.%${t}%,max_id.ilike.%${digits || t}%,destination.ilike.%${t}%`);
  }
  q = sp.date === "upcoming" ? q.order("travel_start", { ascending: true }) : q.order("created_at", { ascending: false });
  return q.order("id");
  };
  const { rows, count } = await fetchRows<CaseRow>(make, page, all);
  if (rows.length) {
    const m = await byIds(rows.map((r) => r.id), (ids) => sb.from("v_case_money").select("case_id, billed, received, due, profit, margin, sale").in("case_id", ids));
    const byId = new Map(m.map((x) => [x.case_id, x]));
    rows.forEach((r) => (r.money = byId.get(r.id) as CaseRow["money"]));
  }
  return { rows, count, page };
}

export async function listCustomers(sp: SP, all = false) {
  const sb = await createClient();
  const page = Math.max(1, Number(sp.page) || 1);
  const make = () => {
  let q = sb.from("customers").select("id, code, full_name, customer_type, mobile, email, city, tags, passport_expiry, dob, lead_source, created_at, family:families(name), staff:profiles!customers_assigned_to_fkey(full_name), cases:cases!cases_customer_id_fkey(count)", { count: "exact" });
  // "Family" means "belongs to a family" (set on the Family tab), whatever the old customer-type field says
  if (sp.type === "family") q = q.not("family_id", "is", null);
  else if (sp.type === "individual") q = q.eq("customer_type", "individual").is("family_id", null);
  else if (sp.type) q = q.eq("customer_type", sp.type);
  if (sp.tag) q = q.contains("tags", [sp.tag]);
  if (sp.staff) q = q.eq("assigned_to", sp.staff);
  if (sp.passport === "expiring") q = q.lte("passport_expiry", todayIST(183));
  if (sp.q) {
    const t = sp.q.replace(/[,()%]/g, "").trim();
    const digits = t.replace(/\D/g, "");
    // a number could be part of a mobile or a customer code (C-0012), so look in both
    q = q.or([`full_name.ilike.%${t}%`, `code.ilike.%${t}%`, `email.ilike.%${t}%`, `city.ilike.%${t}%`, `company_name.ilike.%${t}%`,
      ...(digits.length >= 4 ? [`mobile.ilike.%${digits}%`, `alt_mobile.ilike.%${digits}%`, `whatsapp.ilike.%${digits}%`] : [])].join(","));
  }
  return q.order(sp.passport === "expiring" ? "passport_expiry" : "full_name").order("id");
  };
  const { rows, count } = await fetchRows<Record<string, unknown>>(make, page, all);
  return { rows: rows as unknown as {
    id: string; code: string; full_name: string; customer_type: string; mobile: string; email: string | null; city: string | null; tags: string[];
    passport_expiry: string | null; dob: string | null; lead_source: string | null; created_at: string;
    family: { name: string } | null; staff: { full_name: string } | null; cases: { count: number }[];
  }[], count, page };
}

export async function listSuppliers(sp: SP, all = false) {
  const sb = await createClient();
  const page = Math.max(1, Number(sp.page) || 1);
  const make = () => {
  let q = sb.from("suppliers").select("id, name, supplier_type, services, status, contact_person, mobile, city, terms, credit_days", { count: "exact" });
  if (sp.type) q = q.eq("supplier_type", sp.type);
  if (sp.status) q = q.eq("status", sp.status);
  if (sp.service) q = q.contains("services", [sp.service]);
  if (sp.q) q = q.ilike("name", `%${sp.q.replace(/[,()%]/g, "").trim()}%`);
  return q.order("name").order("id");
  };
  type Sup = { id: string; name: string; supplier_type: string; services: string[]; status: string; contact_person: string | null; mobile: string | null; city: string | null; terms: string; credit_days: number };
  const { rows, count } = await fetchRows<Sup>(make, page, all);
  const bal = rows.length ? await byIds(rows.map((r) => r.id), (ids) => sb.from("v_supplier_balance").select("supplier_id, payable, paid").in("supplier_id", ids)) : [];
  const b = new Map(bal.map((x) => [x.supplier_id, x]));
  return { rows: rows.map((r) => ({ ...r, payable: Number(b.get(r.id)?.payable ?? 0), paid: Number(b.get(r.id)?.paid ?? 0) })), count, page };
}
