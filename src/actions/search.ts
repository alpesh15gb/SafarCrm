"use server";
import { createClient } from "@/lib/supabase/server";

export type SearchHit = { kind: string; id: string; label: string; sub: string; href: string };

export async function searchAll(q: string): Promise<SearchHit[]> {
  const sb = await createClient();
  const { data } = await sb.rpc("global_search", { q });
  return (data ?? []) as SearchHit[];
}

export async function searchCustomers(q: string) {
  const sb = await createClient();
  const t = q.trim();
  let query = sb.from("customers").select("id, code, full_name, mobile, family_id, customer_type").order("full_name").limit(12);
  if (t) {
    const digits = t.replace(/\D/g, "");
    query = digits.length >= 4
      ? query.or(`mobile.ilike.%${digits}%,full_name.ilike.%${t.replace(/[,()%]/g, "")}%,code.ilike.%${t.replace(/[,()%]/g, "")}%`)
      : query.or(`full_name.ilike.%${t.replace(/[,()%]/g, "")}%,code.ilike.${t.replace(/[,()%]/g, "")}%`);
  }
  const { data } = await query;
  return data ?? [];
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
  if (q.trim()) query = query.ilike("name", `%${q.trim().replace(/[,()%]/g, "")}%`);
  if (service) query = query.or(`services.cs.{${service}},services.eq.{}`);
  const { data } = await query;
  return data ?? [];
}

export async function familyMembers(customerId: string) {
  const sb = await createClient();
  const { data: c } = await sb.from("customers").select("id, family_id, last_name").eq("id", customerId).single();
  if (!c?.family_id) return { last_name: c?.last_name ?? null, members: [] as { id: string; full_name: string; dob: string | null }[] };
  const { data } = await sb.from("customers").select("id, full_name, dob").eq("family_id", c.family_id).neq("id", customerId).order("dob");
  return { last_name: c.last_name as string | null, members: data ?? [] };
}

export async function lookupValues(kind: string) {
  const sb = await createClient();
  const { data } = await sb.from("lookups").select("value, extra").eq("kind", kind).eq("active", true).order("sort").order("value");
  return data ?? [];
}
