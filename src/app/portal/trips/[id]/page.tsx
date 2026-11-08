import Link from "next/link";
import { notFound } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { TripView, type Trip } from "@/components/trip-view";

export const metadata = { title: "Trip details" };

export default async function PortalTrip({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const sb = await createClient();
  const { data } = await sb.rpc("portal_trip", { p_case: id });
  if (!data) notFound();
  return (
    <>
      <Link href="/portal" className="mb-3 inline-block text-xs text-muted hover:text-ink">← My trips</Link>
      <TripView trip={data as Trip} fileHref={(f) => `/api/files/${f}`} />
    </>
  );
}
