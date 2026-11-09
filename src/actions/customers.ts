"use server";
import { randomInt } from "node:crypto";
import { createAdmin, createClient } from "@/lib/supabase/server";
import { fail, getMe, type ActionResult } from "@/lib/auth";
import { normPhone, portalCodeEmail, portalEmail, waLink, phoneError } from "@/lib/format";

const PHONE_KEYS = ["mobile", "alt_mobile", "whatsapp", "emergency_mobile"];
const DATE_KEYS = ["dob", "anniversary", "dl_expiry", "passport_issue", "passport_expiry", "consent_date"];
const BLOCKED = new Set(["id", "code", "full_name", "created_at", "updated_at", "created_by", "aadhaar_enc", "aadhaar_hash", "aadhaar_last4", "pan_enc", "pan_hash", "passport_enc", "passport_hash", "aadhaar", "pan", "passport_number"]);

export type CustomerInput = Record<string, unknown> & { id?: string; first_name: string; mobile: string; aadhaar?: string; pan?: string; passport_number?: string };

export async function checkDuplicates(mobile: string, aadhaar?: string, passport?: string, exclude?: string) {
  const sb = await createClient();
  const { data } = await sb.rpc("find_duplicates", { p_mobile: mobile, p_aadhaar: aadhaar || null, p_passport: passport || null, p_exclude: exclude || null });
  return (data ?? []) as { id: string; code: string; full_name: string; mobile: string; matched: string }[];
}

export async function saveCustomer(input: CustomerInput): Promise<ActionResult<{ id: string }>> {
  try {
    if (!String(input.first_name ?? "").trim()) return { ok: false, error: "Name is required." };
    if (!String(input.mobile ?? "").trim()) return { ok: false, error: "Mobile is required." };
    const PHONE_LABEL: Record<string, string> = { mobile: "Mobile", alt_mobile: "Alternate mobile", whatsapp: "WhatsApp number", emergency_mobile: "Emergency contact mobile" };
    for (const k of PHONE_KEYS) {
      const err = phoneError((input as Record<string, unknown>)[k] as string);
      if (err) return { ok: false, error: `${PHONE_LABEL[k]}: ${err}` };
    }
    const row: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(input)) {
      if (BLOCKED.has(k)) continue;
      let val = typeof v === "string" ? v.trim() : v;
      if (PHONE_KEYS.includes(k)) val = normPhone(val as string) || null;
      if (DATE_KEYS.includes(k) || k.endsWith("_id") || k === "assigned_to") val = val || null;
      if (val === "") val = null;
      row[k] = val;
    }
    if (row.passport_surname) row.passport_surname = String(row.passport_surname).toUpperCase();
    if (row.passport_given_name) row.passport_given_name = String(row.passport_given_name).toUpperCase();
    const sb = await createClient();
    let id = input.id;
    if (id) {
      const { error } = await sb.from("customers").update(row).eq("id", id);
      if (error) throw error;
    } else {
      const { data, error } = await sb.from("customers").insert(row).select("id").single();
      if (error) throw error;
      id = data.id;
    }
    if (input.aadhaar !== undefined || input.pan !== undefined || input.passport_number !== undefined) {
      const { error } = await sb.rpc("set_customer_ids", {
        p_customer: id, p_aadhaar: input.aadhaar ?? null, p_pan: input.pan ?? null, p_passport: input.passport_number ?? null,
      });
      if (error) throw error;
    }
    return { ok: true, data: { id: id! }, message: input.id ? "Customer saved" : "Customer added" };
  } catch (e) {
    return fail(e);
  }
}

export async function getCustomerIds(id: string) {
  const sb = await createClient();
  const { data } = await sb.rpc("get_customer_ids", { p_customer: id });
  return (data?.[0] ?? { aadhaar_masked: null, pan: null, passport: null }) as { aadhaar_masked: string | null; pan: string | null; passport: string | null };
}

