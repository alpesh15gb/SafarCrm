"use server";
import { createAdmin, createClient } from "@/lib/supabase/server";
import { fail, type ActionResult } from "@/lib/auth";
import { sendMessage, type SendLine } from "@/lib/send-templates";

export async function setFileVisible(id: string, visible: boolean): Promise<ActionResult> {
  try {
    const sb = await createClient();
    const { error } = await sb.from("files").update({ visible_to_client: visible }).eq("id", id);
    if (error) throw error;
    return { ok: true, message: visible ? "Visible to client" : "Hidden from client" };
  } catch (e) {
    return fail(e);
  }
}

export async function deleteFile(id: string): Promise<ActionResult> {
  try {
    const sb = await createClient();
    const { data, error } = await sb.from("files").delete().eq("id", id).select("storage_path");
    if (error) throw error;
    if (!data?.length) return { ok: false, error: "Only the boss can delete files." };
    // the same object may be shared with a customer document; only remove it if nothing else points at it
    const path = data[0].storage_path;
    const admin = createAdmin();
    const [{ count: f }, { count: d }, { count: i }] = await Promise.all([
      admin.from("files").select("id", { count: "exact", head: true }).eq("storage_path", path),
      admin.from("customer_documents").select("id", { count: "exact", head: true }).eq("storage_path", path),
      // a confirmed ticket import keeps its original as evidence
      admin.from("ticket_imports").select("id", { count: "exact", head: true }).eq("storage_path", path),
    ]);
    if (!f && !d && !i) await admin.storage.from("files").remove([path]);
    return { ok: true, message: "File deleted" };
  } catch (e) {
    return fail(e);
  }
}

/** Creates a 7-day share link. Returns the full URL. */
export async function createShareLink(fileId: string): Promise<ActionResult<{ url: string; file_name: string }>> {
  try {
    const sb = await createClient();
    const { data: f } = await sb.from("files").select("id, file_name").eq("id", fileId).maybeSingle();
    if (!f) return { ok: false, error: "File not found." };
    const { data, error } = await sb.from("share_links").insert({ file_id: fileId }).select("token").single();
    if (error) throw error;
    const { data: s } = await sb.from("settings").select("app_url").eq("id", 1).single();
    const base = (s?.app_url || process.env.NEXT_PUBLIC_APP_URL || "").replace(/\/$/, "");
    return { ok: true, data: { url: `${base}/s/${encodeURIComponent(data.token)}`, file_name: f.file_name } };
  } catch (e) {
    return fail(e);
  }
}

/** Attach a customer master document to a case without uploading it again. */
export async function attachDocument(caseId: string, docId: string): Promise<ActionResult> {
  try {
    const sb = await createClient();
    const [{ data: doc }, { data: c }] = await Promise.all([
      sb.from("customer_documents").select("id, doc_type, storage_path, file_name, mime, size, customer:customers(full_name)").eq("id", docId).single(),
      sb.from("cases").select("max_id").eq("id", caseId).single(),
    ]);
    if (!doc?.storage_path || !c) return { ok: false, error: "That document has no file." };
    const ext = (doc.file_name ?? "").split(".").pop() || "pdf";
    const who = ((doc.customer as unknown as { full_name: string } | null)?.full_name ?? "").replace(/[^A-Za-z0-9]+/g, "-");
    const { error } = await sb.from("files").insert({
      case_id: caseId, storage_path: doc.storage_path, original_name: doc.file_name, mime: doc.mime, size: doc.size,
      file_name: `${c.max_id}_${doc.doc_type.replace(/[^A-Za-z0-9]+/g, "-")}_${who}.${ext}`,
      kind: "document", visible_to_client: false, source_document_id: doc.id,
    });
    if (error) throw error;
    return { ok: true, message: "Document attached to the case" };
  } catch (e) {
    return fail(e);
  }
}

/** Sends a file straight to the client: the PDF itself on WhatsApp (Evolution API) or as an email attachment.
 *  `to` defaults to the case customer's WhatsApp/mobile or email. Not configured → code "not_configured", and the
 *  screen falls back to sharing a link. */
export async function sendFileToClient(fileId: string, channel: "whatsapp" | "email", to?: string): Promise<ActionResult> {
  try {
    const sb = await createClient();
    // read through row-level security: only someone who may see the file can send it
    const { data: f } = await sb.from("files")
      .select("id, file_name, original_name, mime, kind, storage_path, case_id, line:booking_lines(service, status, details, service_date, reference), case:cases(max_id, customer:customers!cases_customer_id_fkey(id, full_name, mobile, whatsapp, email))")
      .eq("id", fileId).maybeSingle();
    if (!f) return { ok: false, error: "File not found." };
    const kase = f.case as unknown as { max_id: string; customer: { id: string; full_name: string; mobile: string; whatsapp: string | null; email: string | null } | null } | null;
    const cust = kase?.customer ?? null;
    const dest = (to ?? (channel === "whatsapp" ? cust?.whatsapp || cust?.mobile : cust?.email) ?? "").trim();
    if (!dest) return { ok: false, error: channel === "whatsapp" ? "The client has no mobile number." : "The client has no email address. Add it on their profile." };
    const { whatsappConfigured, emailConfigured, sendWhatsAppDocument, sendEmailWithAttachment } = await import("@/lib/send");
    if (channel === "whatsapp" ? !whatsappConfigured() : !emailConfigured()) return { ok: false, error: "not_configured" };
    const { data: blob, error: de } = await createAdmin().storage.from("files").download(f.storage_path);
    if (de || !blob) return { ok: false, error: "The file could not be read from storage." };
    const bytes = new Uint8Array(await blob.arrayBuffer());
    const first = cust?.full_name.split(" ")[0] ?? "";
    const { data: st } = await sb.from("settings").select("agency_name, agency_phone, agency_email").eq("id", 1).single();
    // the confirmation message in the owner's format (FLIGHT BOOKING CONFIRMATION · Dear … · BOOKING CONFIRMED · details ·
    // 📎 attached · Thank you for booking with …), worded for the booking the file belongs to
    const msg = sendMessage({
      kind: f.kind, line: (f.line ?? null) as unknown as SendLine, customer: cust?.full_name ?? "",
      maxId: kase?.max_id ?? null, agency: { name: st?.agency_name || "", phone: st?.agency_phone, email: st?.agency_email },
    });
    const r = channel === "whatsapp"
      ? await sendWhatsAppDocument(dest, { bytes, mime: f.mime, name: f.file_name }, msg.whatsapp)
      : await sendEmailWithAttachment(dest, msg.subject, msg.html, { bytes, name: f.file_name });
    if (!r.ok) return { ok: false, error: r.code === "not_configured" ? "not_configured" : r.message };
    if (f.case_id) await sb.rpc("log_file_sent", { p_file: f.id, p_channel: channel, p_to: dest }).then(() => {}, () => {});
    return { ok: true, message: channel === "whatsapp" ? `Sent on WhatsApp to ${first || dest}` : `Emailed to ${dest}` };
  } catch (e) {
    return fail(e);
  }
}
