# Tasks → cases and booked-ticket import: report

Branch `feature/task-case-ticket-import`, three commits on top of `2fd3527`. Nothing deployed, no production migration, no seed or wipe.

## Verification status: read this first
This machine has no Node.js, no npm, no Python and no running Docker. So **nothing has been compiled, linted, built,
migrated or tested**: not `tsc`, not `next build`, not the unit tests, not `supabase db reset`, not the pgTAP tests.
The code was reviewed by reading it. Expect some type and SQL errors on the first run. Treat this as an unverified draft.

## What changed and why
**A. Supporting flows** (`20261114000001_supporting_flows.sql`)
- `customer_case_history()`: one row per case, labelled payer, traveller, or payer and traveller. Row-level security applies.
- A trigger blocks a company from being a passenger on a case or on a booking. A booking can only add people who are already travellers on its case. Changing the payer no longer adds the payer as a traveller.
- Arrival day: `arr_date`, `dep_tz` and `arr_tz` are stored on each sector. The day shift comes only from `arr_date`; the old "arrival time < departure time" rule is gone. Airport time zones were added where they are certain. Unknown values stay unknown.
- `name_as_issued` cannot be changed for a ticket number. Removed or reissued tickets go to `ticket_history`, and changed itineraries go to `sector_history`. Only the trigger writes these, on every write path. Profile renames change only the display name.
- Adding a traveller inline from a booking keeps what was typed in the form. A background refresh no longer resets the dialog.
- Transactions: `create_case` (idempotent request key), `set_case_travellers`, `cancel_case`, `create_case_from_task`, `confirm_ticket_import`, `complete_case`.
- Money: `parseMoney` tells missing, invalid and zero apart. Rounding is exact to the paisa and matches Postgres. A missing base fare uses the supplier cost; a base fare of 0 means 0; text is refused in both the browser and the database. `pricing_state` flags bookings nobody has priced.

**A6 readiness** (`case_readiness` / `complete_case` in migration 3)
- **Blockers:** required (blocking) tasks, unreviewed imports, and missing passport details on international trips. Only the boss can override these.
- **Loose ends:** pending bookings, unpriced bookings, money due. Any staff member who can see the case can close past these with a reason.
- **Optional:** follow-up tasks, which never block.
- Every override is written to the activity log. A direct status update to Completed is refused.

**B. Tasks to cases** (`20261114000002_task_case_links.sql`)
- Tasks can carry a customer.
- New actions: create case from task (idempotent per task), link to case, move with a reason (audited on both cases), and suggested existing trips. Linking never completes a task.
- Work summary `cases.work_state` (new / in_progress / waiting_customer / waiting_supplier) is separate from the booking stage. "Up to date" is derived from the open work.
- Waiting requires a reason and a follow-up time; the follow-up becomes a task.
- Case cards show the work summary: next action and due time, overdue count, pending imports and the main blocker.

**C to E. Ticket import** (`20261114000003_ticket_imports.sql`, `src/lib/imports/*`, `/imports`, `/api/imports/*`)
- **Upload:** the real file type is checked from its bytes. Limits are 10 MB and 10 pages. Password-protected, damaged, cut-off and unsupported files get clear messages.
- **Storage and jobs:** files are stored privately under `imports/`, with a SHA-256 checksum. Each upload creates a persisted job with a state machine.
- **Worker:** jobs are claimed with a lease and retried with backoff, then fail with a message that leaves manual entry open. The upload triggers a run straight away (`after()`), and `scripts/import-worker.mjs` covers anything left queued.
- **Reading:** readable PDF text is used first. Scans and photos are sent as the document image.
- **Extraction format:** a versioned schema (`ticket-extract/1`) whose values keep their page, evidence and original reading, plus flags. No confidence scores.
- **Review screen:** the source sits beside the editable fields on desktop; mobile has Source and Review tabs. Drafts are saved with version checks.
- **Matching:** payer and travellers are matched separately, with no automatic merging. Possible matches are only suggestions.
- **Choices:** existing or new MAX ID, explicit stage, new / update / reissue (update and reissue need a field-by-field comparison), agency-booked or customer-booked, and an agency charge only when confirmed.
- **Confirm:** one transaction, idempotent with a key and version check. Probable duplicates are matched on ticket number, or on PNR plus date (never PNR alone).
- **Never created from a ticket:** price, cost, payable, GST, commission, receipt or refund. Amounts are kept as evidence only.
- **Publication:** guarded on INSERT and UPDATE. Imports and staff replacements stay private, and an approved file is not superseded until the replacement is published. Share links are blocked for unpublished files. The source preview is authorized per import.
- **Portal:** clients submit for themselves or their family and see only a plain status.

