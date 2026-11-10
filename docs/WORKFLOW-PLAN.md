# Tasks → cases and booked-ticket import: plan

Baseline: `2fd3527` (main). Branch: `feature/task-case-ticket-import`.
Stack kept as is: Next.js 16.4 App Router, React 19.3, Tailwind 4, Supabase (Postgres RLS, Storage, pg_cron).
All changes are additive migrations. No production deploy, migration, seed or wipe.

## Assumptions

1. `cases` stays the travel job (MAX ID). A task links to at most one case through the existing `tasks.case_id`;
   many tasks may share one case. Office tasks keep `case_id` null.
2. "Required documents" = for an international case, every traveller needs a passport number and an expiry that
   is still valid on the last travel day. Nothing else is invented as "required".
3. Booking stage (`cases.status`) is untouched. The new work summary is a separate field (`cases.work_state`) plus
   a derived "up to date" state; tasks never move the stage.
4. Flight sectors stay in `booking_lines.details.sectors` / `details.tickets` (one canonical, editable source).
   New keys are added there (`arr_date`, `dep_tz`, `arr_tz`, `name_as_issued`, `source`); superseded tickets and
   sectors move to `details.ticket_history` / `details.sector_history`, written only by a database trigger.
5. The extraction provider is Anthropic's Messages API, called over `fetch` (no new npm dependency, because
   `package-lock.json` can't be regenerated on this machine). With no key configured, imports go straight
   to manual review and say what setup is missing. Nothing is ever faked as extracted.
6. Portal users may submit a ticket for themselves or a family member (the rule the portal already uses for
   document uploads).

## File-by-file

### Migrations (new, additive)
- `supabase/migrations/20261114000001_supporting_flows.sql` (slice A): customer case history with the payer or
  traveller role; corporate customers blocked as passengers by trigger; payer change keeps travellers; immutable
  `name_as_issued` and ticket or sector history; transactional `set_case_travellers`, `complete_case` with blocker
  checks and a recorded override; `base_fare` missing, zero and invalid handled the same way as in the browser;
  `pricing_state`.
- `supabase/migrations/20261114000002_task_case_links.sql` (slice B): `case_links` idempotency table,
  `create_case_from_task`, `link_task_to_case`, `suggest_cases_for_task`, `cases.work_state` and waiting fields,
  `v_case_work` summary view, `tasks.blocking`.
- `supabase/migrations/20261114000003_ticket_imports.sql` (slices C to E): `ticket_imports` table with state machine,
  RLS, durable job claim and lease functions, draft save with a version check, `confirm_ticket_import`, publication
  guards on INSERT and UPDATE, share-link guard, portal functions.
- `supabase/migrations/20261114000004_operations.sql` (slice F): segment-level `departures()`, configurable checks
  (ticket name, missing documents, waiting follow-ups) via the existing `run_auto_reminders`, and the
  worker cron schedule.
- `supabase/tests/*.sql`: pgTAP tests (`supabase test db`) for the permission and transaction scenarios.

### App
- `src/lib/money.ts`: `parseMoney` (missing, invalid, zero, value); paise-exact commission, the same as Postgres.
- `src/lib/flight-time.ts`: explicit arrival day offset from dates; legacy sectors show "arrival date not recorded".
- `src/lib/imports/*`: schema v1 + validator, PDF inspection (type, encryption, pages, text layer), provider
  adapter (`anthropic`, `none`), worker (claim, extract, validate, save, retry).
- `src/actions/cases.ts`, `tasks.ts`, `bookings.ts`, `imports.ts`: call the new RPCs.
- `src/app/api/imports/*`: upload, source preview (authorized only), and worker trigger (secret-protected).
- `src/app/(team)/imports/*`: queue and review screen (desktop side by side, mobile Source and Review tabs).
- Entry points: dashboard, cases, customer detail, case bookings, portal.
- `src/app/(team)/tasks/page.tsx`: pagination, search and exact counts in place of `limit(500)`.
- `src/components/forms/task-dialog.tsx`: customer context; link, create and open case.

Report: `docs/WORKFLOW-REPORT.md`.
