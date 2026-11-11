import Link from "next/link";
import { requireTeam } from "@/lib/auth";
import { createClient } from "@/lib/supabase/server";
import { Card, Chips, Empty, PageHeader, Pager, StatusBadge, Table } from "@/components/ui";
import { TicketUploadButton } from "@/components/ticket-upload";
import { getProvider } from "@/lib/imports/provider";
import { fdatetime } from "@/lib/format";

export const metadata = { title: "Ticket imports" };
const PER_PAGE = 25;
const OPEN = ["received", "processing", "needs_review", "failed"];

type Row = {
  id: string; status: string; channel: string; file_name: string; created_at: string; error_summary: string | null; pages: number | null;
  case: { id: string; max_id: string } | null; customer: { id: string; full_name: string } | null; uploader: { full_name: string } | null;
};

export default async function ImportsPage({ searchParams }: { searchParams: Promise<{ status?: string; page?: string }> }) {
  await requireTeam();
  const sp = await searchParams;
  const sb = await createClient();
  const page = Math.max(1, Number(sp.page) || 1);
  const status = sp.status ?? "";
  let q = sb.from("ticket_imports")
    .select("id, status, channel, file_name, created_at, error_summary, pages, case:cases(id, max_id), customer:customers(id, full_name), uploader:profiles!ticket_imports_uploaded_by_fkey(full_name)", { count: "exact" });
  q = status ? q.eq("status", status) : q.in("status", OPEN);
  const { data, count, error } = await q.order("created_at", { ascending: false }).range((page - 1) * PER_PAGE, page * PER_PAGE - 1);
  const rows = (data ?? []) as unknown as Row[];
  const provider = getProvider();
  const { data: acc } = await sb.rpc("import_accuracy", { p_days: 30 });
  const accuracy = acc as Accuracy | null;

  return (
    <>
      <PageHeader title="Ticket imports" sub="Tickets booked outside the CRM: upload, check what was read, match, confirm." action={<TicketUploadButton variant="primary" />} />
      {!provider.configured && (
        <p className="mb-4 rounded-lg bg-amber-50 px-3 py-2 text-[13px] text-amber-900">{provider.setupHint}</p>
      )}
      <div className="mb-3">
        <Chips param="status" current={status} base={sp} allLabel="Open" items={[
          { value: "needs_review", label: "Needs review" }, { value: "failed", label: "Needs manual entry" }, { value: "processing", label: "Reading" },
          { value: "confirmed", label: "Confirmed" }, { value: "rejected", label: "Rejected" }, { value: "duplicate", label: "Duplicates" },
        ]} />
      </div>
      <Card pad={false}>
        {error ? <p role="alert" className="p-4 text-sm text-red-700">Imports could not be loaded. Refresh to try again.</p>
          : rows.length === 0 ? <Empty text={status ? "Nothing here." : "No tickets waiting. Upload one when a customer or supplier sends it."} action={<TicketUploadButton />} />
          : (
            <Table head={["File", "Status", "For", "From", "Uploaded"]}>
              {rows.map((r) => (
                <tr key={r.id} className="relative">
                  <td data-label="File">
                    <Link href={`/imports/${r.id}`} className="font-medium after:absolute after:inset-0">{r.file_name}</Link>
                    {r.error_summary && r.status !== "confirmed" && <div className="max-w-md truncate text-xs text-muted">{r.error_summary}</div>}
                  </td>
                  <td data-label="Status"><StatusBadge status={r.status} /></td>
                  <td data-label="For">{r.case ? <span className="font-mono text-[13px] font-semibold">{r.case.max_id}</span> : r.customer?.full_name ?? <span className="text-muted">Not matched yet</span>}</td>
                  <td data-label="From">{r.channel === "portal" ? "Client portal" : r.uploader?.full_name ?? "—"}</td>
                  <td data-label="Uploaded" className="whitespace-nowrap">{fdatetime(r.created_at)}</td>
                </tr>
              ))}
            </Table>
          )}
        <Pager page={page} total={count ?? rows.length} perPage={PER_PAGE} base={sp} />
      </Card>
      {accuracy && accuracy.imports > 0 && <AccuracyCard a={accuracy} />}
    </>
  );
}

type Accuracy = {
  imports: number; untouched: number; fields_read: number; fields_changed: number;
  median_minutes_to_confirm: number | null; most_corrected: { field: string; times: number }[];
};

const FIELD_LABELS: Record<string, string> = {
  "segments.*.from": "Departure airport", "segments.*.to": "Arrival airport", "segments.*.dep_date": "Departure date",
  "segments.*.dep_time": "Departure time", "segments.*.arr_date": "Arrival date", "segments.*.arr_time": "Arrival time",
  "segments.*.flight_no": "Flight number", "segments.*.airline": "Airline", "segments.*.cabin": "Cabin", "segments.*.baggage": "Baggage",
  "segments.*.fare_basis": "Fare basis", "passengers.*.name_as_issued": "Passenger name", "passengers.*.pax_type": "Passenger type",
  "passengers.*.tickets.*.number": "Ticket number", "airline_pnrs.*": "Airline PNR", "supplier_refs.*": "Supplier reference",
  "amounts.*.amount": "Amount", "amounts.*.currency": "Currency", "issue_date": "Issue date",
};
const label = (f: string) => FIELD_LABELS[f] ?? f.replace(/\.\*/g, "").replace(/[._]/g, " ");

/** How well ticket reading works over the last 30 days: what share needed no correction, and which fields get fixed most. */
function AccuracyCard({ a }: { a: Accuracy }) {
  const pctRight = a.fields_read > 0 ? Math.max(0, Math.round(100 * (1 - a.fields_changed / a.fields_read))) : null;
  return (
    <Card className="mt-4">
      <div className="mb-2 text-sm font-semibold">Reading accuracy, last 30 days</div>
      <div className="grid grid-cols-2 gap-3 text-[13px] sm:grid-cols-4">
        <div><div className="text-lg font-semibold">{a.imports}</div><div className="text-muted">tickets confirmed</div></div>
        <div><div className="text-lg font-semibold">{a.untouched}</div><div className="text-muted">confirmed with no corrections</div></div>
        <div><div className="text-lg font-semibold">{pctRight === null ? "—" : `${pctRight}%`}</div><div className="text-muted">of fields kept as read</div></div>
        <div><div className="text-lg font-semibold">{a.median_minutes_to_confirm ?? "—"}{a.median_minutes_to_confirm !== null && " min"}</div><div className="text-muted">typical time from reading to confirming</div></div>
      </div>
      {a.most_corrected.length > 0 && (
        <p className="mt-3 text-[13px] text-muted">
          Most corrected: {a.most_corrected.map((f) => `${label(f.field)} (${f.times})`).join(", ")}.
        </p>
      )}
      <p className="mt-2 text-xs text-muted">Counts only. The values staff changed are not stored. Time to confirm includes time the ticket waited in the list.</p>
    </Card>
  );
}
