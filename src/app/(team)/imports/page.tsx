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
    </>
  );
}
