"use server";
import { createClient } from "@/lib/supabase/server";
import { inr } from "@/lib/format";
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

export type OpenItems = { pending_lines: number; client_due: number; client_credit: number; supplier_due: number };

/** Plain-language list of what is still open on a case (empty when it can be closed cleanly). */
export async function getOpenItems(id: string): Promise<string[]> {
  const sb = await createClient();
  const { data } = await sb.rpc("case_open_items", { p_case: id });
  const o = (data ?? {}) as OpenItems;
  
  return [
    o.pending_lines > 0 && `${o.pending_lines} booking${o.pending_lines === 1 ? " is" : "s are"} still Pending`,
    o.client_due > 0 && `the client still owes ${inr(o.client_due)}`,
    o.client_credit > 0 && `the client has a credit of ${inr(o.client_credit)} to refund or adjust`,
    o.supplier_due > 0 && `${inr(o.supplier_due)} is still to be paid to suppliers`,
  ].filter(Boolean) as string[];
}

export async function updateCase(id: string, patch: Partial<CaseInput> & { cancel_reason?: string | null; complete_reason?: string }): Promise<ActionResult> {
  try {
    const sb = await createClient();
    // closing a case with loose ends needs a reason, which is kept in the case notes
    if (patch.status === "completed") {
      const open = await getOpenItems(id);
      if (open.length) {
        const why = patch.complete_reason?.trim();
        if (!why) return { ok: false, error: `Can't complete yet: ${open.join("; ")}. Open the case to finish these, or complete it with a reason.` };
        const { data: cur } = await sb.from("cases").select("notes").eq("id", id).single();
        const stamp = new Date().toLocaleDateString("en-GB", { timeZone: "Asia/Kolkata" }).replace(/\//g, "-");
        patch.notes = `${cur?.notes ? cur.notes + "\n" : ""}[${stamp}] Completed with open items (${open.join("; ")}). Reason: ${why}`;
      }
    }
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
    // anyone no longer on the trip comes off every booking too (and off its ticket list), so lists never disagree
    const { data: lines } = await sb.from("booking_lines").select("id, traveller_ids, details").eq("case_id", caseId);
    const { data: gone } = await sb.from("customers").select("id, full_name")
      .in("id", Array.from(new Set((lines ?? []).flatMap((l) => (l.traveller_ids as string[]).filter((t) => !all.includes(t))))));
    const goneIds = new Set((gone ?? []).map((g) => g.id));
    const goneNames = new Set((gone ?? []).map((g) => g.full_name));
    let touched = 0;
    for (const l of lines ?? []) {
      const keep = (l.traveller_ids as string[]).filter((t) => !goneIds.has(t));
      if (keep.length === (l.traveller_ids as string[]).length) continue;
      const d = { ...(l.details ?? {}) } as Record<string, unknown>;
      if (Array.isArray(d.tickets)) d.tickets = (d.tickets as { passenger: string }[]).filter((t) => !goneNames.has(t.passenger));
      const { error: ue } = await sb.from("booking_lines").update({ traveller_ids: keep, details: d }).eq("id", l.id);
      if (ue) throw ue;
      touched++;
    }
    return { ok: true, message: touched ? `Travellers updated, and removed from ${touched} booking${touched === 1 ? "" : "s"}` : "Travellers updated" };
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