export async function revealAadhaar(id: string): Promise<ActionResult<string>> {
  try {
    const sb = await createClient();
    const { data, error } = await sb.rpc("reveal_aadhaar", { p_customer: id });
    if (error) throw error;
    return { ok: true, data: data ?? "Not on file" };
  } catch (e) {
    return fail(e);
  }
}

export async function deleteCustomer(id: string): Promise<ActionResult> {
  try {
    const sb = await createClient();
    // remember their uploaded scans (passport, Aadhaar...) so they can be removed from storage too
    const [{ data: docs }, { data: cu }] = await Promise.all([
      sb.from("customer_documents").select("storage_path").eq("customer_id", id),
      sb.from("customers").select("photo_path").eq("id", id).maybeSingle(),
    ]);
    const { data, error } = await sb.from("customers").delete().eq("id", id).select("id");
    if (error) {
      if (error.message.includes("foreign key")) return { ok: false, error: "This customer has cases. Delete or move those first." };
      throw error;
    }
    if (!data?.length) return { ok: false, error: "Only the boss can delete customers." };
    const paths = [...new Set([...(docs ?? []).map((d) => d.storage_path), cu?.photo_path].filter(Boolean) as string[])];
    if (paths.length) {
      const admin = createAdmin();
      // a scan attached to someone else's case is still in use there: keep it
      const { data: used } = await admin.from("files").select("storage_path").in("storage_path", paths);
      const keep = new Set((used ?? []).map((f) => f.storage_path));
      const gone = paths.filter((p) => !keep.has(p));
      if (gone.length) await admin.storage.from("files").remove(gone);
    }
    return { ok: true, message: "Customer deleted" };
  } catch (e) {
    return fail(e);
  }
}

/** Put a customer into a family (existing id, or create one with the given name). */
export async function setFamily(customerId: string, familyId: string | null, newName?: string): Promise<ActionResult<{ family_id: string | null }>> {
  try {
    const sb = await createClient();
    let fid = familyId;
    if (!fid && newName?.trim()) {
      const { data, error } = await sb.from("families").insert({ name: newName.trim() }).select("id").single();
      if (error) throw error;
      fid = data.id;
    }
    const { error } = await sb.from("customers").update({ family_id: fid }).eq("id", customerId);
    if (error) throw error;
    return { ok: true, data: { family_id: fid }, message: fid ? "Linked to family" : "Removed from family" };
  } catch (e) {
    return fail(e);
  }
}

export async function saveDocumentMeta(id: string, v: { doc_type: string; number?: string; expiry?: string; note?: string; status?: string }): Promise<ActionResult> {
  try {
    const sb = await createClient();
    const { error } = await sb.from("customer_documents").update({
      doc_type: v.doc_type, expiry: v.expiry || null, note: v.note?.trim() || null, ...(v.status ? { status: v.status } : {}),
    }).eq("id", id);
    if (error) throw error;
    if (v.number !== undefined) {
      const { error: ne } = await sb.rpc("set_document_number", { p_doc: id, p_number: v.number });
      if (ne) throw ne;
    }
    return { ok: true, message: "Document saved" };
  } catch (e) {
    return fail(e);
  }
}

export async function deleteDocument(id: string): Promise<ActionResult> {
  try {
    const sb = await createClient();
    const { data, error } = await sb.from("customer_documents").delete().eq("id", id).select("storage_path");
    if (error) throw error;
    if (!data?.length) return { ok: false, error: "Only the boss can delete documents." };
    const path = data[0].storage_path;
    if (path) {
      const admin = createAdmin();
      const { count } = await admin.from("files").select("id", { count: "exact", head: true }).eq("storage_path", path);
      if (!count) await admin.storage.from("files").remove([path]);
    }
    return { ok: true, message: "Document deleted" };
  } catch (e) {
    return fail(e);
  }
}

