import { notFound } from "next/navigation";
import { requireTeam } from "@/lib/auth";
import { createClient } from "@/lib/supabase/server";
import { AGENCY_COLS, PayTo, PrintDoc, type Agency } from "@/components/print-doc";
import { SERVICE_LABEL, type Service } from "@/lib/constants";
import { fdate, inr, prettyPhone, rupeesInWords, waLink } from "@/lib/format";

export const metadata = { title: "Invoice" };

type Line = { line_id: string; service: string; summary: string | null; service_date: string | null; travellers: string | null; amount: number; gst: number };
type BillTo = { name: string; address: string | null; gstin: string | null; mobile: string | null };
type CaseRef = { max_id: string; title: string; travellers: string | null; travel_start: string | null; travel_end: string | null; destination: string | null };

/** A numbered invoice, printed exactly as it was issued (the amounts are the copy kept on the invoice, not today's bookings). */
export default async function InvoicePage({ params }: { params: Promise<{ id: string; iid: string }> }) {
  await requireTeam();
  const { id, iid } = await params;
  const sb = await createClient();
  const [{ data: inv }, { data: agency }, { data: money }, { data: cust }] = await Promise.all([
    sb.from("invoices").select("*").eq("id", iid).eq("case_id", id).maybeSingle(),
    sb.from("settings").select(AGENCY_COLS).eq("id", 1).single(),
    sb.from("v_case_money").select("received, due").eq("case_id", id).maybeSingle(),
    sb.from("cases").select("customer:customers!cases_customer_id_fkey(mobile, whatsapp)").eq("id", id).maybeSingle(),
  ]);
  if (!inv || !agency) notFound();
  const a = agency as unknown as Agency;
  const lines = (inv.lines ?? []) as Line[];
  const bill = inv.bill_to as BillTo;
  const ref = inv.case_ref as CaseRef;
  const hasGst = Number(inv.gst) > 0;
  const cancelled = inv.status === "cancelled";
  const total = Number(inv.total);
  const received = Number(money?.received ?? 0);
  const due = Number(money?.due ?? 0);
  const trip = [ref.destination, ref.travel_start && `${fdate(ref.travel_start)}${ref.travel_end ? " to " + fdate(ref.travel_end) : ""}`].filter(Boolean).join(", ");
  const cu = (cust?.customer ?? null) as unknown as { mobile: string; whatsapp: string | null } | null;
  const text = `Namaste ${bill.name},\nYour invoice ${inv.number} dated ${fdate(inv.issued_on)} for ${ref.max_id} ${ref.title} is ${inr(total)}.${due > 0 ? `\nBalance due: ${inr(due)}.` : "\nPaid in full. Thank you."}${a.upi_id ? `\nUPI: ${a.upi_id}` : ""}\n${a.agency_name}`;

  return (
    <PrintDoc back={{ href: `/cases/${id}?tab=payments`, label: ref.max_id }} wa={!cancelled && cu ? waLink(cu.whatsapp || cu.mobile, text) : undefined} agency={a}
      title={a.agency_gstin && hasGst ? "Tax invoice" : "Invoice"} stamp={cancelled ? "Cancelled" : undefined}
      meta={[["Invoice no.", inv.number], ["Date", fdate(inv.issued_on)], ["Case", ref.max_id]]}>
      {cancelled && <p className="no-print mb-4 rounded-lg bg-red-50 px-3 py-2 text-[13px] text-red-800">This invoice was cancelled{inv.cancel_reason ? `: ${inv.cancel_reason}` : ""}. It is kept for the record.</p>}
      <div className="mb-5 grid gap-x-6 gap-y-1 sm:grid-cols-2">
        <div>
          <div className="text-[12px] uppercase tracking-wide text-muted">Bill to</div>
          <div className="font-semibold">{bill.name}</div>
          {bill.address && <div className="whitespace-pre-line text-[13px]">{bill.address}</div>}
          {bill.mobile && <div className="text-[13px] text-muted">{prettyPhone(bill.mobile)}</div>}
          {bill.gstin && <div className="text-[13px]">GSTIN <span className="font-mono">{bill.gstin}</span></div>}
        </div>
        <div>
          <div className="text-[12px] uppercase tracking-wide text-muted">For</div>
          <div className="font-semibold">{ref.title}</div>
          {trip && <div className="text-[13px] text-muted">{trip}</div>}
          {ref.travellers && <div className="text-[13px]"><span className="text-muted">Travellers: </span>{ref.travellers}</div>}
        </div>
      </div>
      <table className="w-full text-[14px]">
        <thead>
          <tr className="border-b border-ink text-left text-[12px] uppercase tracking-wide text-muted">
            <th className="py-2">#</th><th className="py-2">Service</th><th className="py-2">Date</th>
            <th className="py-2 text-right">Amount</th>{hasGst && <th className="py-2 text-right">GST</th>}{hasGst && <th className="py-2 text-right">Total</th>}
          </tr>
        </thead>
        <tbody>
          {lines.map((l, i) => (
            <tr key={l.line_id} className="border-b border-line align-top">
              <td className="py-2 pr-2 text-muted">{i + 1}</td>
              <td className="py-2 pr-3">
                <div className="font-medium">{SERVICE_LABEL[l.service as Service] ?? l.service}{l.summary && `: ${l.summary}`}</div>
                {l.travellers && <div className="text-[12px] text-muted">{l.travellers}</div>}
              </td>
              <td className="whitespace-nowrap py-2 pr-3">{fdate(l.service_date) || "—"}</td>
              <td className="py-2 text-right tabular">{inr(l.amount)}</td>
              {hasGst && <td className="py-2 text-right tabular">{Number(l.gst) ? inr(l.gst) : "—"}</td>}
              {hasGst && <td className="py-2 text-right tabular">{inr(Number(l.amount) + Number(l.gst))}</td>}
            </tr>
          ))}
        </tbody>
      </table>
      <div className="mt-3 flex justify-end">
        <table className="w-full max-w-xs text-[14px]">
          <tbody>
            {hasGst && <tr><td className="py-1 text-muted">Amount before GST</td><td className="py-1 text-right tabular">{inr(inv.subtotal)}</td></tr>}
            {hasGst && <tr><td className="py-1 text-muted">GST</td><td className="py-1 text-right tabular">{inr(inv.gst)}</td></tr>}
            <tr className="border-t border-ink text-base font-semibold"><td className="py-1.5">Invoice total</td><td className="py-1.5 text-right tabular">{inr(total)}</td></tr>
            {!cancelled && <tr><td className="py-1 text-muted">Received on this case so far</td><td className="py-1 text-right tabular">{inr(received)}</td></tr>}
            {!cancelled && <tr className="font-semibold"><td className="py-1">{due > 0 ? "Balance due" : "Balance"}</td><td className="py-1 text-right tabular">{due > 0 ? inr(due) : "Fully paid"}</td></tr>}
          </tbody>
        </table>
      </div>
      <p className="mt-3 text-[13px]"><span className="text-muted">Amount in words: </span><i>{rupeesInWords(total)}</i></p>
      {!cancelled && <PayTo agency={a} />}
      <div className="mt-10 flex items-end justify-between gap-4 text-[13px]">
        <div className="text-muted">Cancellation and change charges are as per airline, hotel and supplier rules.<br />This is a computer-generated invoice.</div>
        <div className="text-center"><div className="mb-1 h-10 w-44 border-b border-ink" />For {a.agency_name}</div>
      </div>
    </PrintDoc>
  );
}
