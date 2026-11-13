"use server";
import { createClient } from "@/lib/supabase/server";

export type SearchHit = { kind: string; id: string; label: string; sub: string; href: string };

export async function searchAll(q: string): Promise<SearchHit[]> {
  const sb = await createClient();
  const { data } = await sb.rpc("global_search", { q });
  return (data ?? []) as SearchHit[];
}

/** Customer search in forms. Finds any customer, so nobody adds a duplicate; for staff who may only see their own
 *  customers, someone else's customer comes back with just the name, code and a masked mobile. */
export async function searchCustomers(q: string) {
  const sb = await createClient();
  const { data } = await sb.rpc("customer_picker", { q: q.trim().replace(/[%_]/g, "") });
  return (data ?? []) as { id: string; code: string; full_name: string; mobile: string; family_id: string | null; customer_type: string }[];
}

export async function searchCases(q: string) {
  const sb = await createClient();
  const t = q.trim().replace(/[,()%]/g, "");
  let query = sb.from("cases").select("id, max_id, title, status, customer:customers!cases_customer_id_fkey(full_name)").order("created_at", { ascending: false }).limit(12);
  if (t) {
    const digits = t.replace(/\D/g, "");
    query = digits ? query.or(`max_id.ilike.%${digits}%,title.ilike.%${t}%`) : query.ilike("title", `%${t}%`);
  }
  const { data } = await query;
  return (data ?? []) as unknown as { id: string; max_id: string; title: string; status: string; customer: { full_name: string } | null }[];
}

export async function searchSuppliers(q: string, service?: string) {
  const sb = await createClient();
  let query = sb.from("suppliers").select("id, name, supplier_type, services, default_commission").eq("status", "active").order("name").limit(15);
  // the opening list is narrowed to suppliers offering this service; a typed name finds any active supplier,
  // so nobody "quick adds" a duplicate of a supplier whose services weren't ticked
  if (q.trim()) query = query.ilike("name", `%${q.trim().replace(/[,()%]/g, "")}%`);
  else if (service) query = query.or(`services.cs.{${service}},services.eq.{}`);
  const { data } = await query;
  return data ?? [];
}

/** Who can travel on this customer's cases: the customer, their family, and (for a company) its employees. */
export async function familyMembers(customerId: string) {
  const sb = await createClient();
  // names only, for choosing travellers; works for a customer found in search who is not yet this user's own
  const { data } = await sb.rpc("customer_family", { p_customer: customerId });
  type M = { id: string; full_name: string; dob: string | null; relation?: string | null; designation?: string | null };
  const f = (data ?? null) as { last_name: string | null; corporate: boolean; members: M[] } | null;
  return { last_name: f?.last_name ?? null, corporate: !!f?.corporate, members: f?.members ?? [] };
}

export async function lookupValues(kind: string) {
  const sb = await createClient();
  const { data } = await sb.from("lookups").select("value, extra").eq("kind", kind).eq("active", true).order("sort").order("value");
  return data ?? [];
}
