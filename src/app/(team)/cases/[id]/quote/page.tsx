import { notFound } from "next/navigation";
import { requireTeam } from "@/lib/auth";
import { createClient } from "@/lib/supabase/server";
import { AGENCY_COLS, PayTo, PrintDoc, type Agency } from "@/components/print-doc";
import { SERVICE_LABEL, type Service } from "@/lib/constants";
import { fdate, inr, todayIST, waLink } from "@/lib/format";

export const metadata = { title: "Estimate" };

/** Client-facing estimate (quotation) for a case: services and selling prices only (never costs, commission or profit). */
export default async function QuotePage({ params }: { params: Promise<{ id: string }> }) {
  await requireTeam();
  const { id } = await params;
  const sb = await createClient();
  const [{ data: kase }, { data: lines }, { data: trav }, { data: agency }] = await Promise.all([
    sb.from("cases").select("max_id, title, travel_start, travel_end, destination, customer:customers!cases_customer_id_fkey(full_name, mobile, whatsapp)").eq("id", id).maybeSingle(),
    sb.from("booking_lines").select("id, service, summary, service_date, selling_price, gst, traveller_ids, status").eq("case_id", id).neq("status", "cancelled").order("sort").order("service_date", { nullsFirst: false }).order("created_at"),
    sb.from("case_travellers").select("customer:customers(id, full_name, dob)").eq("case_id", id),
    sb.from("settings").select(`${AGENCY_COLS}, estimate_valid_days`).eq("id", 1).single(),
  ]);
  if (!kase) notFound();
  const cu = kase.customer as unknown as { full_name: string; mobile: string; whatsapp: string | null };
  const people = (trav ?? []).map((t) => t.customer as unknown as { id: string; full_name: string });
  const name = new Map(people.map((p) => [p.id, p.full_name]));
  const rows = lines ?? [];
  const sub = rows.reduce((s, l) => s + Number(l.selling_price), 0);
  const gst = rows.reduce((s, l) => s + Number(l.gst), 0);
  const total = sub + gst;
  const a = agency as unknown as Agency & { estimate_valid_days: number | null };
  const validTill = todayIST(a?.estimate_valid_days ?? 2);
  const trip = [kase.destination, kase.travel_start && `${fdate(kase.travel_start)}${kase.travel_end ? " to " + fdate(kase.travel_end) : ""}`].filter(Boolean).join(", ");
  const text = `Namaste ${cu.full_name},\nHere is our estimate for ${kase.title}${trip ? ` (${trip})` : ""}:\n${rows.map((l) => `• ${SERVICE_LABEL[l.service as Service]}${l.summary ? `: ${l.summary}` : ""} – ${inr(Number(l.selling_price) + Number(l.gst))}`).join("\n")}\nTotal: ${inr(total)}${gst ? " (incl. GST)" : ""}\nValid until ${fdate(validTill)}, subject to availability. Ref ${kase.max_id}.\n– ${a?.agency_name ?? ""}`;

  return (
    <PrintDoc back={{ href: `/cases/${id}`, label: kase.max_id }} wa={waLink(cu.whatsapp || cu.mobile, text)} agency={a}
      title="Estimate" meta={[["Ref", `${kase.max_id}-E`], ["Date", fdate(todayIST())], ["Valid until", fdate(validTill)]]}>
      <div className="mb-5 grid gap-1 sm:grid-cols-2">
        <div><span className="text-muted">For: </span><b>{cu.full_name}</b></div>
        <div><span className="text-muted">Trip: </span><b>{kase.title}</b>{trip && <span className="text-muted"> · {trip}</span>}</div>
        {people.length > 0 && <div className="sm:col-span-2"><span className="text-muted">Travellers ({people.length}): </span>{people.map((p) => p.full_name).join(", ")}</div>}
      </div>
      {rows.some((l) => Number(l.selling_price) + Number(l.gst) === 0) && (
        <p className="no-print mb-4 rounded-lg bg-amber-50 px-3 py-2 text-[13px] text-amber-900">Some bookings have no selling price yet, so they show as ₹0. Enter the prices on the Bookings tab before sending this.</p>
      )}
      {rows.length === 0 ? <p className="text-muted">No services added yet. Add bookings on the case first.</p> : (
        <table className="w-full text-[14px]">
          <thead><tr className="border-b border-ink text-left text-[12px] uppercase tracking-wide text-muted"><th className="py-2">#</th><th className="py-2">Service</th><th className="py-2">Date</th>{gst > 0 && <th className="py-2 text-right">GST</th>}<th className="py-2 text-right">Amount</th></tr></thead>
          <tbody>
            {rows.map((l, i) => (
              <tr key={l.id} className="border-b border-line align-top">
                <td className="py-2 pr-2 text-muted">{i + 1}</td>
                <td className="py-2 pr-3">
                  <div className="font-medium">{SERVICE_LABEL[l.service as Service]}{l.summary && `: ${l.summary}`}</div>
                  {(l.traveller_ids as string[]).length > 0 && <div className="text-[12px] text-muted">{(l.traveller_ids as string[]).map((t) => name.get(t)).filter(Boolean).join(", ")}</div>}
                </td>
                <td className="py-2 pr-3 whitespace-nowrap">{fdate(l.service_date) || "—"}</td>
                {gst > 0 && <td className="py-2 text-right tabular">{Number(l.gst) ? inr(l.gst) : "—"}</td>}
                <td className="py-2 text-right tabular">{inr(Number(l.selling_price) + Number(l.gst))}</td>
              </tr>
            ))}
          </tbody>
          <tfoot>
            {gst > 0 && <tr><td colSpan={3} className="pt-2 text-right text-muted">of which GST</td><td className="pt-2 text-right tabular" colSpan={2}>{inr(gst)}</td></tr>}
            <tr className="text-base font-semibold"><td colSpan={gst > 0 ? 4 : 3} className="pt-2 text-right">Total</td><td className="pt-2 text-right tabular">{inr(total)}</td></tr>
          </tfoot>
        </table>
      )}
      <ul className="mt-6 list-disc space-y-1 pl-5 text-[13px] text-muted">
        <li>Prices are valid until {fdate(validTill)} and subject to availability when we book. Airfares can change until the ticket is issued.</li>
        <li>Bookings are confirmed after the advance payment is received.</li>
        <li>Cancellation charges are as per airline, hotel and supplier rules.</li>
      </ul>
      <PayTo agency={a} />
    </PrintDoc>
  );
}
