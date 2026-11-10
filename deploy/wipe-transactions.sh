#!/usr/bin/env bash
# Deletes only the TRANSACTIONS from the server CRM, keeping customers and suppliers.
#   bash deploy/wipe-transactions.sh          first case becomes MAX-1001
#   bash deploy/wipe-transactions.sh 2001     first case becomes MAX-2001
#   DRY_RUN=1 bash deploy/wipe-transactions.sh   checks it would work, deletes nothing
#
# DELETES: cases (MAX IDs), bookings, travellers on trips, client payments / receipts / refunds, supplier payments
#          (including advances), expenses, files uploaded to cases, tasks that belong to a case, notifications,
#          and the history (activity log) of all of these.
# KEEPS:   customers, families, employees and their documents (passport, Aadhaar...), suppliers and their agreements
#          and rate sheets, every login (boss, staff, client portal), settings, lists, office tasks without a MAX ID.
# Numbering: the next case is MAX-<start> and the next receipt R-1. Customer codes (C-0001...) are not changed.
# A full backup is taken first; if the backup fails, nothing is deleted.
set -euo pipefail
cd "$(dirname "$0")/.."
START="${1:-1001}"
[[ "$START" =~ ^[0-9]+$ ]] || { echo "Use: bash deploy/wipe-transactions.sh 1001   (the first new MAX number)"; exit 1; }
DB="${DB_CONTAINER:-supabase-db}"
API="${API_URL:-http://127.0.0.1:8100}"
DRY="${DRY_RUN:-0}"
if [ -z "${SERVICE_ROLE_KEY:-}" ]; then set -a; . deploy/.secrets; set +a; fi

qc() { docker exec "$DB" psql -U supabase_admin -d postgres -v ON_ERROR_STOP=1 -qtA -c "$1" </dev/null; }
q() { docker exec -i "$DB" psql -U supabase_admin -d postgres -v ON_ERROR_STOP=1 -qtA; }

echo "This will DELETE these transactions:"
qc "select '  ' || (select count(*) from public.cases) || ' cases, ' || (select count(*) from public.booking_lines) || ' bookings, '
         || (select count(*) from public.payments where direction = 'in') || ' client payments, '
         || (select count(*) from public.payments where direction = 'out') || ' supplier payments, '
         || (select count(*) from public.expenses) || ' expenses, '
         || (select count(*) from public.files where case_id is not null) || ' case files, '
         || (select count(*) from public.tasks where case_id is not null) || ' case tasks'"
echo "It KEEPS:"
qc "select '  ' || (select count(*) from public.customers) || ' customers (with ' || (select count(*) from public.customer_documents) || ' documents), '
         || (select count(*) from public.suppliers) || ' suppliers, ' || (select count(*) from auth.users) || ' logins, '
         || (select count(*) from public.tasks where case_id is null) || ' tasks without a MAX ID'"
echo "The next case will be MAX-$START and the next receipt R-1."
[ "$DRY" = 1 ] && echo "(DRY RUN: nothing will actually be deleted)"
read -r -p "Type DELETE to continue: " ok
[ "$ok" = "DELETE" ] || { echo "Cancelled. Nothing was changed."; exit 1; }

if [ "$DRY" != 1 ]; then
  echo "• Taking a backup first"
  bash deploy/backup.sh
  docker stop safar-crm >/dev/null 2>&1 || true   # nobody can type into the CRM while it is being cleared
fi

# uploaded case files whose scan is not also a customer document or a supplier file (those are kept), 100 per request
FILE_BATCHES=$(qc "select json_build_object('prefixes', json_agg(storage_path)) from (
                     select storage_path, (row_number() over (order by storage_path) - 1) / 100 as b
                     from (select distinct f.storage_path from public.files f where f.case_id is not null
                           and not exists (select 1 from public.customer_documents d where d.storage_path = f.storage_path)
                           and not exists (select 1 from public.files s where s.case_id is null and s.storage_path = f.storage_path)) x) y
                   group by b")

echo "• Clearing the transactions"
# One transaction: if anything fails, nothing changes. Deleting a case also deletes its bookings, travellers,
# client payments, expenses, files and tasks (database cascades, the same as "Delete case" in the CRM).
q <<SQL
begin;
delete from public.payments where direction = 'out';
delete from public.cases;
delete from public.notifications;
delete from public.activity_log
  where case_id is not null or entity in ('case', 'booking_line', 'payment', 'expense', 'file', 'task');
do \$\$ begin
  if exists (select 1 from public.cases) or exists (select 1 from public.payments) or exists (select 1 from public.booking_lines) then
    raise exception 'transactions still present; stopping';
  end if;
end \$\$;
$([ "$DRY" = 1 ] && echo "rollback;" || printf "do \$\$ begin perform setval('public.max_seq', %s, false); perform setval('public.receipt_seq', 1, false); end \$\$;\ncommit;" "$START")
SQL

if [ "$DRY" = 1 ]; then
  echo "Dry run OK: the database part works (rolled back). $(echo "$FILE_BATCHES" | grep -c prefixes || true) batch(es) of case files would be removed."
  exit 0
fi

echo "• Removing files that were uploaded to cases"
fail=0
while IFS= read -r batch; do
  [ -n "$batch" ] || continue
  curl -fsS -X DELETE "$API/storage/v1/object/files" -H "apikey: $SERVICE_ROLE_KEY" -H "Authorization: Bearer $SERVICE_ROLE_KEY" \
       -H "Content-Type: application/json" -d "$batch" >/dev/null || fail=1
done <<< "$FILE_BATCHES"
[ $fail = 0 ] || echo "  Some files could not be removed (the transactions are cleared; leftover files only take disk space)."

docker start safar-crm >/dev/null 2>&1 || true
echo "✓ Done. $(qc 'select count(*) from public.cases') cases and $(qc 'select count(*) from public.payments') payments left;"
echo "  $(qc 'select count(*) from public.customers') customers and $(qc 'select count(*) from public.suppliers') suppliers kept. The next case will be MAX-$START."
echo "  The backup taken just before is in ${BACKUP_DIR:-/var/backups/safar-crm} (restore with deploy/restore.sh if needed)."
