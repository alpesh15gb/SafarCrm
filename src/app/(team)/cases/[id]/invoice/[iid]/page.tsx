import { notFound } from "next/navigation";
import { requireBoss } from "@/lib/auth";
import { createClient } from "@/lib/supabase/server";
import { AGENCY_COLS, Breakup, FieldGrid, PayTo, PrintDoc, Rule, SAC, SignOff, Terms, type Agency } from "@/components/print-doc";
import { SERVICE_LABEL, type Service } from "@/lib/constants";
import { fdate, inr, prettyPhone, rupeesInWords, waLink } from "@/lib/format";

export const metadata = { title: "Invoice" };

type Line = { line_id: string; service: string; summary: string | null; service_date: string | null; travellers: string | null; amount: number; gst: number };
type BillTo = { name: string; address: string | null; gstin: string | null; mobile: string | null };
type CaseRef = { max_id: string; title: string; travellers: string | null; travel_start: string | null; travel_end: string | null; destination: string | null };

/** A numbered invoice, printed exactly as it was issued (the amounts are the copy kept on the invoice, not today's bookings). */
export default async function InvoicePage({ params }: { params: Promise<{ id: string; iid: string }> }) {
  await requireBoss();
  const { id, iid } = await params;
  const sb = await createClient();
  const [{ data: inv }, { data: agency }, { data: money }, { data: cust }] = await Promise.all([
    sb.from("invoices").select("*").eq("id", iid).eq("case_id", id).maybeSingle(),
    sb.from("settings").select(AGENCY_COLS).eq("id", 1).single(),
    sb.from("v_case_money").select("received, due").eq("case_id", id).maybeSingle(),
    sb.from("cases").select("customer:customers!cases_customer_id_fkey(mobile, whatsapp, full_name, customer_type, email, state)").eq("id", id).maybeSingle(),
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
  const cu = (cust?.customer ?? null) as unknown as { mobile: string; whatsapp: string | null; full_name: string; customer_type: string; email: string | null; state: string | null } | null;
  const text = `Namaste ${bill.name},\nYour invoice ${inv.number} dated ${fdate(inv.issued_on)} for ${ref.max_id} ${ref.title} is ${inr(total)}.${due > 0 ? `\nBalance due: ${inr(due)}.` : "\nPaid in full. Thank you."}${a.upi_id ? `\nUPI: ${a.upi_id}` : ""}\n${a.agency_name}`;

  const who = cu?.customer_type === "corporate" ? null : cu?.full_name;
  const taxInvoice = !!a.agency_gstin && hasGst;
  const travel = ref.travel_start ? `${fdate(ref.travel_start)}${ref.travel_end ? " → " + fdate(ref.travel_end) : ""}` : "";

  return (
    <PrintDoc back={{ href: `/cases/${id}?tab=payments`, label: ref.max_id }} wa={!cancelled && cu ? waLink(cu.whatsapp || cu.mobile, text) : undefined} agency={a}
      title={taxInvoice ? "Tax invoice" : "Invoice"} stamp={cancelled ? "Cancelled" : undefined}
      meta={[["Invoice no.", <span key="n" className="font-mono">{inv.number}</span>], ["Date", fdate(inv.issued_on)], ["Booking ID", <span key="b" className="font-mono">{ref.max_id}</span>],
        ["Place of supply", cu?.state ?? ""], ["Tax payable under reverse charge", taxInvoice ? "No" : ""]]}>
      {cancelled && <p className="no-print mb-4 mt-4 rounded-lg bg-red-50 px-3 py-2 text-[13px] text-red-800">This invoice was cancelled{inv.cancel_reason ? `: ${inv.cancel_reason}` : ""}. It is kept for the record.</p>}
      <Rule />
      <FieldGrid fields={[
        [bill.gstin || cu?.customer_type === "corporate" ? "Company name" : "Customer name", bill.name],
        ["Customer name", who && who !== bill.name ? who : ""],
        ["Customer GSTIN", bill.gstin ? <span className="font-mono">{bill.gstin}</span> : ""],
        ["Mobile", bill.mobile ? prettyPhone(bill.mobile) : ""],
        ["Email", cu?.email ?? ""],
      ]} />
      {bill.address && <FieldGrid className="mt-3" cols={2} fields={[["Customer address", <span key="a" className="whitespace-pre-line font-medium">{bill.address}</span>]]} />}
      <Rule />
      <FieldGrid fields={[["Trip", ref.title], ["Destination", ref.destination ?? ""], ["Travel", travel], ["Travellers", ref.travellers ?? ""]]} />
      <Rule label="Payment breakup" />
      <Breakup showCode={taxInvoice} total={total}
        rows={[
          ...lines.map((l) => ({
            label: <>{SERVICE_LABEL[l.service as Service] ?? l.service}{l.summary && `: ${l.summary}`}</>,
            sub: [l.travellers, l.service === "visa" ? "" : fdate(l.service_date)].filter(Boolean).join(" · ") || undefined,
            amount: Number(l.amount), code: SAC[l.service],
          })),
          ...(hasGst ? [{ label: "GST", sub: "On our service charges", amount: Number(inv.gst) }] : []),
        ]} />
      <p className="mt-2 text-[12.5px]"><span className="text-muted">Amount in words: </span><i>{rupeesInWords(total)}</i></p>
      {!cancelled && (
        <div className="mt-3 flex justify-end">
          <table className="w-full max-w-xs text-[13.5px]">
            <tbody>
              <tr><td className="py-0.5 text-muted">Received on this booking so far</td><td className="py-0.5 text-right tabular">{inr(received)}</td></tr>
              <tr className="font-semibold"><td className="py-0.5">{due > 0 ? "Balance due" : "Balance"}</td><td className="py-0.5 text-right tabular">{due > 0 ? inr(due) : "Fully paid"}</td></tr>
            </tbody>
          </table>
        </div>
      )}
      {!cancelled && due > 0 && <PayTo agency={a} />}
      <Terms items={[
        "Cancellation and change charges are as per airline, hotel and supplier rules.",
        "Please check the names, dates and amounts, and tell us within 48 hours of receiving this invoice if anything is wrong.",
        "This is not a travel document. Tickets, vouchers and visas are sent separately.",
      ]} />
      <SignOff agency={a} note="This is a computer-generated invoice." />
    </PrintDoc>
  );
}
