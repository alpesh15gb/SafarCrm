#!/usr/bin/env bash
# Deletes ALL business data (test data) from the server CRM and restarts the numbering.
#   bash deploy/wipe-data.sh            first case becomes MAX-1001
#   bash deploy/wipe-data.sh 2001       first case becomes MAX-2001
#   bash deploy/wipe-data.sh 1001 --new-owner owner@maxtravel.in "Owner Name"
#        also removes EVERY login (boss, staff, clients) and creates one new owner login; you are asked for its
#        password (hidden). The new owner is created before the old logins are removed, so there is always a way in.
#
# KEEPS: owner and staff logins (and their two-step login), agency settings, lists (airlines, airports...),
#        automatic-reminder settings, the encryption key for ID numbers.
# DELETES: cases, customers, families, suppliers, bookings, payments, expenses, tasks, files (and the uploaded
#          documents themselves), notifications, the activity log, and client portal logins.
# A full backup is taken first; if the backup fails, nothing is deleted.
# DRY_RUN=1 runs the database part and rolls it back, and deletes nothing (to check it would work).
set -euo pipefail
cd "$(dirname "$0")/.."
. deploy/instance.sh
START=1001; NEW_EMAIL=""; NEW_NAME=""
while [ $# -gt 0 ]; do
  case "$1" in
    --new-owner) NEW_EMAIL="${2:-}"; NEW_NAME="${3:-}"; shift 3 || { echo 'Use: --new-owner owner@maxtravel.in "Owner Name"'; exit 1; } ;;
    [0-9]*) START="$1"; shift ;;
    *) echo "Not understood: $1"
       echo 'Use:  bash deploy/wipe-data.sh 1001'
       echo '  or: bash deploy/wipe-data.sh 1001 --new-owner owner@maxtravel.in "Owner Name"   (type --new-owner exactly like this)'
       exit 1 ;;
  esac
done
[[ "$START" =~ ^[0-9]+$ ]] || { echo "The first MAX number must be a number, e.g. 1001"; exit 1; }
DB="$DB_CONTAINER"
API="$API_URL"
DRY="${DRY_RUN:-0}"
if [ -z "${SERVICE_ROLE_KEY:-}" ]; then set -a; . deploy/.secrets; set +a; fi

if [ -n "$NEW_EMAIL$NEW_NAME" ]; then
  [[ "$NEW_EMAIL" == *@*.* ]] && [ -n "$NEW_NAME" ] || { echo 'Use: --new-owner owner@maxtravel.in "Owner Name"'; exit 1; }
  NEW_EMAIL=$(printf '%s' "$NEW_EMAIL" | tr '[:upper:]' '[:lower:]')
fi

# qc: one query, never reads the keyboard (so it can't swallow the WIPE answer); q: SQL fed on stdin
qc() { docker exec "$DB" psql -U supabase_admin -d postgres -v ON_ERROR_STOP=1 -qtA -c "$1" </dev/null; }
q() { docker exec -i "$DB" psql -U supabase_admin -d postgres -v ON_ERROR_STOP=1 -qtA; }

echo "This will DELETE from the CRM:"
qc "select '  ' || (select count(*) from public.cases) || ' cases, ' || (select count(*) from public.customers) || ' customers, '
         || (select count(*) from public.suppliers) || ' suppliers, ' || (select count(*) from public.booking_lines) || ' bookings, '
         || (select count(*) from public.payments) || ' payments, ' || (select count(*) from public.tasks) || ' tasks, '
         || (select count(*) from storage.objects where bucket_id = 'files') || ' uploaded files, '
         || (select count(*) from public.profiles where role = 'client') || ' client portal logins'"
if [ -n "$NEW_EMAIL" ]; then
  echo "It also REMOVES EVERY LOGIN:"
  qc "select '  ' || u.email || ' (' || coalesce(p.role, 'no role') || ')' from auth.users u left join public.profiles p on p.id = u.id order by p.role, u.email"
  echo "and creates ONE new owner login: $NEW_EMAIL ($NEW_NAME). Add staff again afterwards in Settings → Users."
else
  echo "It KEEPS these logins:"
  qc "select '  ' || email || ' (' || role || ')' from public.profiles where role in ('boss','staff') order by role, email"
