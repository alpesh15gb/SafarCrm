"use client";
import { useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { FileUp, Loader2, Ticket } from "lucide-react";
import { Button, cx } from "./ui";
import { Dialog, useToast } from "./client";

const OK = ["application/pdf", "image/jpeg", "image/png"];

/** "Upload booked ticket": one entry point used on the dashboard, cases, customer, case bookings and the portal.
 *  Staff go straight to the review screen; portal users see that it was sent for review. */
export function TicketUploadButton({ scope = {}, portal = false, label = "Upload booked ticket", variant = "secondary", size, replaces, onDone }: {
  scope?: { case_id?: string; customer_id?: string; line_id?: string; for_customer?: string };
  portal?: boolean; label?: string; variant?: "primary" | "secondary"; size?: "sm"; replaces?: string; onDone?: (id: string) => void;
}) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <Button variant={variant} size={size} onClick={() => setOpen(true)}><Ticket className={size ? "h-3.5 w-3.5" : "h-4 w-4"} />{label}</Button>
      <TicketUploadDialog open={open} onClose={() => setOpen(false)} scope={scope} portal={portal} replaces={replaces} onDone={onDone} />
    </>
  );
}

export function TicketUploadDialog({ open, onClose, scope = {}, portal, replaces, onDone }: {
  open: boolean; onClose: () => void; scope?: Record<string, string | undefined>; portal?: boolean; replaces?: string; onDone?: (id: string) => void;
}) {
  const router = useRouter();
  const toast = useToast();
  const input = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState(false);
  const [over, setOver] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [sent, setSent] = useState<string | null>(null);

  async function send(f: File) {
    setError(null);
    if (!OK.includes(f.type)) return setError("Only PDF, JPG or PNG files can be imported.");
    if (f.size > 10 * 1024 * 1024) return setError("The file is larger than 10 MB. Upload only the ticket pages.");
    setBusy(true);
    const fd = new FormData();
    Object.entries(scope).forEach(([k, v]) => v && fd.append(k, v));
    if (replaces) fd.append("replaces", replaces);
    fd.append("file", f);
    try {
      const r = await fetch("/api/imports", { method: "POST", body: fd });
      const j = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(j.error || "Upload failed. Please try again.");
      if (j.message) toast(j.message);
      onDone?.(j.id);
      if (portal) { setSent(j.duplicate ? "We already have this ticket. The office will review it." : "Sent. The office will review it and add it to your trip."); router.refresh(); }
      else { onClose(); router.push(`/imports/${j.id}`); }
    } catch (e) {
      setError(e instanceof Error ? e.message : "Upload failed. Please try again.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <Dialog open={open} onClose={() => { setSent(null); setError(null); onClose(); }} title={replaces ? "Replace the ticket file" : "Upload a booked ticket"}>
      {sent ? (
        <div className="space-y-3">
          <p role="status" className="rounded-lg bg-emerald-50 px-3 py-2 text-sm text-emerald-900">{sent}</p>
          <div className="flex justify-end gap-2"><Button onClick={() => setSent(null)}>Send another</Button><Button variant="primary" onClick={() => { setSent(null); onClose(); }}>Done</Button></div>
        </div>
      ) : (
        <div className="space-y-3">
          <p className="text-[13px] text-muted">
            {portal
              ? "Send a ticket you booked yourself (PDF, JPG or PNG, up to 10 MB and 10 pages). Nothing changes on your trip until the office has checked it."
              : "PDF, JPG or PNG, up to 10 MB and 10 pages. The file stays private. You review what was read before anything is saved, and no prices or payments are created from it."}
          </p>
          <div
            role="button" tabIndex={0} aria-busy={busy}
            onClick={() => !busy && input.current?.click()}
            onKeyDown={(e) => (e.key === "Enter" || e.key === " ") && !busy && input.current?.click()}
            onDragOver={(e) => { e.preventDefault(); setOver(true); }} onDragLeave={() => setOver(false)}
            onDrop={(e) => { e.preventDefault(); setOver(false); const f = e.dataTransfer.files[0]; if (f && !busy) send(f); }}
            className={cx("flex min-h-36 cursor-pointer flex-col items-center justify-center gap-2 rounded-xl border-2 border-dashed px-4 text-center text-sm transition-colors",
              over ? "border-coral bg-coral-soft" : "border-gray-300 hover:border-coral hover:bg-gray-50")}
          >
            {busy ? <><Loader2 className="h-6 w-6 animate-spin text-coral" />Uploading and checking the file…</> : <><FileUp className="h-6 w-6 text-muted" />Drop the ticket here, or tap to choose</>}
          </div>
          <input ref={input} type="file" accept=".pdf,.jpg,.jpeg,.png" className="hidden" onChange={(e) => { const f = e.target.files?.[0]; if (f) send(f); e.target.value = ""; }} />
          {error && <p role="alert" className="rounded-lg bg-red-50 px-3 py-2 text-[13px] text-red-800">{error}</p>}
        </div>
      )}
    </Dialog>
  );
}
