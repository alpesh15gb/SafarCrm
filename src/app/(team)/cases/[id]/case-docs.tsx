"use client";
import Link from "next/link";
import { useState } from "react";
import { useRouter } from "next/navigation";
import { FileText, Receipt } from "lucide-react";
import { Badge, Button, Field, btnClass } from "@/components/ui";
import { Dialog, useAction } from "@/components/client";
import { cancelInvoice, issueInvoice } from "@/actions/invoices";
import { fdate, inr } from "@/lib/format";

export type InvoiceRow = {
  id: string; number: string; issued_on: string; total: number; status: string; cancel_reason: string | null;
  lines: { line_id: string; amount: number; gst: number }[];
};
type LineNow = { id: string; status: string; selling_price: number; gst: number };

/** The two client documents of a case in one place: the estimate (before the sale) and invoices (after it). */
export function CaseDocs({ caseId, caseStatus, lines, invoices }: { caseId: string; caseStatus: string; lines: LineNow[]; invoices: InvoiceRow[] }) {
  const router = useRouter();
  const { run, pending } = useAction();
  const [key, setKey] = useState(() => crypto.randomUUID());
  const [cancel, setCancel] = useState<InvoiceRow | null>(null);
  const [why, setWhy] = useState("");

  const live = lines.filter((l) => l.status !== "cancelled");
  const priced = live.filter((l) => Number(l.selling_price) + Number(l.gst) > 0);
  const invoiced = new Set(invoices.filter((i) => i.status === "issued").flatMap((i) => i.lines.map((x) => x.line_id)));
  const toBill = priced.filter((l) => !invoiced.has(l.id));
  const now = new Map(lines.map((l) => [l.id, l]));
  // an invoice is a fixed copy: flag it when the bookings no longer match what was invoiced
  const changed = (i: InvoiceRow) => i.status === "issued" && i.lines.some((x) => {
    const l = now.get(x.line_id);
    return !l || l.status === "cancelled" || Number(l.selling_price) !== Number(x.amount) || Number(l.gst) !== Number(x.gst);
  });
  const why_not = caseStatus === "cancelled" ? "This case is cancelled."
    : live.length === 0 ? "Add a booking first."
    : priced.length === 0 ? "Enter a selling price on a booking first."
    : toBill.length === 0 ? "Everything is already invoiced. To change an invoice, cancel it and create a new one." : "";

  return (
    <div className="mb-4 rounded-[14px] border border-line bg-white px-4 py-3 shadow-soft">
      <div className="flex flex-wrap items-center gap-2">
        <span className="mr-1 text-[13px] font-semibold">Estimate and invoice</span>
        {live.length > 0
          ? <Link href={`/cases/${caseId}/quote`} className={btnClass("secondary", "sm")}><FileText className="h-3.5 w-3.5" />Estimate</Link>
          : <span className="text-xs text-muted">Add a booking to make an estimate.</span>}
        <Button size="sm" variant={toBill.length && !why_not ? "primary" : "secondary"} disabled={pending || !!why_not} title={why_not || undefined}
          onClick={() => run(() => issueInvoice(caseId, key), { then: (r) => { setKey(crypto.randomUUID()); if (r.data) router.push(`/cases/${caseId}/invoice/${r.data.id}`); } })}>
          <Receipt className="h-3.5 w-3.5" />Create invoice{toBill.length > 0 && invoiced.size > 0 ? ` (${toBill.length} new)` : ""}
        </Button>
        {why_not && live.length > 0 && <span className="text-xs text-muted">{why_not}</span>}
      </div>
      {invoices.length > 0 && (
        <ul className="mt-2 divide-y divide-line border-t border-line text-[13px]">
          {invoices.map((i) => (
            <li key={i.id} className="flex flex-wrap items-center gap-x-3 gap-y-1 py-2">
              <Link href={`/cases/${caseId}/invoice/${i.id}`} className="font-mono font-semibold hover:underline">{i.number}</Link>
              <span className="text-muted">{fdate(i.issued_on)}</span>
              <span className="tabular">{inr(i.total)}</span>
              {i.status === "cancelled" && <Badge tone="grey">Cancelled</Badge>}
              {changed(i) && <span className="rounded-full bg-amber-50 px-2 py-0.5 text-[11px] font-medium text-amber-800">Bookings changed since: cancel and create a new invoice</span>}
              <span className="flex-1" />
              <Link href={`/cases/${caseId}/invoice/${i.id}`} className="text-xs link">Open</Link>
              {i.status === "issued" && <button type="button" className="text-xs text-red-600 hover:underline" onClick={() => { setWhy(""); setCancel(i); }}>Cancel</button>}
            </li>
          ))}
        </ul>
      )}
      <Dialog open={!!cancel} onClose={() => setCancel(null)} title={`Cancel invoice ${cancel?.number ?? ""}?`}
        footer={<>
          <Button onClick={() => setCancel(null)}>Keep invoice</Button>
          <Button variant="danger" disabled={pending || !why.trim()} onClick={() => cancel && run(() => cancelInvoice(cancel.id, why), { then: () => setCancel(null) })}>Cancel invoice</Button>
        </>}>
        <p className="mb-3 text-[13px] text-muted">The invoice stays on record, marked Cancelled, and its number is not used again. Payments are not affected. You can then create a new invoice for the same bookings.</p>
        <Field label="Reason" required><input className="field" value={why} onChange={(e) => setWhy(e.target.value)} placeholder="Price changed after the hotel upgrade" /></Field>
      </Dialog>
    </div>
  );
}
