import { randomUUID } from "node:crypto";
import { after, NextResponse } from "next/server";
import { createAdmin, createClient } from "@/lib/supabase/server";
import { getMe } from "@/lib/auth";
import { inspect } from "@/lib/imports/inspect";
import { runImportWorker } from "@/lib/imports/worker";
import { slug } from "@/lib/storage";

const err = (error: string, status = 400, extra: Record<string, unknown> = {}) => NextResponse.json({ error, ...extra }, { status });
const EXT = { "application/pdf": "pdf", "image/jpeg": "jpg", "image/png": "png" } as const;

/** Upload a booked ticket. Staff: optionally scoped to a case, customer or booking. Portal: for themselves or family.
 *  The file is stored privately and a persisted import job is created; extraction runs in the background worker. */
export async function POST(req: Request) {
  const me = await getMe();
  if (!me || me.mfa_pending) return err("Please log in again.", 401);
  const fd = await req.formData();
  const file = fd.get("file");
  if (!(file instanceof File)) return err("No file received.");
  const buf = new Uint8Array(await file.arrayBuffer());
  const ins = inspect(buf);
  if (!ins.ok) return err(ins.message, 400, { code: ins.code });
  const ext = EXT[ins.mime];
  const name = `${slug(file.name.replace(/\.[^.]+$/, "")) || "ticket"}.${ext}`;
  const admin = createAdmin();
  const sb = await createClient();

  let row: Record<string, unknown>;
  if (me.role === "client") {
    if (!me.customer_id) return err("Not allowed.", 403);
    const { data: st } = await admin.from("settings").select("portal_allow_uploads").eq("id", 1).single();
    if (!st?.portal_allow_uploads) return err("Uploads are switched off. Please send the ticket to the office.", 403);
    // for themselves, or someone in their own family (the rule the portal already uses for documents)
    const forId = String(fd.get("for_customer") || "") || me.customer_id;
    if (forId !== me.customer_id) {
      const { data: pair } = await admin.from("customers").select("id, family_id").in("id", [me.customer_id, forId]);
      const mine = pair?.find((x) => x.id === me.customer_id), theirs = pair?.find((x) => x.id === forId);
      if (!mine?.family_id || mine.family_id !== theirs?.family_id) return err("You can send tickets only for yourself or your family.", 403);
    }
    const { data: same } = await admin.from("ticket_imports").select("id").eq("uploaded_by", me.id).eq("sha256", ins.sha256).not("status", "in", "(rejected,failed,duplicate)").maybeSingle();
    if (same) return NextResponse.json({ id: same.id, duplicate: true, message: "We already have this file. The office will review it." });
    row = { channel: "portal", customer_id: forId, uploaded_by: me.id };
  } else {
    const caseId = String(fd.get("case_id") || "") || null;
    const customerId = String(fd.get("customer_id") || "") || null;
    const lineId = String(fd.get("line_id") || "") || null;
    if (caseId) {
      const { data: c } = await sb.from("cases").select("id").eq("id", caseId).maybeSingle();
      if (!c) return err("Case not found.", 404);
    }
    if (customerId) {
      const { data: c } = await sb.from("customers").select("id").eq("id", customerId).maybeSingle();
      if (!c) return err("Customer not found.", 404);
    }
    if (lineId) {
      const { data: l } = await sb.from("booking_lines").select("id, case_id").eq("id", lineId).maybeSingle();
      if (!l || (caseId && l.case_id !== caseId)) return err("Booking not found.", 404);
    }
    // the same file already imported somewhere this person may see
    const { data: dup } = await sb.rpc("find_import_by_checksum", { p_sha256: ins.sha256 });
    const existing = (dup ?? []) as { id: string; status: string }[];
    if (existing.length && !fd.get("replaces")) {
      return NextResponse.json({ id: existing[0].id, duplicate: true, message: "This exact file was already uploaded. Opening that import." });
    }
    row = { channel: "staff", case_id: caseId, customer_id: customerId, booking_line_id: lineId, uploaded_by: me.id };
  }

  const path = `imports/${randomUUID()}.${ext}`;
  const { error: up } = await admin.storage.from("files").upload(path, buf, { contentType: ins.mime, upsert: false });
  if (up) return err("The file could not be stored. Please try again.", 500);
  const insert = { ...row, storage_path: path, file_name: name, mime: ins.mime, size: buf.length, pages: ins.pages, sha256: ins.sha256 };
  // staff inserts go through row-level security; portal submissions are checked above and written by the server
  const { data: created, error } = me.role === "client"
    ? await admin.from("ticket_imports").insert(insert).select("id").single()
    : await sb.from("ticket_imports").insert(insert).select("id").single();
  if (error || !created) {
    await admin.storage.from("files").remove([path]);   // never leave an orphaned upload behind
    if (error?.code === "23505") {
      const { data: same } = await admin.from("ticket_imports").select("id").eq("uploaded_by", me.id).eq("sha256", ins.sha256).not("status", "in", "(rejected,failed,duplicate)").maybeSingle();
      if (same) return NextResponse.json({ id: same.id, duplicate: true, message: "This file was just uploaded. Opening that import." });
    }
    return err(error?.message?.includes("row-level security") ? "You can't import into that case." : "The import could not be created. Please try again.", 500);
  }

  const replaces = String(fd.get("replaces") || "");
  if (replaces && me.role !== "client") {
    const { error: re } = await sb.rpc("replace_ticket_import", { p_old: replaces, p_new: created.id });
    if (re) return err("Uploaded, but it could not replace the earlier import. Open both and reject the one you don't need.", 409, { id: created.id });
  }

  if (me.role === "client") {
    const { data: cu } = await admin.from("customers").select("full_name, assigned_to").eq("id", row.customer_id as string).single();
    const { data: boss } = await admin.from("profiles").select("id").eq("role", "boss").eq("active", true);
    const notify = new Set([cu?.assigned_to, ...(boss ?? []).map((b) => b.id)].filter(Boolean) as string[]);
    if (notify.size) {
      await admin.from("notifications").insert([...notify].map((user_id) => ({
        user_id, title: `${cu?.full_name ?? "A client"} sent a ticket`, body: "Waiting for review", link: `/imports/${created.id}`,
      })));
    }
  }

  // start reading right away; if this is cut short the job stays queued and the scheduled worker picks it up
  after(async () => { try { await runImportWorker({ limit: 1 }); } catch { /* queued for the next run */ } });
  return NextResponse.json({ id: created.id, duplicate: false });
}
