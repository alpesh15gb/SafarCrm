# Safar CRM

A light, web-based CRM for a small Indian travel agency (1 boss, a few staff, plus a client portal). It handles flights, hotels, visas, travel insurance, rail and bus, with one **MAX ID** per job.

**Stack:** Next.js 16 (App Router) · Tailwind CSS 4 · Supabase (Postgres, Auth, Storage, Realtime, pg_cron) · deployable to Vercel.

## Run it locally

Needs Node 20+ and Docker.

```bash
npm install
npx supabase start            # starts local Postgres/Auth/Storage; prints the keys
cp .env.example .env.local    # paste the anon and service-role keys
npm run db:reset              # applies supabase/migrations
npm run seed                  # optional demo data
npm run seed:history          # optional: 5 months of past trips so the dashboard charts have data
npm run dev                   # http://localhost:3000
```

Demo logins (after `npm run seed`, password `Safar@2026`): `boss@safar.local`, `priya@safar.local`, `amit@safar.local`.

On a fresh database with no demo data, create the first boss:

```bash
npm run create-boss -- boss@youragency.in "Your Name" "a-strong-password"
```

After that, the boss adds staff in **Settings → Users** and invites clients from a customer's page (**⋯ → Invite to portal**).

## Starting real data entry on this computer (for the live server use deploy/DEPLOY.md instead)

1. Take a backup: `npm run backup`.
2. Remove the demo data and make your own login (keeps agency settings and lists):
   `npm run clean-start -- owner@youragency.in "Owner Name" "a-strong-password" 1001`
   The last number is your first MAX ID.
3. Log in, then add staff in **Settings → Users**.
4. Back up every day. Run `crontab -e` and add:
   `0 21 * * * cd /home/alpesh/projects/SafarCrm && npm run backup`
   (9 pm daily; keeps 30 days in `backups/`. Copy that folder to a pen drive or cloud drive weekly.)

**Never run** `npm run seed`, `npm run seed:history` or `npm run db:reset` on real data. db:reset now refuses unless you confirm.

To restore a backup: `gunzip -c backups/safar-DATE.sql.gz | docker exec -i supabase_db_safarcrm psql -U postgres`, and copy the matching `backups/files-DATE/` folder back with `docker cp backups/files-DATE/. supabase_storage_safarcrm:/mnt`.

## On a Mac

- **⌘K** (or `/`) opens quick find from anywhere: MAX ID, name, phone, PNR, ticket or policy number, plus shortcuts to create things. **⌘\\** collapses the sidebar.
- **Install it like an app:** in Safari choose **File ▸ Add to Dock** (Chrome: **⋯ ▸ Cast, save and share ▸ Install page as app**). It opens in its own window with its own Dock icon, and reminders arrive as macOS notifications once allowed from the bell.

## Deploy

**Our server (crm.maxtravel.in):** follow [deploy/DEPLOY.md](deploy/DEPLOY.md). It covers a self-hosted Supabase plus the app in Docker, behind the server's nginx.

Supabase Cloud + Vercel also works: push `supabase/migrations`, turn off sign-ups, turn on TOTP MFA, and set the variables from `.env.example`.

## Where things live

| Area | Files |
| --- | --- |
| Database, row-level security, triggers, reminders, portal | `supabase/migrations/*.sql` |
| Server actions (all writes) | `src/actions/*.ts` |
| Upload, download, share links, Excel export | `src/app/api/*`, `src/app/s/[token]` |
| Team screens | `src/app/(team)/*` |
| Client portal | `src/app/portal/*` |

## How the rules are enforced

All permissions live in Postgres, so hiding a button is never the only protection.

- **Row-level security** on every table. Staff see only cases assigned to or created by them, unless the boss allows all. Only the boss can delete. Staff can assign tasks only to themselves.
- **Profit** is never stored on a row. It is calculated in views and report functions that return nothing to staff unless the boss has turned on "can see profit".
- **Client visibility.** Clients have no direct table access at all. The portal reads through `portal_*` functions that return a cleaned copy (no supplier names, costs, commission, internal notes or GDS references). Only the boss can flip "Visible to client"; a database trigger blocks staff.
- **ID numbers.** Aadhaar, PAN and passport numbers are encrypted with pgcrypto using a key the API cannot read. Aadhaar is shown masked, and only the boss can reveal it; every reveal is written to the activity log.
- **Files** sit in a private bucket and are streamed through the server after a permission check. Share links are random tokens that expire after 7 days.
- **Two-step login.** Once a user turns it on, the database treats their session as logged out until the second step is done.
- **Activity log.** Triggers record who created, changed or deleted cases, bookings, payments, files, customers, suppliers and tasks.

## Money formulas

- Line profit = selling price + commission − supplier cost (GST is shown separately and never counted as profit).
- Commission entered as % is taken on the flight's base fare when entered (airlines pay commission on base fare, not taxes), otherwise on supplier cost.
- After cancellation: (selling price − refund to client) − (supplier cost − refund from supplier).
- Case profit = sum of line profits − case expenses.
- Billed to client = selling price + GST (after cancellation: selling price − refund to client).

## Automatic reminders

`pg_cron` runs `run_auto_reminders()` every day at 06:00 IST, and `dispatch_task_alerts()` every minute to turn due alerts into bell notifications (plus browser notifications if the user allows them). The "international flight without insurance" reminder fires as soon as the flight is saved. A visa booking with an appointment date creates a high-priority task for the day before; when its status is set to Approved (with a "valid until" date), the visa is copied onto each traveller's profile so the 6-month expiry reminder covers it. Each reminder can be switched off in **Settings → Automatic reminders**.

## Not in version 1

Quotations and itinerary builder, GST invoices/TCS, accounting sync, lead capture, campaigns, WhatsApp Business API, live booking connections, multi-currency, branches, native app, Excel import.
