"use server";
import { createClient } from "@/lib/supabase/server";
import { fail, getMe, type ActionResult } from "@/lib/auth";
import { readinessText, type Readiness } from "@/lib/readiness";
import type { Service } from "@/lib/constants";

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
  services?: Service[];
};

const clean = (v: string | null | undefined) => (v === undefined ? undefined : v?.toString().trim() || null);

/** Case and its travellers in one transaction. The request key makes a double click or retry return the same MAX ID. */
export async function createCase(input: CaseInput, requestKey?: string): Promise<ActionResult<{ id: string; max_id: string }>> {
  try {
    if (!input.customer_id) return { ok: false, error: "Pick a customer." };
    if (!input.title?.trim()) return { ok: false, error: "Give the case a title." };
    const sb = await createClient();
    const travellers = Array.from(new Set(input.traveller_ids ?? []));
    const { data, error } = await sb.rpc("create_case", {
      p: {
        customer_id: input.customer_id, title: input.title.trim(), travel_start: clean(input.travel_start) ?? null,
        travel_end: clean(input.travel_end) ?? null, destination: clean(input.destination) ?? null, lead_source: clean(input.lead_source) ?? null,
        assigned_to: input.assigned_to || null, status: input.status || "enquiry", notes: clean(input.notes) ?? null, tags: input.tags ?? [],
      },
      p_travellers: travellers,
      p_request_key: requestKey ?? null,
    });
    if (error) throw error;
    const r = data as { id: string; max_id: string; existing: boolean };
    const services = Array.from(new Set((input.services ?? []).filter(Boolean)));
    if (!r.existing && services.length) {
      const { data: ct } = await sb.from("case_travellers").select("customer_id").eq("case_id", r.id);
      const paxIds = (ct ?? []).map((x) => x.customer_id as string);
      const dest = clean(input.destination) ?? undefined;
      const start = clean(input.travel_start) ?? undefined;
      const end = clean(input.travel_end) ?? undefined;
      const rows = services.flatMap<Record<string, unknown>>((service, idx) => {
        if (service === "visa") {
          const details: Record<string, unknown> = { visa_type: "Tourist", mode: "e-Visa", entry: "Single", application_status: "Documents pending", ...(dest ? { country: dest } : {}) };
          const pax = paxIds.length > 1 ? paxIds.map((tid) => [tid]) : [paxIds];
          return pax.map((tids, j) => ({
            case_id: r.id, service, status: "pending", pricing_state: "not_entered", traveller_ids: tids, details, sort: idx * 10 + j,
          }));
        }
        const details: Record<string, unknown> = service === "hotel"
          ? { ...(dest ? { city: dest } : {}), ...(start ? { check_in: start } : {}), ...(end && start && end > start ? { check_out: end } : {}) }
          : {};
        return [{ case_id: r.id, service, status: "pending", pricing_state: "not_entered", traveller_ids: paxIds, details, sort: idx * 10 }];
      });
      const { error: le } = await sb.from("booking_lines").insert(rows);
      if (le) throw le;
    }
    return {
      ok: true, data: { id: r.id, max_id: r.max_id },
      message: r.existing ? `${r.max_id} was already created` : `${r.max_id} created`,
    };
  } catch (e) {
    return fail(e);
  }
}

/** What stands between this case and Completed: blockers (need the boss to override), loose ends (need a reason), optional follow-ups. */
export async function getReadiness(id: string): Promise<Readiness> {
  const sb = await createClient();
  const { data, error } = await sb.rpc("case_readiness", { p_case: id });
  if (error) return { blockers: [], loose_ends: [{ code: "unknown", count: 0, text: "Could not check what is still open. Try again." }], optional: [] };
  return data as Readiness;
}

/** Plain-language list of what is still open on a case (empty when it can be closed cleanly). */
export async function getOpenItems(id: string): Promise<string[]> {
  return readinessText(await getReadiness(id));
}

