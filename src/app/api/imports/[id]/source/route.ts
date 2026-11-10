import { getMe } from "@/lib/auth";
import { createClient } from "@/lib/supabase/server";
import { streamFile } from "@/lib/storage";

/** Private preview of an import's original file: only reviewers who may see the import, and its uploader. Never cached. */
export async function GET(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const me = await getMe();
  if (!me || me.mfa_pending) return new Response("Please log in again.", { status: 401 });
  const { id } = await ctx.params;
  const sb = await createClient();
  const { data } = await sb.rpc("import_source_access", { p_import: id });
  const f = (data ?? [])[0] as { storage_path: string; file_name: string; mime: string } | undefined;
  if (!f) return new Response("Not found", { status: 404 });
  const download = new URL(req.url).searchParams.get("download") === "1";
  return streamFile(f.storage_path, f.file_name, f.mime, download);
}
