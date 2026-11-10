"use client";
import { useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { Download, FileText, Link2, Mail, MessageCircle, RefreshCw, Trash2, UploadCloud, History } from "lucide-react";
import { Badge, cx } from "./ui";
import { Confirm, Toggle, useAction, useToast } from "./client";
import { useApp } from "./shell/shell";
import { createShareLink, deleteFile, setFileVisible } from "@/actions/files";
import { fdatetime, waLink } from "@/lib/format";

const OK_TYPES = ["application/pdf", "image/jpeg", "image/png"];
const MAX = 10 * 1024 * 1024;

export function DropZone({ fields, label = "Drop tickets here or click to upload", compact, accept = ".pdf,.jpg,.jpeg,.png", onDone }: {
  fields: Record<string, string>; label?: string; compact?: boolean; accept?: string; onDone?: (uploaded: number) => void;
}) {
  const router = useRouter();
  const toast = useToast();
  const input = useRef<HTMLInputElement>(null);
  const [over, setOver] = useState(false);
  const [busy, setBusy] = useState(0);

  async function upload(files: FileList | File[]) {
    const list = Array.from(files);
    let ok = 0;
    for (const f of list) {
      if (!OK_TYPES.includes(f.type)) { toast(`${f.name}: only PDF, JPG or PNG`, "error"); continue; }
      if (f.size > MAX) { toast(`${f.name}: larger than 10 MB`, "error"); continue; }
      setBusy((b) => b + 1);
      const fd = new FormData();
      Object.entries(fields).forEach(([k, v]) => fd.append(k, v));
      fd.append("file", f);
      try {
        const r = await fetch("/api/upload", { method: "POST", body: fd });
        const j = await r.json();
        if (!r.ok) throw new Error(j.error || "Upload failed");
        toast(`Uploaded as ${j.file_name}`);
        ok++;
      } catch (e) {
        toast(e instanceof Error ? e.message : "Upload failed", "error");
      } finally {
        setBusy((b) => b - 1);
      }
    }
    onDone?.(ok);
    router.refresh();
  }

  return (
    <div
      role="button"
      tabIndex={0}
      onClick={() => input.current?.click()}
      onKeyDown={(e) => e.key === "Enter" && input.current?.click()}
      onDragOver={(e) => { e.preventDefault(); setOver(true); }}
      onDragLeave={() => setOver(false)}
      onDrop={(e) => { e.preventDefault(); setOver(false); upload(e.dataTransfer.files); }}
      className={cx(
        "flex cursor-pointer items-center justify-center gap-2 rounded-lg border border-dashed text-[13px] text-muted transition-colors hover:border-coral hover:text-ink",
        compact ? "px-3 py-2" : "px-4 py-5",
        over ? "border-coral bg-coral-soft" : "border-line",
      )}
    >
      <UploadCloud className="h-4 w-4" />
      {busy > 0 ? `Uploading ${busy}…` : label}
      <input ref={input} type="file" multiple accept={accept} className="hidden" onChange={(e) => e.target.files && upload(e.target.files)} />
    </div>
  );
}

export type FileItemData = {
  id: string; file_name: string; kind: string; visible_to_client: boolean; created_at: string; size: number | null;
  superseded_at: string | null; booking_line_id: string | null; case_id: string | null;
  uploader?: { full_name: string } | null;
};

export function FileItem({ f, maxId, customer, history }: {
  f: FileItemData; maxId: string; customer?: { full_name: string; mobile: string; whatsapp: string | null; email: string | null }; history?: FileItemData[];
}) {
  const { me } = useApp();
  const { run, pending } = useAction();
  const toast = useToast();
  const [del, setDel] = useState(false);
  const [showHist, setShowHist] = useState(false);
  const reissueRef = useRef<HTMLInputElement>(null);
  const router = useRouter();

  async function share(how: "wa" | "copy" | "email") {
    const r = await createShareLink(f.id);
    if (!r.ok) return toast(r.error, "error");
    const url = r.data!.url;
    const first = customer?.full_name.split(" ")[0] ?? "";
    const text = `Namaste ${first}, here is your ${f.kind === "other" ? "document" : f.kind} for ${maxId}: ${url}\n(This secure link works for 7 days.)`;
    if (how === "copy") { await navigator.clipboard?.writeText(url); toast("Link copied (valid 7 days)"); }
    if (how === "wa") window.open(waLink(customer?.whatsapp || customer?.mobile, text), "_blank");
    if (how === "email") window.location.href = `mailto:${customer?.email ?? ""}?subject=${encodeURIComponent(`${maxId}: your ${f.kind}`)}&body=${encodeURIComponent(text)}`;
  }

  async function reissue(file: File) {
    const fd = new FormData();
    fd.append("target", f.booking_line_id ? "line" : "case");
    fd.append("case_id", f.case_id ?? "");
    if (f.booking_line_id) fd.append("line_id", f.booking_line_id);
    fd.append("kind", f.kind);
    fd.append("replaces", f.id);
    fd.append("file", file);
    const r = await fetch("/api/upload", { method: "POST", body: fd });
    const j = await r.json();
    if (!r.ok) return toast(j.error || "Upload failed", "error");
    toast("Re-issued. The old file is kept in history.");
    router.refresh();
  }

  const btn = "inline-flex items-center gap-1 rounded px-1.5 py-1 text-xs text-muted hover:bg-gray-100 hover:text-ink";
  return (
    <div className={cx("rounded-lg border border-line bg-white", f.superseded_at && "opacity-60")}>
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5 px-3 py-2">
        <FileText className="h-4 w-4 shrink-0 text-muted" />
        <a href={`/api/files/${f.id}`} target="_blank" rel="noreferrer" className="min-w-0 flex-1 truncate text-sm hover:underline" title={f.file_name}>{f.file_name}</a>
        {f.superseded_at && <Badge>Old version</Badge>}
        {!f.superseded_at && (
          <Toggle
            checked={f.visible_to_client}
            disabled={me.role !== "boss" || pending}
            onChange={(v) => run(() => setFileVisible(f.id, v))}
            label={<span className="text-xs text-muted">Client</span>}
          />
        )}
      </div>
      <div className="flex flex-wrap items-center gap-0.5 border-t border-line px-2 py-1">
        <a className={btn} href={`/api/files/${f.id}?dl=1`}><Download className="h-3.5 w-3.5" />Download</a>
        {!f.superseded_at && (
          <>
            <button type="button" className={btn} onClick={() => share("wa")}><MessageCircle className="h-3.5 w-3.5" />Share</button>
            <button type="button" className={btn} onClick={() => share("copy")}><Link2 className="h-3.5 w-3.5" />Copy link</button>
            <button type="button" className={btn} onClick={() => share("email")}><Mail className="h-3.5 w-3.5" />Email</button>
            <button type="button" className={btn} onClick={() => reissueRef.current?.click()}><RefreshCw className="h-3.5 w-3.5" />Re-issue</button>
            <input ref={reissueRef} type="file" accept=".pdf,.jpg,.jpeg,.png" className="hidden" onChange={(e) => e.target.files?.[0] && reissue(e.target.files[0])} />
          </>
        )}
        {history && history.length > 0 && (
          <button type="button" className={btn} onClick={() => setShowHist((s) => !s)}><History className="h-3.5 w-3.5" />History ({history.length})</button>
        )}
        {me.role === "boss" && <button type="button" className={cx(btn, "ml-auto hover:text-red-600")} onClick={() => setDel(true)}><Trash2 className="h-3.5 w-3.5" /></button>}
        <span className="w-full px-1.5 text-[11px] text-muted sm:ml-auto sm:w-auto">{f.uploader?.full_name ? `${f.uploader.full_name} · ` : ""}{fdatetime(f.created_at)}</span>
      </div>
      {showHist && history && (
        <div className="space-y-1.5 border-t border-line bg-gray-50 p-2">
          {history.map((h) => <FileItem key={h.id} f={h} maxId={maxId} customer={customer} />)}
        </div>
      )}
      <Confirm open={del} onClose={() => setDel(false)} title="Delete this file?" text={f.file_name} confirmLabel="Delete" pending={pending}
        onConfirm={() => run(() => deleteFile(f.id), { then: () => setDel(false) })} />
    </div>
  );
}

/** Group files: current versions with their older versions as history. */
export function withHistory<T extends { id: string; superseded_at: string | null }>(files: (T & { superseded_by?: string | null })[]) {
  const current = files.filter((f) => !f.superseded_at);
  const hist = (id: string): T[] => {
    const prev = files.filter((f) => f.superseded_by === id);
    return prev.flatMap((p) => [p, ...hist(p.id)]);
  };
  return current.map((f) => ({ file: f, history: hist(f.id) }));
}
