"use server";
import { createClient } from "@/lib/supabase/server";
import { fail, type ActionResult } from "@/lib/auth";
import { normPhone, phoneError } from "@/lib/format";

export async function saveSupplier(input: Record<string, unknown> & { id?: string; name: string }): Promise<ActionResult<{ id: string; name: string }>> {
  try {
    if (!String(input.name ?? "").trim()) return { ok: false, error: "Supplier name is required." };
    for (const [k, label] of [["mobile", "Mobile"], ["whatsapp", "WhatsApp number"]] as const) {
      const err = phoneError(input[k] as string);
      if (err) return { ok: false, error: `${label}: ${err}` };
    }
    const row: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(input)) {
      if (["id", "created_at", "updated_at", "created_by"].includes(k)) continue;
      let val = typeof v === "string" ? v.trim() : v;
      if (["mobile", "whatsapp"].includes(k)) val = normPhone(val as string) || null;
      if (["credit_days", "default_commission"].includes(k)) val = Number(val) || 0;
      if (k === "credit_limit") val = val === "" || val === null ? null : Number(val);
      if (val === "") val = null;
      row[k] = val;
    }
    const sb = await createClient();
    if (input.id) {
      const { error } = await sb.from("suppliers").update(row).eq("id", input.id);
      if (error) throw error;
      return { ok: true, data: { id: input.id, name: String(input.name) }, message: "Supplier saved" };
    }
    const { data, error } = await sb.from("suppliers").insert(row).select("id, name").single();
    if (error) throw error;
    return { ok: true, data, message: "Supplier added" };
  } catch (e) {
    return fail(e);
  }
}

export async function deleteSupplier(id: string): Promise<ActionResult> {
  try {
    const sb = await createClient();
    const { data, error } = await sb.from("suppliers").delete().eq("id", id).select("id");
    if (error) {
      if (error.message.includes("foreign key")) return { ok: false, error: "This supplier is used on bookings. Mark it Inactive instead." };
      throw error;
    }
    if (!data?.length) return { ok: false, error: "Only the boss can delete suppliers." };
    return { ok: true, message: "Supplier deleted" };
  } catch (e) {
    return fail(e);
  }
}

export async function saveSupplierNotes(id: string, notes: string): Promise<ActionResult> {
  try {
    const sb = await createClient();
    const { error } = await sb.from("suppliers").update({ notes: notes.trim() || null }).eq("id", id);
    if (error) throw error;
    return { ok: true, message: "Notes saved" };
  } catch (e) {
    return fail(e);
  }
}
