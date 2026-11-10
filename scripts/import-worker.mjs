// Keeps ticket-import extraction moving without anyone's browser open.
// Calls the app's worker endpoint every 30 seconds. Jobs, leases and retries live in the database, so stopping
// or restarting this script loses nothing.
//   APP_URL=http://localhost:3000 IMPORT_WORKER_SECRET=... node scripts/import-worker.mjs
const url = `${(process.env.APP_URL || "http://localhost:3000").replace(/\/$/, "")}/api/imports/worker`;
const secret = process.env.IMPORT_WORKER_SECRET;
if (!secret || secret.length < 16) {
  console.error("Set IMPORT_WORKER_SECRET (16+ characters), the same value as on the app server.");
  process.exit(1);
}
const every = Number(process.env.IMPORT_WORKER_INTERVAL_MS || 30000);

async function tick() {
  try {
    const r = await fetch(url, { method: "POST", headers: { "x-worker-secret": secret }, signal: AbortSignal.timeout(290_000) });
    const j = await r.json().catch(() => ({}));
    if (!r.ok) console.error(new Date().toISOString(), "worker", r.status);
    else if (j.claimed) console.log(new Date().toISOString(), `claimed ${j.claimed}: ${j.reviewed} to review, ${j.retried} retrying, ${j.failed} failed`);
  } catch (e) {
    console.error(new Date().toISOString(), "worker unreachable:", e instanceof Error ? e.name : "error");
  }
}

for (;;) {
  await tick();
  await new Promise((r) => setTimeout(r, every));
}
