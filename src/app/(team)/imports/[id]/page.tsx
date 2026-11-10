import { notFound } from "next/navigation";
import { requireTeam } from "@/lib/auth";
import { createClient } from "@/lib/supabase/server";
import { PageHeader, StatusBadge } from "@/components/ui";
import { emptyDraft, type Draft } from "@/lib/imports/schema";
import { getProvider } from "@/lib/imports/provider";
import { ReviewScreen, type ImportRow } from "./review";

export const metadata = { title: "Review ticket" };

export default async function ImportReviewPage({ params }: { params: Promise<{ id: string }> }) {
  const me = await requireTeam();
  const { id } = await params;
  const sb = await createClient();
  const { data } = await sb.from("ticket_imports")
    .select("id, status, channel, file_name, mime, pages, error_code, error_summary, draft, draft_version, extraction, provider, parser_version, schema_version, attempts, result, reject_reason, created_at, case_id, customer_id, booking_line_id, case:cases(id, max_id, title, customer_id), customer:customers(id, full_name, mobile, customer_type)")
    .eq("id", id).maybeSingle();
  if (!data) notFound();   // also when the import exists but this person may not see it
  const row = data as unknown as ImportRow;
  const provider = getProvider();
  return (
    <>
      <PageHeader back={{ href: "/imports", label: "Ticket imports" }} title={<span className="flex flex-wrap items-center gap-2">{row.file_name} <StatusBadge status={row.status} /></span>}
        sub={row.channel === "portal" ? "Sent by the client from the portal" : undefined} />
      <ReviewScreen row={row} initialDraft={(row.draft as Draft | null) ?? emptyDraft()} isBoss={me.role === "boss"}
        providerHint={provider.configured ? null : provider.setupHint ?? null} />
    </>
  );
}