function tempPassword() {
  const words = ["Goa", "Taj", "Kochi", "Leh", "Ooty", "Puri", "Agra", "Diu"];
  return `${words[randomInt(words.length)]}-${randomInt(1000, 9999)}-${randomInt(10, 99)}`;
}

/** Boss only: create (or reset) the client's portal login and prepare the WhatsApp message. */
export async function inviteToPortal(customerId: string): Promise<ActionResult<{ login: string; password: string; wa: string; text: string }>> {
  try {
    const me = await getMe();
    if (me?.role !== "boss") return { ok: false, error: "Only the boss can invite clients to the portal." };
    const sb = await createClient();
    const { data: c } = await sb.from("customers").select("id, code, full_name, first_name, mobile, whatsapp").eq("id", customerId).single();
    if (!c) return { ok: false, error: "Customer not found." };
    const { data: s } = await sb.from("settings").select("agency_name, app_url").eq("id", 1).single();
    const admin = createAdmin();
    const password = tempPassword();
    const meta = { role: "client", full_name: c.full_name, customer_id: c.id, must_change_password: true };

    const { data: existing } = await admin.from("profiles").select("id, email").eq("customer_id", c.id).eq("role", "client").maybeSingle();
    let email: string;
    if (existing) {
      email = existing.email!;
      const { error } = await admin.auth.admin.updateUserById(existing.id, { password, app_metadata: meta, ban_duration: "none" });
      if (error) throw error;
      await admin.from("profiles").update({ active: true, must_change_password: true }).eq("id", existing.id);
    } else {
      email = portalEmail(c.mobile);
      let res = await admin.auth.admin.createUser({ email, password, email_confirm: true, app_metadata: meta });
      if (res.error && /already|exists|registered/i.test(res.error.message)) {
        email = portalCodeEmail(c.code); // mobile shared with a family member: log in with the customer code
        res = await admin.auth.admin.createUser({ email, password, email_confirm: true, app_metadata: meta });
      }
      if (res.error) throw res.error;
    }
    const login = email.startsWith("m") && email === portalEmail(c.mobile) ? c.mobile : c.code;
    const url = (s?.app_url || process.env.NEXT_PUBLIC_APP_URL || "").replace(/\/$/, "") + "/login";
    const text = `Namaste ${c.first_name}, your ${s?.agency_name ?? "travel"} trip portal is ready.\n\nOpen: ${url}\nLogin: ${login}\nTemporary password: ${password}\n\nYou'll be asked to set your own password the first time.`;
    return { ok: true, data: { login, password, wa: waLink(c.whatsapp || c.mobile, text), text }, message: "Portal login ready" };
  } catch (e) {
    return fail(e);
  }
}

export async function revokePortal(customerId: string): Promise<ActionResult> {
  try {
    const me = await getMe();
    if (me?.role !== "boss") return { ok: false, error: "Only the boss can do this." };
    const admin = createAdmin();
    const { data: p } = await admin.from("profiles").select("id").eq("customer_id", customerId).eq("role", "client").maybeSingle();
    if (!p) return { ok: false, error: "This customer has no portal login." };
    await admin.auth.admin.updateUserById(p.id, { ban_duration: "876000h" });
    await admin.from("profiles").update({ active: false }).eq("id", p.id);
    return { ok: true, message: "Portal access switched off" };
  } catch (e) {
    return fail(e);
  }
}

export async function linkCompany(customerId: string, companyId: string | null): Promise<ActionResult> {
  try {
    const sb = await createClient();
    const { data: co } = companyId ? await sb.from("customers").select("company_name, full_name").eq("id", companyId).single() : { data: null };
    const { error } = await sb.from("customers").update({ company_id: companyId, company_name: co ? co.company_name || co.full_name : null }).eq("id", customerId);
    if (error) throw error;
    return { ok: true, message: companyId ? "Linked to company" : "Unlinked" };
  } catch (e) {
    return fail(e);
  }
}
