"use server";
import { createClient } from "@/lib/supabase/server";
import { fail, getMe, type ActionResult } from "@/lib/auth";
import { lineProblem } from "@/lib/validate";
import { moneyProblem, parseMoney, strictAmount } from "@/lib/money";
import type { Service } from "@/lib/constants";
import { todayIST } from "@/lib/format";

/** When no client payment date is given: a week before the service, never earlier than today (3 days from now if the service has no date).
 *  Without a due date the "collect payment" reminder would never run. */
function defaultClientDue(serviceDate: string | null): string {
  if (!serviceDate) return todayIST(3);
  const d = new Date(`${serviceDate}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() - 7);
  const weekBefore = d.toISOString().slice(0, 10);
  return weekBefore < todayIST() ? todayIST() : weekBefore;
}

type Amount = number | string | null | undefined;

export type LineInput = {
  id?: string;
  case_id: string;
  service: string;
  supplier_id: string | null;
  status: string;
  reference?: string | null;
  traveller_ids: string[];
  supplier_cost: Amount;
  selling_price: Amount;
  commission_type: "amount" | "percent";
  commission_value: Amount;
  gst: Amount;
  payment_due_date?: string | null;
  supplier_due_date?: string | null;
  notes?: string | null;
  details: Record<string, unknown>;
  visible_to_client?: boolean;
};

const n = strictAmount;

/** Missing, unreadable and zero are three different things: unreadable is refused, missing is recorded as "not priced yet". */
function moneyProblems(input: LineInput): string | null {
  return moneyProblem("Supplier cost", input.supplier_cost)
    ?? moneyProblem("Selling price", input.selling_price)
    ?? moneyProblem("Commission", input.commission_value)
    ?? moneyProblem("GST", input.gst)
    ?? moneyProblem("Base fare", (input.details ?? {}).base_fare);
}

export async function saveLine(input: LineInput): Promise<ActionResult<{ id: string }>> {
  try {
    const problem = lineProblem(input.service as Service, (input.details ?? {}) as Record<string, unknown>) ?? moneyProblems(input);
    if (problem) return { ok: false, error: problem };
    const me = await getMe();
    // staff who may not see profit never see the saved cost or commission: on an edit, an empty cost means "keep it"
    const keepCost = !!input.id && !me?.can_see_profit && parseMoney(input.supplier_cost).kind !== "value";
    const hasSale = parseMoney(input.selling_price).kind === "value", hasCost = keepCost || parseMoney(input.supplier_cost).kind === "value";
    // a selling price with no cost would be saved as cost ₹0 and show 100% profit; ask instead of guessing
    if (hasSale && !hasCost && input.status !== "cancelled") return { ok: false, error: "Enter the supplier cost as well (type 0 if there is none), so the profit is right." };
    const priced = hasSale || hasCost;
    const sb = await createClient();
    const { data: caseBefore } = await sb.from("cases").select("status").eq("id", input.case_id).maybeSingle();
    // a confirmed booking can move the case to Booked, or complete it: say so
    const moved = async () => {
      const { data: c } = await sb.from("cases").select("status, max_id").eq("id", input.case_id).maybeSingle();
      if (!c || !caseBefore || c.status === caseBefore.status) return "";
      return c.status === "completed" ? `. ${c.max_id} is complete: booked and fully paid.` : `. ${c.max_id} moved to ${c.status.charAt(0).toUpperCase()}${c.status.slice(1)}.`;
    };
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
      // a booking nobody has priced yet (both prices left empty) is flagged, so it isn't mistaken for a free one
      pricing_state: priced ? "entered" : "not_entered",
    };
    if (keepCost) delete row.supplier_cost;
    if (!me?.can_see_profit) { delete row.commission_type; delete row.commission_value; }   // commission is set by those who see profit
    if (input.supplier_due_date !== undefined) row.supplier_due_date = input.supplier_due_date || null;
    if (input.visible_to_client !== undefined && !input.id) row.visible_to_client = input.visible_to_client;
    if (row.status === undefined) delete row.status;
    // a priced booking with no client due date gets one, so the collection reminder can run
    const needsDue = !input.payment_due_date && input.status !== "cancelled" && Number(row.selling_price ?? 0) > 0;
    const fillDue = async (id: string, serviceDate: string | null) => {
      if (!needsDue) return "";
      const due = defaultClientDue(serviceDate);
      const { error } = await sb.from("booking_lines").update({ payment_due_date: due }).eq("id", id);
      return error ? "" : `. Client payment due set to ${due.split("-").reverse().join("-")}`;
    };
    if (input.id) {
      const { data, error } = await sb.from("booking_lines").update(row).eq("id", input.id).select("id, service_date").maybeSingle();
      if (error) throw error;
      const note = data ? await fillDue(input.id, data.service_date as string | null) : "";
      return { ok: true, data: { id: input.id }, message: `Booking saved${note}${await moved()}` };
    }
    const { data, error } = await sb.from("booking_lines").insert(row).select("id, service_date").single();
    if (error) throw error;
    const note = await fillDue(data.id, data.service_date as string | null);
    return { ok: true, data: { id: data.id }, message: `Booking added${note}${await moved()}` };
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
      d.sectors = [...(d.sectors as Record<string, string>[])].reverse().map((s) => ({ ...s, from: s.to, to: s.from, date: "", flight_no: "", dep: "", arr: "", arr_date: "", dep_tz: s.arr_tz ?? "", arr_tz: s.dep_tz ?? "" }));
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
      // a copy of a booking nobody has priced is not priced either
      pricing_state: l.pricing_state ?? "entered",
    }).select("id").single();
    if (ie) throw ie;
    return { ok: true, data, message: l.service === "visa" ? "New visa file created. Change the traveller if it is for someone else." : "Line duplicated. Fill in the new dates." };
  } catch (e) {
    return fail(e);
  }
}

export async function cancelLine(id: string, v: { reason: string; cancellation_charge: Amount; refund_to_client: Amount; refund_from_supplier: Amount }): Promise<ActionResult> {
  try {
    if (!v.reason?.trim()) return { ok: false, error: "Give a reason for cancelling." };
    const bad = moneyProblem("Cancellation charge", v.cancellation_charge) ?? moneyProblem("Refund to client", v.refund_to_client) ?? moneyProblem("Refund from supplier", v.refund_from_supplier);
    if (bad) return { ok: false, error: bad };
    const sb = await createClient();
    // a refund can never be more than what was charged: a slipped digit here would invent profit or debt
    const { data: line } = await sb.from("booking_lines").select("supplier_cost, selling_price, gst").eq("id", id).maybeSingle();
    if (!line) return { ok: false, error: "That booking could not be found." };
    const paidByClient = Number(line.selling_price) + Number(line.gst);
    if (n(v.refund_to_client) > paidByClient + 0.009) return { ok: false, error: `The refund to the client (₹${n(v.refund_to_client)}) is more than the booking's price (₹${paidByClient}). Check the amount.` };
    if (n(v.refund_from_supplier) > Number(line.supplier_cost) + 0.009) return { ok: false, error: `The refund from the supplier (₹${n(v.refund_from_supplier)}) is more than the supplier cost (₹${Number(line.supplier_cost)}). Check the amount.` };
    if (n(v.refund_to_client) < 0 || n(v.refund_from_supplier) < 0 || n(v.cancellation_charge) < 0) return { ok: false, error: "Refunds and charges can't be negative." };
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
