"use server";
import { createClient } from "@/lib/supabase/server";
import { fail, type ActionResult } from "@/lib/auth";

/** Issue an invoice for everything on the case that is priced and not yet invoiced. The key makes a double click safe. */
export async function issueInvoice(caseId: string, requestKey: string): Promise<ActionResult<{ id: string; number: string }>> {
  try {
    const sb = await createClient();
    const { data, error } = await sb.rpc("issue_invoice", { p_case: caseId, p_request_key: requestKey });
    if (error) throw error;
    const r = data as { id: string; number: string; existing: boolean };
    return { ok: true, data: { id: r.id, number: r.number }, message: r.existing ? `${r.number} was already issued` : `Invoice ${r.number} issued` };
  } catch (e) {
    return fail(e);
  }
}

/** An issued invoice is never edited: cancel it with a reason, then issue a new one. */
export async function cancelInvoice(invoiceId: string, reason: string): Promise<ActionResult> {
  try {
    if (!reason.trim()) return { ok: false, error: "Say why the invoice is being cancelled." };
    const sb = await createClient();
    const { error } = await sb.rpc("cancel_invoice", { p_invoice: invoiceId, p_reason: reason.trim() });
    if (error) throw error;
    return { ok: true, message: "Invoice cancelled. Issue a new one when the bookings are right." };
  } catch (e) {
    return fail(e);
  }
}
