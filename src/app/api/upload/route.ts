import { randomUUID } from "node:crypto";
import { NextResponse } from "next/server";
import { createAdmin, createClient } from "@/lib/supabase/server";
import { getMe } from "@/lib/auth";
import { EXT, MAX_BYTES, slug, sniff } from "@/lib/storage";
import { SERVICE_LABEL, type Service } from "@/lib/constants";
import { fdate } from "@/lib/format";

const err = (error: string, status = 400) => NextResponse.json({ error }, { status });

function lineLabel(service: Service, d: Record<string, unknown>) {
  const sectors = (d.sectors as { from?: string; to?: string }[]) ?? [];
  switch (service) {
    case "flight":
      if (!sectors.length) return "";
      return d.trip_type === "return" || sectors.length === 1 ? `${sectors[0].from}-${sectors[0].to}` : [sectors[0].from, ...sectors.map((s) => s.to)].join("-");
    case "hotel": return slug(d.hotel_name);
    case "insurance": return slug(d.insurer);
    case "visa": return slug(d.country);
    case "rail": case "bus": return `${slug(d.from)}-${slug(d.to)}`;
    default: return slug(d.title);
  }
}

export async function POST(req: Request) {
  const me = await getMe();
  if (!me || me.mfa_pending) return err("Please log in again.", 401);
  const fd = await req.formData();
  const file = fd.get("file");
  if (!(file instanceof File)) return err("No file received.");
  if (file.size > MAX_BYTES) return err("Files must be 10 MB or smaller.");
  const buf = new Uint8Array(await file.arrayBuffer());
  const mime = sniff(buf);
  if (!mime) return err("Only PDF, JPG or PNG files can be uploaded.");
  const ext = EXT[mime];
  const target = String(fd.get("target") ?? "");
  const sb = await createClient();
  const admin = createAdmin();

  const put = async (path: string) => {
    const { error } = await admin.storage.from("files").upload(path, buf, { contentType: mime, upsert: false });
    if (error) throw error;
  };

  try {
    // ------------------------------------------------ case and booking-line files (team)
    if (target === "case" || target === "line") {
      if (me.role === "client") return err("Not allowed.", 403);
      const caseId = String(fd.get("case_id") ?? "");
      const { data: c } = await sb.from("cases").select("id, max_id").eq("id", caseId).maybeSingle();
      if (!c) return err("Case not found.", 404);
      let base = `${c.max_id}`;
      let lineId: string | null = null;
      let kind = String(fd.get("kind") || "other");
      if (target === "line") {
        const { data: l } = await sb.from("booking_lines").select("id, service, details, service_date").eq("id", String(fd.get("line_id"))).eq("case_id", caseId).maybeSingle();
        if (!l) return err("Booking not found.", 404);
        lineId = l.id;
        base = [c.max_id, SERVICE_LABEL[l.service as Service], lineLabel(l.service as Service, l.details ?? {}), l.service_date ? fdate(l.service_date) : ""].filter(Boolean).join("_");
      } else {
        base = [c.max_id, kind === "other" ? slug(file.name.replace(/\.[^.]+$/, "")) : kind[0].toUpperCase() + kind.slice(1)].filter(Boolean).join("_");
      }
      const replaces = String(fd.get("replaces") ?? "");
      const { data: existing } = await sb.from("files").select("file_name").eq("case_id", caseId);
      const names = new Set((existing ?? []).map((f) => f.file_name));
      let name = `${base}.${ext}`;
      for (let i = 2; names.has(name); i++) name = `${base}_${replaces ? "v" : ""}${i}.${ext}`;
      let visible = ["ticket", "voucher", "policy"].includes(kind);
      if (replaces) {
        const { data: old } = await sb.from("files").select("id, kind, visible_to_client").eq("id", replaces).eq("case_id", caseId).maybeSingle();
        if (!old) return err("The file being replaced was not found.", 404);
        kind = old.kind; visible = old.visible_to_client;
      }
      const path = `cases/${caseId}/${randomUUID()}.${ext}`;
      await put(path);
      const { data: row, error } = await sb.from("files").insert({
        case_id: caseId, booking_line_id: lineId, storage_path: path, file_name: name, original_name: file.name, mime, size: file.size, kind, visible_to_client: visible,
      }).select("id, file_name").single();
      if (error) { await admin.storage.from("files").remove([path]); throw error; }
      if (replaces) {
        // superseding hides the old version from the client; done with the service role because only the boss may change visibility
        await admin.from("files").update({ superseded_at: new Date().toISOString(), superseded_by: row.id, visible_to_client: false }).eq("id", replaces);
      }
      return NextResponse.json(row);
    }

    // ------------------------------------------------ customer master documents (team)
    if (target === "customer_doc") {
      if (me.role === "client") return err("Not allowed.", 403);
      const customerId = String(fd.get("customer_id") ?? "");
      const { data: cu } = await sb.from("customers").select("id, code, full_name").eq("id", customerId).maybeSingle();
      if (!cu) return err("Customer not found.", 404);
      const docType = String(fd.get("doc_type") || "Other");
      const path = `customers/${customerId}/${randomUUID()}.${ext}`;
      await put(path);
      const fileName = `${cu.code}_${slug(cu.full_name)}_${slug(docType)}.${ext}`;
      const { data: row, error } = await sb.from("customer_documents").insert({
        customer_id: customerId, doc_type: docType, storage_path: path, file_name: fileName, mime, size: file.size,
        expiry: String(fd.get("expiry") || "") || null, note: String(fd.get("note") || "") || null,
      }).select("id, file_name").single();
      if (error) { await admin.storage.from("files").remove([path]); throw error; }
      const number = String(fd.get("number") || "");
      if (number) await sb.rpc("set_document_number", { p_doc: row.id, p_number: number });
      return NextResponse.json(row);
    }

    // ------------------------------------------------ supplier agreements and rate sheets (team)
    if (target === "supplier") {
      if (me.role === "client") return err("Not allowed.", 403);
      const supplierId = String(fd.get("supplier_id") ?? "");
      const { data: s } = await sb.from("suppliers").select("id, name").eq("id", supplierId).maybeSingle();
      if (!s) return err("Supplier not found.", 404);
      const kind = ["agreement", "rate_sheet"].includes(String(fd.get("kind"))) ? String(fd.get("kind")) : "other";
      const path = `suppliers/${supplierId}/${randomUUID()}.${ext}`;
      await put(path);
      const { data: row, error } = await sb.from("files").insert({
        supplier_id: supplierId, storage_path: path, file_name: `${slug(s.name)}_${slug(file.name.replace(/\.[^.]+$/, ""))}.${ext}`, original_name: file.name, mime, size: file.size, kind,
      }).select("id, file_name").single();
      if (error) { await admin.storage.from("files").remove([path]); throw error; }
      return NextResponse.json(row);
    }

    // ------------------------------------------------ client uploads from the portal (pending review)
    if (target === "portal_doc") {
      if (me.role !== "client" || !me.customer_id) return err("Not allowed.", 403);
      const { data: st } = await admin.from("settings").select("portal_allow_uploads").eq("id", 1).single();
      if (!st?.portal_allow_uploads) return err("Uploads are switched off. Please send documents to the office.", 403);
      // a client may upload for themselves or for someone in their own family
      const forId = String(fd.get("for_customer") || "") || me.customer_id;
      if (forId !== me.customer_id) {
        const { data: pair } = await admin.from("customers").select("id, family_id").in("id", [me.customer_id, forId]);
        const mine = pair?.find((x) => x.id === me.customer_id), theirs = pair?.find((x) => x.id === forId);
        if (!mine?.family_id || mine.family_id !== theirs?.family_id) return err("You can upload only for yourself or your family.", 403);
      }
      const { data: cu } = await admin.from("customers").select("id, code, full_name, assigned_to").eq("id", forId).single();
      const docType = String(fd.get("doc_type") || "Other");
      const path = `customers/${cu!.id}/${randomUUID()}.${ext}`;
      await put(path);
      const { data: row, error } = await admin.from("customer_documents").insert({
        customer_id: cu!.id, doc_type: docType, storage_path: path, file_name: `${cu!.code}_${slug(cu!.full_name)}_${slug(docType)}.${ext}`,
        mime, size: file.size, status: "pending_review", uploaded_by: me.id, expiry: String(fd.get("expiry") || "") || null,
      }).select("id, file_name").single();
      if (error) { await admin.storage.from("files").remove([path]); throw error; }
      const { data: boss } = await admin.from("profiles").select("id").eq("role", "boss").eq("active", true);
      const notify = new Set([cu!.assigned_to, ...(boss ?? []).map((b) => b.id)].filter(Boolean) as string[]);
      await admin.from("notifications").insert([...notify].map((user_id) => ({
        user_id, title: `${cu!.full_name} uploaded a document`, body: `${docType} · pending review`, link: `/customers/${cu!.id}?tab=documents`,
      })));
      return NextResponse.json(row);
    }
    return err("Unknown upload target.");
  } catch (e) {
    return err(e instanceof Error ? e.message : "Upload failed", 500);
  }
}
