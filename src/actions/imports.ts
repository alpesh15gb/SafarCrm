"use server";
import { createClient } from "@/lib/supabase/server";
import { fail, getMe, type ActionResult } from "@/lib/auth";
import { blockingIssues, type Draft } from "@/lib/imports/schema";
import { moneyProblem } from "@/lib/money";

export type ConfirmPayload = {
  payer_customer_id: string | null;
  case: { mode: "existing"; id: string; stage?: string | null } | { mode: "new"; title: string; stage: string; destination?: string | null };
  booking: { mode: "new" } | { mode: "update" | "reissue"; line_id: string; comparison_reviewed: boolean };
  booked_by: "agency" | "customer";
  line_status: "pending" | "confirmed";
  passengers: ({ customer_id: string } | { create: { first_name: string; last_name?: string; mobile: string; gender?: string; dob?: string; passport_surname?: string; passport_given_name?: string } })[];
  agency_charge?: { amount: string; confirmed: boolean } | null;
};

async function team() {
  const me = await getMe();
  if (!me || me.role === "client" || me.mfa_pending) throw new Error("Not allowed");
  return me;
}

/** Save the reviewer's working copy (resumable). Returns the new version. */
export async function saveImportDraft(id: string, version: number, draft: Draft): Promise<ActionResult<{ version: number }>> {
  try {
    await team();
    const sb = await createClient();
    const { data, error } = await sb.rpc("save_import_draft", { p_id: id, p_expected_version: version, p_draft: draft });
    if (error) throw error;
    return { ok: true, data: { version: Number(data) }, message: "Draft saved" };
  } catch (e) {
    return fail(e);
  }
}

export async function retryImport(id: string): Promise<ActionResult> {
  try {
    await team();
    const sb = await createClient();
    const { error } = await sb.rpc("retry_ticket_import", { p_id: id });
    if (error) throw error;
    return { ok: true, message: "Queued to read again. Your edits are kept." };
  } catch (e) {
    return fail(e);
  }
}

export async function rejectImport(id: string, reason: string, duplicateOf?: string | null): Promise<ActionResult> {
  try {
    await team();
    if (!reason.trim()) return { ok: false, error: "Give a reason." };
    const sb = await createClient();
    const { error } = await sb.rpc("reject_ticket_import", { p_id: id, p_reason: reason.trim(), p_duplicate_of: duplicateOf || null });
    if (error) throw error;
    return { ok: true, message: duplicateOf ? "Marked as a duplicate" : "Import rejected" };
  } catch (e) {
    return fail(e);
  }
}

/** Confirm in one database transaction. The data saved at `version` is what gets confirmed; the key makes repeats safe. */
export async function confirmImport(id: string, version: number, key: string, draft: Draft, p: ConfirmPayload): Promise<ActionResult<{ case_id: string; max_id: string; booking_line_id: string; already: boolean }>> {
  try {
    await team();
    const block = blockingIssues(draft);
    if (block.length) return { ok: false, error: `Fix these first: ${block.map((b) => b.text).join(" ")}` };
    if (p.booked_by === "customer" && p.agency_charge?.confirmed) {
      const bad = moneyProblem("Agency charge", p.agency_charge.amount, { required: true });
      if (bad) return { ok: false, error: bad };
    }
    const sb = await createClient();
    const { data, error } = await sb.rpc("confirm_ticket_import", { p_id: id, p_expected_version: version, p_key: key, p });
    if (error) throw error;
    const r = data as { case_id: string; max_id: string; booking_line_id: string; already_confirmed: boolean };
    return {
      ok: true, data: { case_id: r.case_id, max_id: r.max_id, booking_line_id: r.booking_line_id, already: r.already_confirmed },
      message: r.already_confirmed ? `Already confirmed on ${r.max_id}` : `Saved to ${r.max_id}. The ticket file stays private until the boss publishes it.`,
    };
  } catch (e) {
    return fail(e);
  }
}

/** People on file whose name looks like an issued ticket name. Suggestions only: the reviewer picks, nothing is merged. */
export async function personCandidates(issuedName: string) {
  await team();
  const sb = await createClient();
  const letters = (s: string) => s.toUpperCase().replace(/[^A-Z/ ]/g, " ").replace(/\s+/g, " ").trim();
  const n = letters(issuedName).replace(/\s(MR|MRS|MS|MISS|MSTR|DR|CHD|INF)$/, "").replace(/^(MR|MRS|MS|MISS|MSTR|MASTER|DR) /, "");
  const [last, first] = n.includes("/") ? n.split("/").map((x) => x.trim()) : [n.split(" ").at(-1) ?? "", n.split(" ")[0] ?? ""];
  const term = (last || first).replace(/[,()%]/g, "");
  if (term.length < 2) return [];
  const { data } = await sb.from("customers")
    .select("id, code, full_name, dob, mobile, customer_type, passport_surname, passport_given_name, family:families(name)")
    .or(`last_name.ilike.${term}%,passport_surname.ilike.${term}%,full_name.ilike.%${term}%`)
    .neq("customer_type", "corporate").limit(12);
  type Row = { id: string; code: string; full_name: string; dob: string | null; mobile: string; passport_surname: string | null; passport_given_name: string | null; family: { name: string } | null };
  return ((data ?? []) as unknown as Row[]).map((c) => {
    const pass = c.passport_surname ? `${c.passport_surname}/${c.passport_given_name ?? ""}`.toUpperCase() : null;
    const why = pass && letters(pass).startsWith(letters(`${last}/${first}`).slice(0, Math.max(3, last.length + 2))) ? "passport name matches" : "similar name";
    return { id: c.id, code: c.code, full_name: c.full_name, dob: c.dob, mobile_last4: c.mobile.slice(-4), family: c.family?.name ?? null, passport_name: pass, why };
  });
}

/** Existing bookings that are probably this ticket, within what the reviewer may see. */
export async function probableDuplicates(draft: Draft) {
  await team();
  const sb = await createClient();
  const tickets = draft.passengers.flatMap((p) => p.tickets.map((t) => t.number.value)).filter(Boolean);
  const dates = draft.segments.map((s) => s.dep_date.value).filter((d) => /^\d{4}-\d{2}-\d{2}$/.test(d));
  const { data } = await sb.rpc("probable_booking_duplicates", { p_ticket_numbers: tickets, p_pnr: draft.airline_pnrs[0]?.value ?? "", p_dates: dates });
  return (data ?? []) as { line_id: string; case_id: string; max_id: string; summary: string | null; service_date: string | null; status: string; reason: string }[];
}

/** A flight booking on a case, for the field-by-field comparison before updating or reissuing it. */
export async function bookingForCompare(lineId: string) {
  await team();
  const sb = await createClient();
  const { data } = await sb.from("booking_lines").select("id, case_id, status, summary, details, traveller_ids").eq("id", lineId).eq("service", "flight").maybeSingle();
  return data as { id: string; case_id: string; status: string; summary: string | null; details: Record<string, unknown>; traveller_ids: string[] } | null;
}

export async function flightLinesOnCase(caseId: string) {
  await team();
  const sb = await createClient();
  const { data } = await sb.from("booking_lines").select("id, summary, service_date, status").eq("case_id", caseId).eq("service", "flight").order("service_date");
  return (data ?? []) as { id: string; summary: string | null; service_date: string | null; status: string }[];
}
