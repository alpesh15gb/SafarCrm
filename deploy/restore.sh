#!/usr/bin/env bash
# Restores a backup made by deploy/backup.sh. REPLACES all current CRM data with the backup's.
#   bash deploy/restore.sh /var/backups/safar-crm/db-2026-11-20_0130.dump [/var/backups/safar-crm/files-2026-11-20_0130.tar.gz]
set -euo pipefail
cd "$(dirname "$0")/.."
. deploy/instance.sh
DUMP="${1:?path to db-*.dump}"; FILES="${2:-}"
[ -f "$DUMP" ] || { echo "No such file: $DUMP"; exit 1; }
read -r -p "This replaces ALL current CRM data with $DUMP. Type RESTORE to continue: " ok
[ "$ok" = "RESTORE" ] || { echo "Cancelled."; exit 1; }

su() { docker exec -i "$DB_CONTAINER" psql -U supabase_admin -d postgres -v ON_ERROR_STOP=1 -qtA "$@"; }
docker stop "$APP_CONTAINER" >/dev/null 2>&1 || true

echo "• Clearing current data"
su <<'SQL'
do $$ declare t record; begin
  for t in select schemaname, tablename from pg_tables where schemaname in ('public', 'private') loop
    execute format('truncate table %I.%I restart identity cascade', t.schemaname, t.tablename);
  end loop;
end $$;
truncate auth.users cascade;
set storage.allow_delete_query = 'true';   -- the storage service's own guard; we restore the files below
delete from storage.objects;
SQL

echo "• Restoring logins, CRM data and file records"
r() { docker exec -i "$DB_CONTAINER" pg_restore -U supabase_admin -d postgres --data-only --disable-triggers "$@" < "$DUMP"; }
r -n auth -t users -t identities -t mfa_factors
r -n public
r -n private
r -n storage -t objects

if [ -n "$FILES" ]; then
  echo "• Restoring uploaded files"
  docker run --rm -v "$PWD/deploy/supabase-docker/volumes:/v" -v "$(realpath "$FILES"):/b.tgz:ro" alpine tar -xzf /b.tgz -C /v
fi
docker start "$APP_CONTAINER" >/dev/null 2>&1 || true
echo "Restore finished: $(su -c 'select count(*) from public.customers') customers, $(su -c 'select count(*) from public.cases') cases, $(su -c 'select count(*) from auth.users') logins."