**F. Operations** (`20261114000004_operations.sql`)
- `departures()` lists each flight leg and each rail or bus journey. `service_dates()` lists hotel and visa dates separately.
- `run_workflow_checks()` runs every 15 minutes: ticket name against passport, missing passport details, and waiting follow-ups. Each auto task is deduplicated with an `auto_key`.
- The Tasks page has pagination, search and exact counts.
- The dashboard shows departures by flight leg and the tickets waiting for review.

## Extraction provider setup
1. Set on the server: `EXTRACTION_PROVIDER=anthropic`, `ANTHROPIC_API_KEY=...`, optionally `EXTRACTION_MODEL` (default `claude-opus-5-5`).
2. Set `IMPORT_WORKER_SECRET` (16+ characters) and run `npm run import-worker` next to the app (needs a service in `deploy/docker-compose.yml`; not added).
3. Without a key, every import shows the setup message and goes to manual entry. Nothing is faked.
4. The adapter calls the Messages API with `fetch`, not `@anthropic-ai/sdk`, because the lockfile couldn't be regenerated here.
5. Tickets contain personal data and are sent to Anthropic for extraction. Check this against your data policy before enabling it.

## Tests written (not run)
- `npm run test:unit` (Node 22.6+): money parsing and rounding, the four arrival-date scenarios, and the extraction structure for return and multi-city trips with flags.
- `npm run test:db` (`supabase test db`, pgTAP): 51 assertions as boss, staff A, staff B, own client and unrelated client. They cover acceptance scenarios 1–4, 7–16 at the database level.

## Not finished / not verified
- Every item above is unverified (see the top of this file). There is no desktop or mobile walkthrough, no real or redacted ticket sample, and OCR has not been run.
- The PDF text extractor is minimal: it reads only Flate-encoded and plain text. Anything else falls back to sending the document image.
- No scheduled purge for rejected or abandoned import files. Files are kept as evidence; an orphan from a failed upload is removed straight away.
- Payment and expense inputs still refuse unreadable text with the old "Enter an amount" message, not the new wording.
- Changing an existing traveller's customer type to corporate is not blocked.
- The issued-name backfill uses the names currently stored on tickets, which the old rename trigger may already have rewritten.
- Out of scope, as agreed: supplier advance allocation, financial confidentiality, an SLA engine.

## Rollback / recovery
- The code changes revert cleanly; the migrations are additive.
- To back out in the database:
  - Drop the triggers `t_flight_identity`, `t_guard_passengers`, `t_guard_task_case`, `t_guard_case_completion`, `t_guard_client_view_insert`, `t_supersede_on_publish` and `t_guard_share_link`.
  - Unschedule `safar-workflow-checks`.
  - New tables (`ticket_imports`, `case_requests`) and new columns can stay unused.
- Take `npm run backup` before applying the migrations anywhere real.

## Reviewer checklist
- [ ] `npm ci && npx tsc --noEmit && npm run lint && npm run build`
- [ ] `npx supabase db reset` on a local copy, then `npm run test:db` and `npm run test:unit`
- [ ] Manual booking create, edit, cancel and reinstate still work (sectors without `arr_date`)
- [ ] Task → case conversion with a double click; link a second task; move with a reason
- [ ] Import a redacted PDF and a phone photo with the provider configured; then with no key (manual path)
- [ ] Staff cannot publish or share an imported file; the boss can; the portal shows it only once published
- [ ] Completing a case with a blocking task as staff (refused) and as boss (with a reason, logged)
- [ ] Decide whether the 15-minute workflow checks should be enabled in production
