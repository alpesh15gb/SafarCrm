# Max AI enquiry database verification

Run from the Safar repository after `npm ci`:

```bash
node --test tests/db/max-ai-enquiries.test.mjs
```

The harness uses the pinned development dependency `@electric-sql/pglite`
0.5.16. It creates an in-memory PostgreSQL instance; it never reads an environment
file, connects to a network database, submits a live enquiry or starts a server.

All application migrations preceding `20261117000001_max_ai_enquiries.sql` run
before the new migration is applied verbatim. PostgreSQL's `pgcrypto` and
`pg_trgm` extensions are loaded. The fixture supplies only the surrounding
Supabase infrastructure: role names/default grants, JWT functions, auth/MFA
tables, storage bucket metadata and the realtime publication. The existing
application role/MFA helpers and RLS policies run unchanged.

PGlite has no background worker scheduler, so the legacy `CREATE EXTENSION
pg_cron` statement is replaced with an inert `cron.schedule` fixture. No actual
scheduled task, email, extraction job or payment runs.

Before applying the enquiry migration, the harness creates synthetic existing
customer, case, booking, payment, expense and invoice records. It checks hashes
and counts for every pre-existing public business table and the state of its
sequences both after the migration and after all enquiry operations. This
verifies that inbox import, replay, rejected writes and staff follow-up do not
change existing transactions or consume customer/case numbering.

Coverage includes all four services, exact numeric and per-person budgets,
unknown budget, atomic inbox/financial/audit rollback, immutable replay
collisions, rejection of booking events, service-only import, direct-table RLS,
boss-only unassigned intake and assignment, scoped staff visibility, private
budget projection, MFA/password-reset/inactive/client rejection, optimistic
versions, literal filters and pagination.

Version 2 transport tests require an explicit signed `test` or `live` environment.
Test enquiries are excluded from the default live list and detail lookup; the
explicit test view retains the same role, assignment, MFA and budget controls.
Receipts echo the persisted environment, and replay cannot relabel an enquiry
even when a caller reuses its original body hash. Staff follow-up also preserves
the original environment. Legacy, missing and invalid environments are rejected.

This is actual PostgreSQL SQL and RLS validation, not a mock database. It does
not validate a live Supabase/PostgREST gateway, signing-key configuration,
multiple concurrent PostgreSQL connections, network delivery or deployment.
HTTP signature/receiver tests and deployment preflight checks are separate.

Primary runtime references: [PGlite API](https://pglite.dev/docs/api) and
[supported extensions](https://pglite.dev/extensions/).
