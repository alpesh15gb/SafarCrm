import { timingSafeEqual } from "node:crypto";
import { NextResponse } from "next/server";
import { runImportWorker } from "@/lib/imports/worker";

export const maxDuration = 600;   // one job can take several minutes through the gateway

/** Runs queued extraction jobs. Called by scripts/import-worker.mjs (or any scheduler) with the shared secret.
 *  Disabled (404) unless IMPORT_WORKER_SECRET is set on the server. */
export async function POST(req: Request) {
  const secret = process.env.IMPORT_WORKER_SECRET ?? "";
  const given = req.headers.get("x-worker-secret") ?? "";
  if (secret.length < 16) return new Response("Not found", { status: 404 });
  const a = Buffer.from(secret), b = Buffer.from(given);
  if (a.length !== b.length || !timingSafeEqual(a, b)) return new Response("Forbidden", { status: 403 });
  try {
    const run = await runImportWorker({ limit: 1 });
    return NextResponse.json(run);
  } catch {
    return NextResponse.json({ error: "worker run failed" }, { status: 500 });
  }
}
