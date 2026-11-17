"use server";
import { createClient } from "@/lib/supabase/server";
import { fail, getMe, type ActionResult } from "@/lib/auth";
import { moneyProblem, strictAmount } from "@/lib/money";

type PayIn = { case_id: string; pay_date: string; amount: number | string; refund?: boolean; mode: string; account_id?: string | null; reference?: string; received_by?: string; notes?: string };

export async function addClientPayment(p: PayIn): Promise<ActionResult> {
  try {
    const problem = moneyProblem("Amount", p.amount, { required: true, allowNegative: true });
    if (problem) return { ok: false, error: problem };
    const entered = strictAmount(p.amount);
    const paid = p.refund === undefined ? entered : (p.refund ? -1 : 1) * Math.abs(entered);
    if (!paid) return { ok: false, error: "Enter an amount greater than zero." };
    const me = await getMe();
    const sb = await createClient();
    const { data: before } = await sb.from("cases").select("status").eq("id", p.case_id).maybeSingle();
    const { error } = await sb.from("payments").insert({
      direction: "in", case_id: p.case_id, pay_date: p.pay_date, amount: paid, mode: p.mode, account_id: p.account_id || null,
      reference: p.reference?.trim() || null, received_by: p.received_by || me?.id, notes: p.notes?.trim() || null,
    });
    if (error) throw error;
    // the payment may have moved the case on: say so
    const { data: after } = await sb.from("cases").select("status, max_id").eq("id", p.case_id).maybeSingle();
    const moved = after && before && after.status !== before.status
      ? after.status === "completed" ? `. ${after.max_id} is complete: booked and fully paid.` : `. ${after.max_id} moved to ${after.status.charAt(0).toUpperCase()}${after.status.slice(1)}.`
      : "";
    return { ok: true, message: `${paid < 0 ? "Refund recorded" : "Payment recorded"}${moved}` };
  } catch (e) {
    return fail(e);
  }
}

type PayOut = { supplier_id: string; pay_date: string; amount: number | string; refund?: boolean; mode: string; account_id?: string | null; reference?: string; notes?: string; allocations: { case_id: string; amount: number | string }[] };

export async function addSupplierPayment(p: PayOut): Promise<ActionResult> {
  try {
    const problem = moneyProblem("Amount", p.amount, { required: true, allowNegative: true });
    if (problem) return { ok: false, error: problem };
    const entered = strictAmount(p.amount);
    const paid = p.refund === undefined ? entered : (p.refund ? -1 : 1) * Math.abs(entered);
    if (!paid) return { ok: false, error: "Enter an amount greater than zero." };
    for (const allocation of p.allocations) {
      const allocationProblem = moneyProblem("MAX ID amount", allocation.amount, { allowNegative: true });
      if (allocationProblem) return { ok: false, error: allocationProblem };
    }
    const alloc = p.allocations.map((a) => ({ case_id: a.case_id, amount: strictAmount(a.amount) })).filter((a) => a.amount !== 0);
    const sum = alloc.reduce((s, a) => s + a.amount, 0);
    // the rest (if any) is an advance with the supplier
    // a refund from a supplier is a negative payment, put against the case as a negative amount
    if (Math.abs(sum) - Math.abs(paid) > 0.009) return { ok: false, error: `The MAX ID amounts add up to ₹${sum}, more than the payment of ₹${paid}.` };
    const sb = await createClient();
    // payment + allocations in one database transaction (all or nothing)
    const { data: pid, error } = await sb.rpc("record_supplier_payment", {
      p_supplier: p.supplier_id, p_date: p.pay_date || null, p_amount: paid, p_mode: p.mode,
      p_reference: p.reference ?? null, p_notes: p.notes ?? null,
      p_allocations: alloc,
    });
    if (error) throw error;
    if (p.account_id && pid) {
      const { error: ae } = await sb.rpc("set_payment_account", { p_payment: pid, p_account: p.account_id });
      if (ae) return { ok: true, message: "Supplier payment recorded, but the account could not be set on it. Set it on the payment." };
    }
    return { ok: true, message: "Supplier payment recorded" };
  } catch (e) {
    return fail(e);
  }
}

/** Put part of a supplier's advance against what this case owes them (oldest payment first). */
export async function useSupplierAdvance(supplierId: string, caseId: string, amt: number): Promise<ActionResult> {
  try {
    const sb = await createClient();
    const { data, error } = await sb.rpc("use_supplier_advance", { p_supplier: supplierId, p_case: caseId, p_amount: amt });
    if (error) throw error;
    return { ok: true, message: `Advance of ₹${Number(data).toLocaleString("en-IN")} used on this case` };
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
    const problem = moneyProblem("Expense amount", amt, { required: true, allowNegative: true });
    if (problem) return { ok: false, error: problem };
    const expense = strictAmount(amt);
    if (!name.trim() || !expense) return { ok: false, error: "Enter a name and an amount." };
    if (expense < 0) return { ok: false, error: "An expense can't be negative. To take one back, delete it." };
    const sb = await createClient();
    const { error } = await sb.from("expenses").insert({ case_id, name: name.trim(), amount: expense });
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

// ---------------------------------------------------------------- money accounts (owner, 2026-11-18)
export type MoneyAccount = { id: string; name: string; kind: "bank" | "card" | "cash" | "upi"; last4: string | null; active: boolean };

/** Active accounts for the "Received into" / "Paid from" pickers. */
export async function listMoneyAccounts(): Promise<MoneyAccount[]> {
  const sb = await createClient();
  const { data } = await sb.from("money_accounts").select("id, name, kind, last4, active").eq("active", true).order("sort").order("name");
  return (data ?? []) as MoneyAccount[];
}

/** Add or change a bank account, credit card, cash or UPI account. Boss only (checked in the database too). */
export async function saveMoneyAccount(a: { id?: string; name: string; kind: string; last4?: string; opening_balance?: string; opening_date?: string }): Promise<ActionResult> {
  try {
    const me = await getMe();
    if (me?.role !== "boss") return { ok: false, error: "Only the boss can set up accounts." };
    if (!a.name.trim()) return { ok: false, error: "Give the account a name, e.g. HDFC current account." };
    if (!["bank", "card", "cash", "upi"].includes(a.kind)) return { ok: false, error: "Choose what kind of account it is." };
    const last4 = (a.last4 ?? "").replace(/\D/g, "");
    if (last4 && last4.length !== 4) return { ok: false, error: "Last 4 digits: exactly 4 numbers, or leave it empty." };
    const bad = moneyProblem("Opening balance", a.opening_balance, { allowNegative: true });
    if (bad) return { ok: false, error: bad };
    const row = {
      name: a.name.trim(), kind: a.kind, last4: last4 || null, opening_balance: strictAmount(a.opening_balance),
      ...(a.opening_date ? { opening_date: a.opening_date } : {}),
    };
    const sb = await createClient();
    const { error } = a.id ? await sb.from("money_accounts").update(row).eq("id", a.id) : await sb.from("money_accounts").insert(row);
    if (error) throw error;
    return { ok: true, message: a.id ? "Account saved" : "Account added" };
  } catch (e) {
    return fail(e);
  }
}

export async function setMoneyAccountActive(id: string, active: boolean): Promise<ActionResult> {
  try {
    const sb = await createClient();
    const { data, error } = await sb.from("money_accounts").update({ active }).eq("id", id).select("id");
    if (error) throw error;
    if (!data?.length) return { ok: false, error: "Only the boss can change accounts." };
    return { ok: true, message: active ? "Account in use again" : "Account hidden from the pickers; its history stays" };
  } catch (e) {
    return fail(e);
  }
}
