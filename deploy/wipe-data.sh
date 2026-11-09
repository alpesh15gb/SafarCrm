#!/usr/bin/env bash
# Deletes ALL business data (test data) from the server CRM and restarts the numbering.
#   bash deploy/wipe-data.sh            first case becomes MAX-1001
#   bash deploy/wipe-data.sh 2001       first case becomes MAX-2001
#
# KEEPS: owner and staff logins (and their two-step login), agency settings, lists (airlines, airports...),
#        automatic-reminder settings, the encryption key for ID numbers.
# DELETES: cases, customers, families, suppliers, bookings, payments, expenses, tasks, files (and the uploaded
#          documents themselves), notifications, the activity log, and client portal logins.
# A full backup is taken first; if the backup fails, nothing is deleted.
# DRY_RUN=1 runs the database part and rolls it back, and deletes nothing (to check it would work).
set -euo pipefail
cd "$(dirname "$0")/.."
START="${1:-1001}"
[[ "$START" =~ ^[0-9]+$ ]] || { echo "The first MAX number must be a number, e.g. 1001"; exit 1; }
DB="${DB_CONTAINER:-supabase-db}"
API="${API_URL:-http://127.0.0.1:8100}"
DRY="${DRY_RUN:-0}"
if [ -z "${SERVICE_ROLE_KEY:-}" ]; then set -a; . deploy/.secrets; set +a; fi

# qc: one query, never reads the keyboard (so it can't swallow the WIPE answer); q: SQL fed on stdin
qc() { docker exec "$DB" psql -U supabase_admin -d postgres -v ON_ERROR_STOP=1 -qtA -c "$1" </dev/null; }
q() { docker exec -i "$DB" psql -U supabase_admin -d postgres -v ON_ERROR_STOP=1 -qtA; }

echo "This will DELETE from the CRM:"
qc "select '  ' || (select count(*) from public.cases) || ' cases, ' || (select count(*) from public.customers) || ' customers, '
         || (select count(*) from public.suppliers) || ' suppliers, ' || (select count(*) from public.booking_lines) || ' bookings, '
         || (select count(*) from public.payments) || ' payments, ' || (select count(*) from public.tasks) || ' tasks, '
         || (select count(*) from storage.objects where bucket_id = 'files') || ' uploaded files, '
         || (select count(*) from public.profiles where role = 'client') || ' client portal logins'"
echo "It KEEPS these logins:"
qc "select '  ' || email || ' (' || role || ')' from public.profiles where role in ('boss','staff') order by role, email"
echo "The first new case will be MAX-$START and the first new customer C-0001."
[ "$DRY" = 1 ] && echo "(DRY RUN: nothing will actually be deleted)"
read -r -p "Type WIPE to continue: " ok
[ "$ok" = "WIPE" ] || { echo "Cancelled. Nothing was changed."; exit 1; }

if [ "$DRY" != 1 ]; then
  echo "• Taking a backup first"
  bash deploy/backup.sh
  docker stop safar-crm >/dev/null 2>&1 || true   # nobody can type into the CRM while it is being cleared
fi

# collected before the wipe: uploaded files (100 per request) and client portal logins
FILE_BATCHES=$(qc "select json_build_object('prefixes', json_agg(name)) from (select name, (row_number() over (order by name) - 1) / 100 as b
                     from storage.objects where bucket_id = 'files') x group by b")
CLIENTS=$(qc "select id from public.profiles where role = 'client'")

echo "• Clearing the CRM data"
# profiles.customer_id points at customers, so TRUNCATE ... CASCADE would also empty profiles (every login).
# The link is detached for the wipe and put back. One transaction: if anything fails, nothing changes.
q <<SQL
begin;
update public.profiles set customer_id = null;
alter table public.profiles drop constraint profiles_customer_fk;
truncate public.payment_allocations, public.payments, public.expenses, public.share_links, public.files,
         public.task_comments, public.tasks, public.notifications, public.booking_lines, public.case_travellers,
         public.cases, public.customer_documents, public.customers, public.families, public.suppliers, public.activity_log
         restart identity cascade;
alter table public.profiles add constraint profiles_customer_fk foreign key (customer_id) references public.customers (id) on delete set null;
do \$\$ begin
  if not exists (select 1 from public.profiles where role = 'boss' and active) then raise exception 'owner login missing; stopping'; end if;
end \$\$;
$([ "$DRY" = 1 ] && echo "rollback;" || printf "select setval('public.max_seq', %s, false);\nselect setval('public.customer_code_seq', 1, false);\ncommit;" "$START")
SQL

if [ "$DRY" = 1 ]; then
  echo "Dry run OK: the database part works (rolled back). $(echo "$FILE_BATCHES" | grep -c prefixes || true) file batch(es) and $(echo "$CLIENTS" | grep -c . || true) client login(s) would be removed."
  exit 0
fi

echo "• Removing uploaded files"
fail=0
while IFS= read -r batch; do
  [ -n "$batch" ] || continue
  curl -fsS -X DELETE "$API/storage/v1/object/files" -H "apikey: $SERVICE_ROLE_KEY" -H "Authorization: Bearer $SERVICE_ROLE_KEY" \
       -H "Content-Type: application/json" -d "$batch" >/dev/null || fail=1
done <<< "$FILE_BATCHES"
[ $fail = 0 ] || echo "  Some files could not be removed (the CRM data is cleared; leftover files only take disk space)."

echo "• Removing client portal logins"
for id in $CLIENTS; do
  curl -fsS -X DELETE "$API/auth/v1/admin/users/$id" -H "apikey: $SERVICE_ROLE_KEY" -H "Authorization: Bearer $SERVICE_ROLE_KEY" >/dev/null \
    || echo "  Could not remove client login $id"
done

docker start safar-crm >/dev/null 2>&1 || true
echo "✓ Done. $(qc 'select count(*) from public.cases') cases, $(qc 'select count(*) from public.customers') customers left; the next case will be MAX-$START."
echo "  The backup taken just before is in ${BACKUP_DIR:-/var/backups/safar-crm} (restore with deploy/restore.sh if needed)."
