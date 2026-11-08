"use server";
import { createClient } from "@/lib/supabase/server";
import { fail, type ActionResult } from "@/lib/auth";
import { lineProblem } from "@/lib/validate";
import type { Service } from "@/lib/constants";

export type LineInput = {
  id?: string;
  case_id: string;
  service: string;
  supplier_id: string | null;
  status: string;
  reference?: string | null;
  traveller_ids: string[];
  supplier_cost: number;
  selling_price: number;
  commission_type: "amount" | "percent";
  commission_value: number;
  gst: number;
  payment_due_date?: string | null;
  supplier_due_date?: string | null;
  notes?: string | null;
  details: Record<string, unknown>;
  visible_to_client?: boolean;
};

const n = (v: unknown) => (v === "" || v === null || v === undefined || Number.isNaN(Number(v)) ? 0 : Number(v));

export async function saveLine(input: LineInput): Promise<ActionResult<{ id: string }>> {
  try {
    const problem = lineProblem(input.service as Service, (input.details ?? {}) as Record<string, unknown>);
    if (problem) return { ok: false, error: problem };
    const sb = await createClient();
    const row: Record<string, unknown> = {
      case_id: input.case_id,
      service: input.service,
      supplier_id: input.supplier_id || null,
      status: input.status === "cancelled" ? undefined : input.status,
      reference: input.reference?.trim() || null,
      traveller_ids: input.traveller_ids,
      supplier_cost: n(input.supplier_cost),
      selling_price: n(input.selling_price),
      commission_type: input.commission_type,
      commission_value: n(input.commission_value),
      gst: n(input.gst),
      payment_due_date: input.payment_due_date || null,
      notes: input.notes?.trim() || null,
      details: input.details,
    };
    if (input.supplier_due_date !== undefined) row.supplier_due_date = input.supplier_due_date || null;
    if (input.visible_to_client !== undefined && !input.id) row.visible_to_client = input.visible_to_client;
    if (row.status === undefined) delete row.status;
    if (input.id) {
      const { error } = await sb.from("booking_lines").update(row).eq("id", input.id);
      if (error) throw error;
      return { ok: true, data: { id: input.id }, message: "Booking saved" };
    }
    const { data, error } = await sb.from("booking_lines").insert(row).select("id").single();
    if (error) throw error;
    return { ok: true, data, message: "Booking added" };
  } catch (e) {
    return fail(e);
  }
}

/** Duplicate a line (e.g. for the return trip). Flight sectors are reversed. */
export async function duplicateLine(id: string): Promise<ActionResult<{ id: string }>> {
  try {
    const sb = await createClient();
    const { data: l, error } = await sb.from("booking_lines").select("*").eq("id", id).single();
    if (error) throw error;
    const d = { ...(l.details ?? {}) } as Record<string, unknown>;
    if (l.service === "flight" && Array.isArray(d.sectors)) {
      d.sectors = [...(d.sectors as Record<string, string>[])].reverse().map((s) => ({ ...s, from: s.to, to: s.from, date: "", flight_no: "", dep: "", arr: "" }));
      d.pnr = ""; d.tickets = []; d.trip_type = "one-way";
    }
    // a visa is per person: copy country/type/checklist, clear everything specific to the old application
    if (l.service === "visa") {
      Object.assign(d, {
        application_status: "Documents pending", application_no: "", visa_number: "", appointment_date: "", appointment_time: "", applied_on: "",
        expected_by: "", valid_from: "", valid_to: "", refusal_reason: "", passport_with_us: false, passport_received_on: "", passport_returned_on: "",
        checklist: Array.isArray(d.checklist) ? (d.checklist as { item: string }[]).map((c) => ({ item: c.item, done: false })) : d.checklist,
      });
    }
    if (["rail", "bus"].includes(l.service)) { Object.assign(d, { from: d.to, to: d.from, date: "", pnr: "", ticket_no: "", seats: "" }); }
    const { data, error: ie } = await sb.from("booking_lines").insert({
      case_id: l.case_id, service: l.service, supplier_id: l.supplier_id, status: "pending", traveller_ids: l.traveller_ids,
      supplier_cost: l.supplier_cost, selling_price: l.selling_price, commission_type: l.commission_type, commission_value: l.commission_value,
      gst: l.gst, notes: l.notes, details: d, sort: (l.sort ?? 0) + 1,
    }).select("id").single();
    if (ie) throw ie;
    return { ok: true, data, message: l.service === "visa" ? "New visa file created. Change the traveller if it is for someone else." : "Line duplicated. Fill in the new dates." };
  } catch (e) {
    return fail(e);
  }
}

export async function cancelLine(id: string, v: { reason: string; cancellation_charge: number; refund_to_client: number; refund_from_supplier: number }): Promise<ActionResult> {
  try {
    if (!v.reason?.trim()) return { ok: false, error: "Give a reason for cancelling." };
    const sb = await createClient();
    const { error } = await sb.from("booking_lines").update({
      status: "cancelled", cancel_reason: v.reason.trim(), cancellation_charge: n(v.cancellation_charge),
      refund_to_client: n(v.refund_to_client), refund_from_supplier: n(v.refund_from_supplier),
    }).eq("id", id);
    if (error) throw error;
    return { ok: true, message: "Booking cancelled. P&L updated." };
  } catch (e) {
    return fail(e);
  }
}

export async function reinstateLine(id: string): Promise<ActionResult> {
  try {
    const sb = await createClient();
    const { error } = await sb.from("booking_lines").update({ status: "pending", cancel_reason: null, cancellation_charge: 0, refund_to_client: 0, refund_from_supplier: 0 }).eq("id", id);
    if (error) throw error;
    return { ok: true, message: "Booking reinstated" };
  } catch (e) {
    return fail(e);
  }
}

export async function setLineVisible(id: string, visible: boolean): Promise<ActionResult> {
  try {
    const sb = await createClient();
    const { error } = await sb.from("booking_lines").update({ visible_to_client: visible }).eq("id", id);
    if (error) throw error;
    return { ok: true, message: visible ? "Visible to client" : "Hidden from client" };
  } catch (e) {
    return fail(e);
  }
}

export async function deleteLine(id: string): Promise<ActionResult> {
  try {
    const sb = await createClient();
    const { data, error } = await sb.from("booking_lines").delete().eq("id", id).select("id");
    if (error) throw error;
    if (!data?.length) return { ok: false, error: "Only the boss can delete. Cancel the booking instead." };
    return { ok: true, message: "Booking deleted" };
  } catch (e) {
    return fail(e);
  }
}

/** One-click visa steps: merge a few fields into the visa line's details. */
export async function updateVisa(id: string, patch: Record<string, unknown>, message?: string): Promise<ActionResult> {
  try {
    const sb = await createClient();
    const { data: l, error } = await sb.from("booking_lines").select("service, details").eq("id", id).single();
    if (error) throw error;
    if (l.service !== "visa") return { ok: false, error: "This is not a visa booking." };
    const details = { ...(l.details ?? {}), ...patch };
    const { error: ue } = await sb.from("booking_lines").update({ details }).eq("id", id);
    if (ue) throw ue;
    return { ok: true, message: message ?? "Visa updated" };
  } catch (e) {
    return fail(e);
  }
}
