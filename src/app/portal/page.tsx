import Link from "next/link";
import { createClient } from "@/lib/supabase/server";
import { Card, Empty, StatusBadge } from "@/components/ui";
import { fdate } from "@/lib/format";

export const metadata = { title: "My trips" };

export default async function PortalHome() {
  const sb = await createClient();
  const { data } = await sb.rpc("portal_trips");
  const trips = (data ?? []) as { id: string; max_id: string; title: string; status: string; travel_start: string | null; travel_end: string | null; destination: string | null }[];
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
    </>
  );
}