export async function updateCase(id: string, patch: Partial<CaseInput> & { cancel_reason?: string | null; complete_reason?: string }): Promise<ActionResult> {
  try {
    const sb = await createClient();
    // closing and cancelling each run as one checked transaction in the database
    if (patch.status === "completed") {
      const { data, error } = await sb.rpc("complete_case", { p_case: id, p_reason: patch.complete_reason?.trim() || null });
      if (error) throw error;
      const r = data as { completed: boolean; overridden: boolean; readiness: Readiness };
      if (!r.completed) {
        const open = readinessText(r.readiness);
        return { ok: false, error: `Can't complete yet: ${open.join("; ")}. Open the case to finish these, or complete it with a reason.` };
      }
      const rest = { ...patch };
      delete rest.status; delete rest.complete_reason;
      if (Object.keys(rest).length) return updateCase(id, rest);
      return { ok: true, message: r.overridden ? "Completed. The open items and your reason are in the activity history." : "Completed" };
    }
    if (patch.status === "cancelled") {
      const { error } = await sb.rpc("cancel_case", { p_case: id, p_reason: patch.cancel_reason?.trim() || "" });
      if (error) throw error;
      return { ok: true, message: "Case cancelled" };
    }
    const row: Record<string, unknown> = {};
    for (const k of ["title", "travel_start", "travel_end", "destination", "lead_source", "notes", "cancel_reason"] as const) {
      if (k in patch) row[k] = clean(patch[k] as string | null | undefined);
    }
    if ("assigned_to" in patch) row.assigned_to = patch.assigned_to || null;
    if ("status" in patch) row.status = patch.status;
    if ("tags" in patch) row.tags = patch.tags;
    // changing who pays never changes who travels
    if ("customer_id" in patch && patch.customer_id) row.customer_id = patch.customer_id;
    const { data, error } = await sb.from("cases").update(row).eq("id", id).select("id");
    if (error) throw error;
    if (!data?.length) return { ok: false, error: "You can't change this case." };
    return { ok: true, message: "Saved" };
  } catch (e) {
    return fail(e);
  }
}

export async function setTravellers(caseId: string, ids: string[]): Promise<ActionResult> {
  try {
    const sb = await createClient();
    const { data, error } = await sb.rpc("set_case_travellers", { p_case: caseId, p_ids: Array.from(new Set(ids.filter(Boolean))) });
    if (error) throw error;
    const touched = Number(data ?? 0);
    return { ok: true, message: touched ? `Travellers updated, and removed from ${touched} booking${touched === 1 ? "" : "s"}` : "Travellers updated" };
  } catch (e) {
    return fail(e);
  }
}

/** Adds one person to a case's travellers (used inline from a booking or an import, without closing the form). */
export async function addCaseTraveller(caseId: string, customerId: string): Promise<ActionResult<{ id: string; full_name: string }>> {
  try {
    const sb = await createClient();
    const { error } = await sb.from("case_travellers").upsert({ case_id: caseId, customer_id: customerId }, { ignoreDuplicates: true });
    if (error) throw error;
    const { data: c } = await sb.from("customers").select("id, full_name").eq("id", customerId).single();
    return { ok: true, data: c ?? { id: customerId, full_name: "" }, message: "Added to the travellers" };
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

/** Sets the work summary (new / in progress / waiting). Waiting needs a reason and a follow-up time. */
export async function setWorkState(caseId: string, state: string, reason?: string | null, followUpAt?: string | null): Promise<ActionResult> {
  try {
    const sb = await createClient();
    const { error } = await sb.rpc("set_case_work_state", { p_case: caseId, p_state: state, p_reason: reason?.trim() || null, p_follow_up_at: followUpAt || null });
    if (error) throw error;
    return { ok: true, message: "Work status updated" };
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

/** Star a case so it stays at the top of the case list for everyone. Boss only (checked in the database too). */
export async function setCaseStar(id: string, starred: boolean): Promise<ActionResult> {
  try {
    const me = await getMe();
    if (me?.role !== "boss") return { ok: false, error: "Only the boss can star a case." };
    const sb = await createClient();
    const { error } = await sb.from("cases").update({ starred }).eq("id", id);
    if (error) throw error;
    return { ok: true, message: starred ? "Starred: it stays at the top of the list" : "Star removed" };
  } catch (e) {
    return fail(e);
  }
}
