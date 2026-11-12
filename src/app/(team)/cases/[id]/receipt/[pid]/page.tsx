import { notFound } from "next/navigation";
import { requireTeam } from "@/lib/auth";
import { createClient } from "@/lib/supabase/server";
import { AGENCY_COLS, PrintDoc, type Agency } from "@/components/print-doc";
import { PAY_MODE_LABEL } from "@/lib/constants";
import { fdate, inr, rupeesInWords, waLink } from "@/lib/format";

export const metadata = { title: "Payment receipt" };

export default async function ReceiptPage({ params }: { params: Promise<{ id: string; pid: string }> }) {
  await requireTeam();
  const { id, pid } = await params;
  const sb = await createClient();
  const [{ data: pay }, { data: kase }, { data: all }, { data: money }, { data: agency }] = await Promise.all([
    sb.from("payments").select("id, receipt_no, pay_date, amount, mode, reference, notes, created_at, receiver:profiles!payments_received_by_fkey(full_name)").eq("id", pid).eq("case_id", id).eq("direction", "in").maybeSingle(),
    sb.from("cases").select("max_id, title, travel_start, travel_end, destination, customer:customers!cases_customer_id_fkey(full_name, mobile, whatsapp, address1, city)").eq("id", id).maybeSingle(),
    sb.from("payments").select("id, amount, pay_date, created_at").eq("case_id", id).eq("direction", "in"),
    sb.from("v_case_money").select("billed").eq("case_id", id).maybeSingle(),
    sb.from("settings").select(AGENCY_COLS).eq("id", 1).single(),
  ]);
  if (!pay || !kase || Number(pay.amount) <= 0 || !pay.receipt_no) notFound();
  const cu = kase.customer as unknown as { full_name: string; mobile: string; whatsapp: string | null; address1: string | null; city: string | null };
  // what was received up to and including this receipt (refunds count against it)
  const key = (p: { pay_date: string; created_at: string }) => `${p.pay_date} ${p.created_at}`;
  const toDate = (all ?? []).filter((p) => key(p) <= key(pay)).reduce((s, p) => s + Number(p.amount), 0);
  const billed = Number(money?.billed ?? 0);
  const balance = Math.max(0, billed - toDate);
  const no = `R-${pay.receipt_no}`;
  const amt = Number(pay.amount);
  const trip = [kase.destination, kase.travel_start && `${fdate(kase.travel_start)}${kase.travel_end ? " to " + fdate(kase.travel_end) : ""}`].filter(Boolean).join(", ");
  const text = `Namaste ${cu.full_name},\nWe have received ${inr(amt)} on ${fdate(pay.pay_date)} by ${PAY_MODE_LABEL[pay.mode]}${pay.reference ? ` (ref ${pay.reference})` : ""} for ${kase.max_id} ${kase.title}.\nReceipt no. ${no}. ${balance > 0 ? `Balance due: ${inr(balance)}.` : "Fully paid. Thank you!"}\n– ${agency?.agency_name ?? ""}`;

  return (
    <PrintDoc back={{ href: `/cases/${id}?tab=payments`, label: kase.max_id }} wa={waLink(cu.whatsapp || cu.mobile, text)} agency={agency as unknown as Agency}
      title="Payment receipt" meta={[["Receipt no.", no], ["Date", fdate(pay.pay_date)]]}>
      <p>
        Received with thanks from <b>{cu.full_name}</b>{cu.city && `, ${cu.city}`} the sum of <b>{inr(amt)}</b>{" "}
        (<i>{rupeesInWords(amt)}</i>) by <b>{PAY_MODE_LABEL[pay.mode]}</b>{pay.reference && <> (reference {pay.reference})</>}{" "}
        towards <b>{kase.max_id}</b>: {kase.title}{trip && ` (${trip})`}.
      </p>
      <table className="mt-6 w-full max-w-sm text-[14px]">
        <tbody>
          <tr><td className="py-1 text-muted">Trip total</td><td className="py-1 text-right tabular">{inr(billed)}</td></tr>
          <tr><td className="py-1 text-muted">Received so far (with this receipt)</td><td className="py-1 text-right tabular">{inr(toDate)}</td></tr>
          <tr className="border-t border-ink font-semibold"><td className="py-1.5">{balance > 0 ? "Balance due" : "Balance"}</td><td className="py-1.5 text-right tabular">{balance > 0 ? inr(balance) : "Fully paid"}</td></tr>
        </tbody>
      </table>
      <div className="mt-10 flex items-end justify-between gap-4 text-[13px]">
        <div className="text-muted">Received by {(pay.receiver as unknown as { full_name: string } | null)?.full_name ?? "—"}<br />This is a computer-generated receipt.</div>
        <div className="text-center"><div className="mb-1 h-10 w-44 border-b border-ink" />For {agency?.agency_name}</div>
      </div>
    </PrintDoc>
  );
}
