import { createAdmin } from "@/lib/supabase/server";
import { streamFile } from "@/lib/storage";

// Public share link: valid for 7 days, never reveals the storage path.
export async function GET(_req: Request, { params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;
  if (!/^[a-f0-9]{32}$/.test(token)) return new Response("Link not valid", { status: 404 });
  const admin = createAdmin();
  const { data } = await admin
    .from("share_links")
    .select("expires_at, file:files(storage_path, file_name, mime, superseded_at)")
    .eq("token", token)
    .maybeSingle();
  const f = data?.file as unknown as { storage_path: string; file_name: string; mime: string | null; superseded_at: string | null } | null;
  if (!data || !f) return new Response("This link is not valid.", { status: 404 });
  if (new Date(data.expires_at) < new Date()) return new Response("This link has expired. Please ask the office for a new one.", { status: 410 });
  if (f.superseded_at) return new Response("This ticket has been re-issued. Please ask the office for the new link.", { status: 410 });
  return streamFile(f.storage_path, f.file_name, f.mime, false);
}
