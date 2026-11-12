"use server";
import { createClient } from "@/lib/supabase/server";
import { fail, getMe, type ActionResult } from "@/lib/auth";
import { amount } from "@/lib/money";

type PayIn = { case_id: string; pay_date: string; amount: number; mode: string; reference?: string; received_by?: string; notes?: string };

export async function addClientPayment(p: PayIn): Promise<ActionResult> {
  try {
    if (!amount(p.amount)) return { ok: false, error: "Enter an amount." };
    const me = await getMe();
    const sb = await createClient();
    const { data: before } = await sb.from("cases").select("status").eq("id", p.case_id).maybeSingle();
    const { error } = await sb.from("payments").insert({
      direction: "in", case_id: p.case_id, pay_date: p.pay_date, amount: amount(p.amount), mode: p.mode,
      reference: p.reference?.trim() || null, received_by: p.received_by || me?.id, notes: p.notes?.trim() || null,
    });
    if (error) throw error;
    // the payment may have moved the case on: say so
    const { data: after } = await sb.from("cases").select("status, max_id").eq("id", p.case_id).maybeSingle();
    const moved = after && before && after.status !== before.status
      ? after.status === "completed" ? `. ${after.max_id} is complete: booked and fully paid.` : `. ${after.max_id} moved to ${after.status.charAt(0).toUpperCase()}${after.status.slice(1)}.`
      : "";
    return { ok: true, message: `${amount(p.amount) < 0 ? "Refund recorded" : "Payment recorded"}${moved}` };
  } catch (e) {
    return fail(e);
  }
}

type PayOut = { supplier_id: string; pay_date: string; amount: number; mode: string; reference?: string; notes?: string; allocations: { case_id: string; amount: number }[] };

export async function addSupplierPayment(p: PayOut): Promise<ActionResult> {
  try {
    if (!amount(p.amount)) return { ok: false, error: "Enter an amount." };
    const alloc = p.allocations.filter((a) => amount(a.amount));
    const sum = alloc.reduce((s, a) => s + amount(a.amount), 0);
    // the rest (if any) is an advance with the supplier
    if (sum - amount(p.amount) > 0.009) return { ok: false, error: `The MAX ID amounts add up to ₹${sum}, more than the payment of ₹${p.amount}.` };
    const sb = await createClient();
    // payment + allocations in one database transaction (all or nothing)
    const { error } = await sb.rpc("record_supplier_payment", {
      p_supplier: p.supplier_id, p_date: p.pay_date || null, p_amount: amount(p.amount), p_mode: p.mode,
      p_reference: p.reference ?? null, p_notes: p.notes ?? null,
      p_allocations: alloc.map((a) => ({ case_id: a.case_id, amount: amount(a.amount) })),
    });
    if (error) throw error;
    return { ok: true, message: "Supplier payment recorded" };
  } catch (e) {
    return fail(e);
  }
}

export async function deletePayment(id: string): Promise<ActionResult> {
  try {
    const sb = await createClient();
    const { data, error } = await sb.from("payments").delete().eq("id", id).select("id");
    if (error) throw error;
    if (!data?.length) return { ok: false, error: "Only the boss can delete payments." };
    return { ok: true, message: "Payment deleted" };
  } catch (e) {
    return fail(e);
  }
}

export async function addExpense(case_id: string, name: string, amt: number | string): Promise<ActionResult> {
  try {
    if (!name.trim() || !amount(amt)) return { ok: false, error: "Enter a name and an amount." };
    if (amount(amt) < 0) return { ok: false, error: "An expense can't be negative. To take one back, delete it." };
    const sb = await createClient();
    const { error } = await sb.from("expenses").insert({ case_id, name: name.trim(), amount: amount(amt) });
    if (error) throw error;
    return { ok: true, message: "Expense added" };
  } catch (e) {
    return fail(e);
  }
}

export async function deleteExpense(id: string): Promise<ActionResult> {
  try {
    const sb = await createClient();
    const { data, error } = await sb.from("expenses").delete().eq("id", id).select("id");
    if (error) throw error;
    if (!data?.length) return { ok: false, error: "Only the boss can delete expenses." };
    return { ok: true, message: "Expense deleted" };
  } catch (e) {
    return fail(e);
  }
}
