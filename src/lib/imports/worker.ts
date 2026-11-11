import "server-only";
// Durable extraction jobs. Each run claims a few imports with a lease (claim_ticket_imports), works on them, and reports
// back (finish_ticket_import). If this process dies mid-job the lease runs out and another run picks it up; after
// max_attempts the import fails with a clear message and stays open for manual entry. Nothing here depends on a browser tab.
import { randomUUID } from "node:crypto";
import { createAdmin } from "@/lib/supabase/server";
import { inspect } from "./inspect";
import { getProvider } from "./provider";
import { redactForModel } from "./redact";
import { PARSER_VERSION, SCHEMA_VERSION, toDraft } from "./schema";

export type WorkerRun = { claimed: number; reviewed: number; retried: number; failed: number };

export async function runImportWorker(opts: { limit?: number } = {}): Promise<WorkerRun> {
  const admin = createAdmin();
  const worker = `web-${process.pid}-${randomUUID().slice(0, 8)}`;
  const provider = getProvider();
  const out: WorkerRun = { claimed: 0, reviewed: 0, retried: 0, failed: 0 };
  const { data: jobs, error } = await admin.rpc("claim_ticket_imports", { p_worker: worker, p_limit: opts.limit ?? 2, p_lease_seconds: 300 });   // up to two provider calls of at most 90 s each, with room to spare
  if (error) throw new Error(`claim failed: ${error.code ?? ""}`);
  for (const job of (jobs ?? []) as { id: string; storage_path: string; mime: string }[]) {
    out.claimed++;
    const finish = async (r: Record<string, unknown>) => {
      const { data } = await admin.rpc("finish_ticket_import", { p_id: job.id, p_worker: worker, p_provider: provider.name, ...r });
      if (data === "needs_review") out.reviewed++; else if (data === "retry") out.retried++; else if (data === "failed") out.failed++;
    };
    try {
      const { data: blob, error: de } = await admin.storage.from("files").download(job.storage_path);
      if (de || !blob) { await finish({ p_ok: false, p_error_code: "source_missing", p_error_summary: "The uploaded file could not be read from storage.", p_retryable: true }); continue; }
      const bytes = new Uint8Array(await blob.arrayBuffer());
      const ins = inspect(bytes);
      if (!ins.ok) { await finish({ p_ok: false, p_error_code: ins.code, p_error_summary: ins.message, p_retryable: false }); continue; }
      if (!provider.configured) {
        await finish({ p_ok: false, p_pages: ins.pages, p_error_code: "no_provider", p_error_summary: provider.setupHint ?? "No extraction provider configured.", p_retryable: false });
        continue;
      }
      // personal identifiers in the text layer are masked before the model sees them (counts only are kept)
      const masked = ins.text ? redactForModel(ins.text) : null;
      const r = await provider.extract({ bytes, mime: ins.mime, text: masked ? masked.text : null });
      if (!r.ok) { await finish({ p_ok: false, p_pages: ins.pages, p_error_code: r.code, p_error_summary: r.message, p_retryable: r.retryable }); continue; }
      const draft = toDraft(r.output);
      await finish({
        p_ok: true, p_pages: ins.pages, p_extraction: {
          ...draft, read_from: r.mode === "text" ? "pdf text layer" : "document image (OCR)",
          // what was masked before reading (numbers only, never the values); an image is sent as it is
          masked: r.mode === "text" ? masked?.counts ?? {} : null,
        },
        p_parser_version: PARSER_VERSION, p_schema_version: SCHEMA_VERSION,
      });
    } catch {
      // no document content in errors or logs
      await finish({ p_ok: false, p_error_code: "worker_error", p_error_summary: "Something went wrong while reading the file.", p_retryable: true }).catch(() => {});
    }
  }
  return out;
}