fi
echo "The first new case will be MAX-$START and the first new customer C-0001."
[ "$DRY" = 1 ] && echo "(DRY RUN: nothing will actually be deleted)"
if [ -n "$NEW_EMAIL" ]; then
  while :; do
    read -r -s -p "Password for the new owner (8+ characters, not shown): " NEW_PASS; echo
    read -r -s -p "Type it again: " p2; echo
    [ "$NEW_PASS" = "$p2" ] && [ ${#NEW_PASS} -ge 8 ] && break
    echo "  The passwords didn't match or were shorter than 8 characters. Try again."
  done
fi
read -r -p "Type WIPE to continue: " ok
[ "$ok" = "WIPE" ] || { echo "Cancelled. Nothing was changed."; exit 1; }

if [ "$DRY" != 1 ]; then
  echo "• Taking a backup first"
  bash deploy/backup.sh
  docker stop "$APP_CONTAINER" >/dev/null 2>&1 || true   # nobody can type into the CRM while it is being cleared
fi

# collected before the wipe: uploaded files (100 per request) and client portal logins
FILE_BATCHES=$(qc "select json_build_object('prefixes', json_agg(name)) from (select name, (row_number() over (order by name) - 1) / 100 as b
                     from storage.objects where bucket_id = 'files') x group by b")
CLIENTS=$(qc "select id from public.profiles where role = 'client'")
ALL_USERS=$(qc "select id from auth.users")

echo "• Clearing the CRM data"
# profiles.customer_id points at customers, so TRUNCATE ... CASCADE would also empty profiles (every login).
# The link is detached for the wipe and put back. One transaction: if anything fails, nothing changes.
q <<SQL
begin;
update public.profiles set customer_id = null;
alter table public.profiles drop constraint profiles_customer_fk;
truncate public.payment_allocations, public.payments, public.expenses, public.share_links, public.files,
         public.task_comments, public.tasks, public.notifications, public.booking_lines, public.case_travellers,
         public.cases, public.customer_documents, public.customers, public.families, public.suppliers, public.activity_log,
         public.invoices, public.invoice_counters, public.ticket_imports, public.case_requests
         restart identity cascade;
alter table public.profiles add constraint profiles_customer_fk foreign key (customer_id) references public.customers (id) on delete set null;
do \$\$ begin
  if not exists (select 1 from public.profiles where role = 'boss' and active) then raise exception 'owner login missing; stopping'; end if;
end \$\$;
$([ "$DRY" = 1 ] && echo "rollback;" || printf "select setval('public.max_seq', %s, false);\nselect setval('public.customer_code_seq', 1, false);\nselect setval('public.receipt_seq', 1, false);\ncommit;" "$START")
SQL

if [ "$DRY" = 1 ]; then
  if [ -n "$NEW_EMAIL" ]; then
    echo "Dry run OK: the database part works (rolled back). $(echo "$FILE_BATCHES" | grep -c prefixes || true) file batch(es) and all $(echo "$ALL_USERS" | grep -c . || true) login(s) would be removed, and $NEW_EMAIL created as owner."
  else
    echo "Dry run OK: the database part works (rolled back). $(echo "$FILE_BATCHES" | grep -c prefixes || true) file batch(es) and $(echo "$CLIENTS" | grep -c . || true) client login(s) would be removed."
  fi
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

del_user() { curl -fsS -X DELETE "$API/auth/v1/admin/users/$1" -H "apikey: $SERVICE_ROLE_KEY" -H "Authorization: Bearer $SERVICE_ROLE_KEY" >/dev/null; }

if [ -n "$NEW_EMAIL" ]; then
  echo "• Creating the new owner login"
  # the new email may belong to an old login: move that one to a placeholder email (it is removed below, once
  # the new owner exists), so the address is free and there is still a way in if creating the new one fails
  same=$(qc "select id from auth.users where lower(email) = lower('${NEW_EMAIL//\'/\'\'}')")
  if [ -n "$same" ]; then
    curl -fsS -X PUT "$API/auth/v1/admin/users/$same" -H "apikey: $SERVICE_ROLE_KEY" -H "Authorization: Bearer $SERVICE_ROLE_KEY" \
         -H "Content-Type: application/json" -d "{\"email\":\"replaced-$same@removed.invalid\",\"email_confirm\":true}" >/dev/null \
      || { docker start "$APP_CONTAINER" >/dev/null 2>&1 || true; echo "✗ Could not free the email $NEW_EMAIL; old logins kept (the data is already cleared)."; exit 1; }
  fi
  j() { local v=${1//\\/\\\\}; printf '%s' "${v//\"/\\\"}"; }   # JSON-escape
  # sent on stdin (printf is a shell builtin), so the password never appears in the process list
  resp=$(printf '{"email":"%s","password":"%s","email_confirm":true,"app_metadata":{"role":"boss","full_name":"%s"}}' \
           "$(j "$NEW_EMAIL")" "$(j "$NEW_PASS")" "$(j "$NEW_NAME")" |
         curl -sS -X POST "$API/auth/v1/admin/users" -H "apikey: $SERVICE_ROLE_KEY" -H "Authorization: Bearer $SERVICE_ROLE_KEY" \
              -H "Content-Type: application/json" --data-binary @-) || resp=""
  NEW_ID=$(printf '%s' "$resp" | grep -o '"id":"[0-9a-f-]\{36\}"' | head -1 | cut -d'"' -f4)
  if [ -z "$NEW_ID" ] || [ "$(qc "select role from public.profiles where id = '$NEW_ID' and active")" != "boss" ]; then
    docker start "$APP_CONTAINER" >/dev/null 2>&1 || true
    echo "✗ Could not create the new owner login, so the OLD logins were kept (the data is already cleared)."
    echo "  Server said: $(printf '%s' "$resp" | head -c 300)"
    echo "  Fix the problem and create it with: bash deploy/create-owner.sh $NEW_EMAIL \"$NEW_NAME\" 'password'"
    exit 1
  fi
  echo "• Removing all old logins"
  for id in $ALL_USERS; do [ "$id" = "$NEW_ID" ] || del_user "$id" || echo "  Could not remove login $id"; done
else
  echo "• Removing client portal logins"
  for id in $CLIENTS; do del_user "$id" || echo "  Could not remove client login $id"; done
fi

docker start "$APP_CONTAINER" >/dev/null 2>&1 || true
echo "✓ Done. $(qc 'select count(*) from public.cases') cases, $(qc 'select count(*) from public.customers') customers left; the next case will be MAX-$START."
[ -z "$NEW_EMAIL" ] || echo "  Log in as $NEW_EMAIL with the password you just set. Logins now: $(qc "select string_agg(email, ', ') from auth.users")"
echo "  The backup taken just before is in $BACKUP_DIR (restore with deploy/restore.sh if needed)."
