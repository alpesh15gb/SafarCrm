# MaxTravel website enquiries

This integration is for **Safar CRM** (`alpesh15gb/SafarCrm`). Booking is still in testing; Safar contains real transactions.

The inbox at `/enquiries` stores visa, insurance, holiday and cruise requests in three new isolated tables. It does not create or update customers, cases, tasks, bookings, invoices or payments. There is no automatic conversion into a native business record.

The default **Live enquiries** view excludes test submissions. **Test enquiries** is a separate, explicitly labelled view. The schema-version 2 signed envelope requires `environment: test|live`; the receiver records that value immutably. Retries cannot relabel test data when the booking site later switches to live.

Unassigned enquiries are visible to the boss, who can assign them. Assigned staff use existing access scope, MFA and password-change rules. Contact values remain unverified. Structured budgets are in a private table and appear only to staff with existing profit visibility.

## Configuration and deployment

The receiver is `POST /api/integrations/max-ai/enquiries`. Its only proxy exception is that exact path. It validates a bounded raw body, HMAC signature, timestamp and event identity before invoking the service-role ingestion RPC. Generic 200 responses are not delivery receipts.

Add `SAFAR_MAX_AI_SIGNING_KEYS` to `deploy/.env.production` as a private JSON object mapping dedicated key IDs to secrets of at least 32 characters. Do not reuse or overwrite Supabase, import-worker or legacy CRM keys. The booking repository includes a helper that creates a matching pair and preserves other settings without displaying secrets.

Follow the current [booking deployment guide](https://github.com/alpesh15gb/MaxTripJack/blob/main/booking-platform/docs/MAX-AI-ENQUIRIES.md). It configures the two private environment files, retains the running Safar image, runs the existing backup/migration/deploy procedure, deploys booking, performs a signed **no-write** connection check and then starts only the dedicated enquiry worker. Keep the old booking CRM worker stopped and preserve its 16 queued booking test events.

The additive migration is `20261117000001_max_ai_enquiries.sql`. Run it using the established `deploy/deploy.sh` procedure and its migration ledger. Do not run reset, seed, clean-start or database restore commands against the live instance. A routine application rollback retains the new tables and data; restoring an older database can lose real transactions made since the backup.

## Verification

The booking diagnostic signs a deliberately invalid `{}` body. Correct signing and routing produce HTTP 400 with `Check the enquiry details.` before database ingestion. This proves connectivity and signature validation without creating a record. It does not prove live ingestion permissions or the entire delivery flow.

An explicitly submitted website test enquiry should appear exactly once under **Test enquiries**, retaining its `ME-` reference and unverified contact label. Live enquiries and transaction registers should remain unchanged. Status/notes are independent of the booking site's local enquiry status; this release does not claim two-way synchronisation.

Local verification includes 51 unit tests, 20 desktop/mobile UI cases, production build, TypeScript and lint (existing warnings only). The PostgreSQL harness executes all 50 migrations in PGlite and passes 11 tests for replay, test/live isolation, assignment, permissions and finance projection. Fingerprints of 25 pre-existing business tables and numbering sequences remain unchanged. Browser tests use the real inbox component with synthetic responses, no production auth bypass and no live customer data. The harness does not model multi-connection races or production Supabase/PostgREST networking.
