"use server";
import { randomInt } from "node:crypto";
import { createAdmin, createClient } from "@/lib/supabase/server";
import { fail, getMe, type ActionResult } from "@/lib/auth";

async function boss() {
  const me = await getMe();
  if (me?.role !== "boss") throw new Error("Only the boss can change settings.");
  return me;
}

export async function saveSettings(patch: Record<string, unknown>): Promise<ActionResult> {
  try {
    await boss();
    const allowed = ["agency_name", "agency_phone", "agency_email", "agency_address", "app_url", "agency_gstin", "agency_pan", "bank_details", "upi_id", "invoice_prefix", "estimate_valid_days", "auto_reminders", "portal_defaults", "portal_hide_until_confirmed", "portal_allow_uploads"];
    const row = Object.fromEntries(Object.entries(patch).filter(([k]) => allowed.includes(k)));
    const sb = await createClient();
    const { error } = await sb.from("settings").update(row).eq("id", 1);
    if (error) throw error;
    return { ok: true, message: "Settings saved" };
  } catch (e) {
    return fail(e);
  }
}

export async function setMaxStart(n: number): Promise<ActionResult> {
  try {
    await boss();
    const sb = await createClient();
    const { error } = await sb.rpc("set_max_start", { p_start: n });
    if (error) throw error;
    return { ok: true, message: `Next MAX ID will be MAX-${n}` };
  } catch (e) {
    return fail(e);
  }
}

export async function addLookup(kind: string, value: string, extra: Record<string, unknown> = {}): Promise<ActionResult> {
  try {
    await boss();
    if (!value.trim()) return { ok: false, error: "Enter a value." };
    const sb = await createClient();
    const { error } = await sb.from("lookups").insert({ kind, value: value.trim(), extra });
    if (error) throw error.message.includes("duplicate") ? new Error("That value is already in the list.") : error;
    return { ok: true, message: "Added" };
  } catch (e) {
    return fail(e);
  }
}

export async function removeLookup(id: string): Promise<ActionResult> {
  try {
    await boss();
    const sb = await createClient();
    const { error } = await sb.from("lookups").delete().eq("id", id);
    if (error) throw error;
    return { ok: true, message: "Removed" };
  } catch (e) {
    return fail(e);
  }
}

function tempPassword() {
  return `Safar-${randomInt(1000, 9999)}-${randomInt(100, 999)}`;
}

export async function createStaff(v: { full_name: string; email: string; phone?: string; can_see_profit?: boolean; can_see_all_cases?: boolean }): Promise<ActionResult<{ password: string }>> {
  try {
    await boss();
    if (!v.full_name.trim() || !v.email.includes("@")) return { ok: false, error: "Enter a name and a valid email." };
    const admin = createAdmin();
    const password = tempPassword();
    const { data, error } = await admin.auth.admin.createUser({
      email: v.email.trim().toLowerCase(), password, email_confirm: true,
      app_metadata: { role: "staff", full_name: v.full_name.trim(), phone: v.phone ?? null, must_change_password: true },
    });
    if (error) throw error;
    await admin.from("profiles").update({ can_see_profit: !!v.can_see_profit, can_see_all_cases: !!v.can_see_all_cases }).eq("id", data.user.id);
    return { ok: true, data: { password }, message: "Staff login created" };
  } catch (e) {
    return fail(e);
  }
}

export async function updateStaff(id: string, patch: { full_name?: string; can_see_profit?: boolean; can_see_all_cases?: boolean }): Promise<ActionResult> {
  try {
    await boss();
    const sb = await createClient();
    const { error } = await sb.from("profiles").update(patch).eq("id", id);
    if (error) throw error;
    return { ok: true, message: "Saved" };
  } catch (e) {
    return fail(e);
  }
}

export async function deactivateStaff(id: string): Promise<ActionResult> {
  try {
    await boss();
    const sb = await createClient();
    const { error } = await sb.rpc("deactivate_user", { p_user: id });
    if (error) throw error;
    await createAdmin().auth.admin.updateUserById(id, { ban_duration: "876000h" });
    return { ok: true, message: "Login deactivated. Open cases and tasks moved to you." };
  } catch (e) {
    return fail(e);
  }
}

export async function reactivateStaff(id: string): Promise<ActionResult> {
  try {
    await boss();
    const admin = createAdmin();
    await admin.auth.admin.updateUserById(id, { ban_duration: "none" });
    const { error } = await admin.from("profiles").update({ active: true }).eq("id", id);
    if (error) throw error;
    return { ok: true, message: "Login reactivated" };
  } catch (e) {
    return fail(e);
  }
}

export async function resetStaffPassword(id: string): Promise<ActionResult<{ password: string }>> {
  try {
    await boss();
    const admin = createAdmin();
    const password = tempPassword();
    const { error } = await admin.auth.admin.updateUserById(id, { password });
    if (error) throw error;
    await admin.from("profiles").update({ must_change_password: true }).eq("id", id);
    return { ok: true, data: { password }, message: "Temporary password set" };
  } catch (e) {
    return fail(e);
  }
}

export async function runRemindersNow(): Promise<ActionResult> {
  try {
    await boss();
    const admin = createAdmin();
    const { error } = await admin.rpc("run_auto_reminders");
    if (error) throw error;
    const { error: ve } = await admin.rpc("run_visa_reminders");
    if (ve) throw ve;
    // also the 15-minute checks, which close reminders whose reason is gone
    const { error: we } = await admin.rpc("run_workflow_checks");
    if (we) throw we;
    return { ok: true, message: "Automatic reminders checked" };
  } catch (e) {
    return fail(e);
  }
}
