import Link from "next/link";
import { createClient } from "@/lib/supabase/server";
import { Badge, Card, Empty, StatusBadge } from "@/components/ui";
import { fdate, fdatetime } from "@/lib/format";
import { PortalTicketUpload } from "./client";

export const metadata = { title: "My trips" };

export default async function PortalHome() {
  const sb = await createClient();
  const [{ data }, { data: prof }, { data: fam }, { data: mine }] = await Promise.all([
    sb.rpc("portal_trips"), sb.rpc("portal_profile"), sb.rpc("portal_family"), sb.rpc("portal_my_imports"),
  ]);
  const trips = (data ?? []) as { id: string; max_id: string; title: string; status: string; travel_start: string | null; travel_end: string | null; destination: string | null }[];
  const p = (prof ?? {}) as { full_name?: string; allow_uploads?: boolean };
  const family = ((fam ?? []) as { id: string; full_name: string; relation: string | null }[]).map(({ id, full_name, relation }) => ({ id, full_name, relation }));
  const sent = (mine ?? []) as { id: string; file_name: string; status: string; created_at: string }[];
  return (
    <>
      <h1 className="mb-4 text-xl font-semibold">My trips</h1>
      <Card pad={false}>
        {trips.length === 0 ? <Empty text="Your trips will appear here once your booking is confirmed." /> : (
          <ul>
            {trips.map((t) => (
              <li key={t.id}>
                <Link href={`/portal/trips/${t.id}`} className="flex items-center gap-3 border-b border-line px-4 py-3 last:border-0 hover:bg-gray-50">
                  <div className="min-w-0 flex-1">
                    <div className="font-mono text-[13px] font-semibold">{t.max_id}</div>
                    <div className="truncate">{t.title}</div>
                    <div className="text-xs text-muted">{t.travel_start ? `${fdate(t.travel_start)}${t.travel_end ? " → " + fdate(t.travel_end) : ""}` : "Dates to be confirmed"}{t.destination && ` · ${t.destination}`}</div>
                  </div>
                  <StatusBadge status={t.status} />
                </Link>
              </li>
            ))}
          </ul>
        )}
      </Card>
      {p.allow_uploads && (
        <Card title="Booked a flight yourself?" sub="Send us the ticket and we'll add it to your trip after checking it." className="mt-4">
          <PortalTicketUpload me={{ id: "", full_name: p.full_name ?? "Me" }} family={family} />
          {sent.length > 0 && (
            <ul className="mt-3 divide-y divide-line text-sm">
              {sent.map((s) => (
                <li key={s.id} className="flex flex-wrap items-center gap-2 py-2">
                  <span className="min-w-0 flex-1 truncate">{s.file_name}</span>
                  <span className="text-xs text-muted">{fdatetime(s.created_at)}</span>
                  <Badge tone={s.status === "added" ? "green" : s.status === "with the office" ? "amber" : "grey"}>{s.status}</Badge>
                </li>
              ))}
            </ul>
          )}
        </Card>
      )}
    </>
  );
}
