import { notFound } from "next/navigation";
import { requireTeam } from "@/lib/auth";
import { createClient } from "@/lib/supabase/server";
import { AGENCY_COLS, Breakup, FieldGrid, PayTo, PrintDoc, Rule, SignOff, Terms, type Agency } from "@/components/print-doc";
import { SERVICE_LABEL, type Service } from "@/lib/constants";
import { fdate, inr, prettyPhone, rupeesInWords, todayIST, waLink } from "@/lib/format";

export const metadata = { title: "Estimate" };

/** Client-facing estimate (quotation) for a case: services and selling prices only (never costs, commission or profit). */
export default async function QuotePage({ params }: { params: Promise<{ id: string }> }) {
  await requireTeam();
  const { id } = await params;
  const sb = await createClient();
  const [{ data: kase }, { data: lines }, { data: trav }, { data: agency }] = await Promise.all([
    sb.from("cases").select("max_id, title, travel_start, travel_end, destination, customer:customers!cases_customer_id_fkey(full_name, mobile, whatsapp, email, customer_type, company_name, gstin)").eq("id", id).maybeSingle(),
    sb.from("booking_lines").select("id, service, summary, service_date, selling_price, gst, traveller_ids, status").eq("case_id", id).neq("status", "cancelled").order("sort").order("service_date", { nullsFirst: false }).order("created_at"),
    sb.from("case_travellers").select("customer:customers(id, full_name, dob)").eq("case_id", id),
    sb.from("settings").select(`${AGENCY_COLS}, estimate_valid_days`).eq("id", 1).single(),
  ]);
  if (!kase) notFound();
  const cu = kase.customer as unknown as { full_name: string; mobile: string; whatsapp: string | null; email: string | null; customer_type: string; company_name: string | null; gstin: string | null };
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

  const travel = kase.travel_start ? `${fdate(kase.travel_start)}${kase.travel_end ? " → " + fdate(kase.travel_end) : ""}` : "";
  const corporate = cu.customer_type === "corporate";

  return (
    <PrintDoc back={{ href: `/cases/${id}`, label: kase.max_id }} wa={waLink(cu.whatsapp || cu.mobile, text)} agency={a}
      title="Estimate" meta={[["Estimate no.", <span key="n" className="font-mono">{kase.max_id}-E</span>], ["Date", fdate(todayIST())], ["Valid until", fdate(validTill)]]}>
      <Rule />
      <FieldGrid fields={[
        [corporate ? "Company name" : "Customer name", corporate && cu.company_name ? cu.company_name : cu.full_name],
        ["Customer GSTIN", cu.gstin ? <span className="font-mono">{cu.gstin}</span> : ""],
        ["Mobile", cu.mobile ? prettyPhone(cu.mobile) : ""],
        ["Email", cu.email ?? ""],
      ]} />
      <Rule />
      <FieldGrid fields={[["Trip", kase.title], ["Destination", kase.destination ?? ""], ["Travel", travel],
        ["Travellers", people.length ? `${people.map((p) => p.full_name).join(", ")} (${people.length})` : ""]]} />
      {rows.some((l) => Number(l.selling_price) + Number(l.gst) === 0) && (
        <p className="no-print mt-4 rounded-lg bg-amber-50 px-3 py-2 text-[13px] text-amber-900">Some bookings have no selling price yet, so they show as ₹0. Enter the prices on the Bookings tab before sending this.</p>
      )}
      <Rule label="Price breakup" />
      {rows.length === 0 ? <p className="text-muted">No services added yet. Add bookings on the case first.</p> : (
        <Breakup total={total} totalLabel="Total payable"
          rows={[
            ...rows.map((l) => ({
              label: <>{SERVICE_LABEL[l.service as Service]}{l.summary && `: ${l.summary}`}</>,
              sub: [(l.traveller_ids as string[]).map((t) => name.get(t)).filter(Boolean).join(", "), fdate(l.service_date)].filter(Boolean).join(" · ") || undefined,
              amount: Number(l.selling_price),
            })),
            ...(gst > 0 ? [{ label: "GST", sub: "On our service charges", amount: gst }] : []),
          ]} />
      )}
      {rows.length > 0 && <p className="mt-2 text-[12.5px]"><span className="text-muted">Amount in words: </span><i>{rupeesInWords(total)}</i></p>}
      <PayTo agency={a} />
      <Terms items={[
        `Prices are valid until ${fdate(validTill)} and subject to availability when we book. Airfares can change until the ticket is issued.`,
        "Bookings are confirmed after the advance payment is received.",
        "Cancellation and change charges are as per airline, hotel and supplier rules.",
        "This is an estimate, not an invoice or a travel document.",
      ]} />
      <SignOff agency={a} note="This is a computer-generated estimate." />
    </PrintDoc>
  );
}
