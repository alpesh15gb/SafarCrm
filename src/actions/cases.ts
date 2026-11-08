"use server";
import { createClient } from "@/lib/supabase/server";
import { fail, getMe, type ActionResult } from "@/lib/auth";

type CaseInput = {
  customer_id: string;
  title: string;
  travel_start?: string | null;
  travel_end?: string | null;
  destination?: string | null;
  lead_source?: string | null;
  assigned_to?: string | null;
  status?: string;
  notes?: string | null;
  tags?: string[];
  traveller_ids?: string[];
};

const clean = (v: string | null | undefined) => (v === undefined ? undefined : v?.toString().trim() || null);

export async function createCase(input: CaseInput): Promise<ActionResult<{ id: string; max_id: string }>> {
  try {
    if (!input.customer_id) return { ok: false, error: "Pick a customer." };
    if (!input.title?.trim()) return { ok: false, error: "Give the case a title." };
    const sb = await createClient();
    const { data, error } = await sb
      .from("cases")
      .insert({
        customer_id: input.customer_id,
        title: input.title.trim(),
        travel_start: clean(input.travel_start),
        travel_end: clean(input.travel_end),
        destination: clean(input.destination),
        lead_source: clean(input.lead_source),
        assigned_to: input.assigned_to || undefined,
        status: input.status || "enquiry",
        notes: clean(input.notes),
        tags: input.tags ?? [],
      })
      .select("id, max_id")
      .single();
    if (error) throw error;
    const extra = (input.traveller_ids ?? []).filter((t) => t !== input.customer_id);
    if (extra.length) {
      const { error: te } = await sb.from("case_travellers").insert(extra.map((customer_id) => ({ case_id: data.id, customer_id })));
      if (te) throw te;
    }
    return { ok: true, data, message: `${data.max_id} created` };
  } catch (e) {
    return fail(e);
  }
}

export async function updateCase(id: string, patch: Partial<CaseInput> & { cancel_reason?: string | null }): Promise<ActionResult> {
  try {
    const sb = await createClient();
    const row: Record<string, unknown> = {};
    for (const k of ["title", "travel_start", "travel_end", "destination", "lead_source", "notes", "cancel_reason"] as const) {
      if (k in patch) row[k] = clean(patch[k] as string | null | undefined);
    }
    if ("assigned_to" in patch) row.assigned_to = patch.assigned_to || null;
    if ("status" in patch) row.status = patch.status;
    if ("tags" in patch) row.tags = patch.tags;
    if ("customer_id" in patch && patch.customer_id) row.customer_id = patch.customer_id;
    const { error } = await sb.from("cases").update(row).eq("id", id);
    if (error) throw error;
    if ("customer_id" in patch && patch.customer_id) {
      await sb.from("case_travellers").upsert({ case_id: id, customer_id: patch.customer_id });
    }
    return { ok: true, message: "Saved" };
  } catch (e) {
    return fail(e);
  }
}

export async function setTravellers(caseId: string, ids: string[]): Promise<ActionResult> {
  try {
    const sb = await createClient();
    const { data: c } = await sb.from("cases").select("customer_id").eq("id", caseId).single();
    const all = Array.from(new Set([c?.customer_id, ...ids].filter(Boolean))) as string[];
    const { error: de } = await sb.from("case_travellers").delete().eq("case_id", caseId).not("customer_id", "in", `(${all.join(",")})`);
    if (de) throw de;
    const { error } = await sb.from("case_travellers").upsert(all.map((customer_id) => ({ case_id: caseId, customer_id })));
    if (error) throw error;
    return { ok: true, message: "Travellers updated" };
  } catch (e) {
    return fail(e);
  }
}

export async function setClientView(caseId: string, view: Record<string, boolean>): Promise<ActionResult> {
  try {
    const me = await getMe();
    if (me?.role !== "boss") return { ok: false, error: "Only the boss can change what clients see." };
    const sb = await createClient();
    const { error } = await sb.from("cases").update({ client_view: view }).eq("id", caseId);
    if (error) throw error;
    return { ok: true, message: "Client view updated" };
  } catch (e) {
    return fail(e);
  }
}

export async function deleteCase(id: string): Promise<ActionResult> {
  try {
    const sb = await createClient();
    const { data, error } = await sb.from("cases").delete().eq("id", id).select("id");
    if (error) throw error;
    if (!data?.length) return { ok: false, error: "Only the boss can delete cases. Mark it Cancelled instead." };
    return { ok: true, message: "Case deleted" };
  } catch (e) {
    return fail(e);
  }
}

export async function previewAsClient(caseId: string) {
  const sb = await createClient();
  const { data, error } = await sb.rpc("portal_preview", { p_case: caseId });
  if (error) return null;
  return data as import("@/components/trip-view").Trip | null;
}
