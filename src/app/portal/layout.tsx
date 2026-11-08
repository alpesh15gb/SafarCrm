import Link from "next/link";
import { requireClient } from "@/lib/auth";
import { createClient } from "@/lib/supabase/server";
import { PortalLogout } from "./client";

export default async function PortalLayout({ children }: { children: React.ReactNode }) {
  const me = await requireClient();
  const sb = await createClient();
  const { data } = await sb.rpc("portal_profile");
  const agency = (data as { agency?: { name: string } } | null)?.agency?.name ?? "Your travel agent";
  return (
    <div className="min-h-dvh">
      <header className="sticky top-0 z-40 border-b border-line bg-white">
        <div className="mx-auto flex h-14 max-w-3xl items-center gap-3 px-4">
          <Link href="/portal" className="flex items-center gap-2 font-semibold">
            <span className="flex h-8 w-8 items-center justify-center rounded-lg bg-coral text-white">{agency[0]}</span>
            <span className="max-sm:hidden">{agency}</span>
          </Link>
          <nav className="ml-auto flex items-center gap-1 text-sm">
            <Link href="/portal" className="rounded-lg px-3 py-1.5 hover:bg-gray-50">My trips</Link>
            <Link href="/portal/profile" className="rounded-lg px-3 py-1.5 hover:bg-gray-50">My profile</Link>
            <PortalLogout />
          </nav>
        </div>
      </header>
      <main className="mx-auto max-w-3xl px-4 py-6">
        <p className="mb-4 text-[13px] text-muted">Namaste, {me.full_name}</p>
        {children}
      </main>
    </div>
  );
}
