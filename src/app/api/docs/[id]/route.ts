import { createClient } from "@/lib/supabase/server";
import { streamFile } from "@/lib/storage";

export async function GET(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const sb = await createClient();
  const { data } = await sb.rpc("document_access", { p_doc: id });
  const f = data?.[0];
  if (!f) return new Response("Not found", { status: 404 });
  return streamFile(f.storage_path, f.file_name ?? "document", f.mime, new URL(req.url).searchParams.has("dl"));
}
