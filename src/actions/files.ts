"use server";
import { createAdmin, createClient } from "@/lib/supabase/server";
import { fail, type ActionResult } from "@/lib/auth";

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
    const [{ count: f }, { count: d }] = await Promise.all([
      admin.from("files").select("id", { count: "exact", head: true }).eq("storage_path", path),
      admin.from("customer_documents").select("id", { count: "exact", head: true }).eq("storage_path", path),
    ]);
    if (!f && !d) await admin.storage.from("files").remove([path]);
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
