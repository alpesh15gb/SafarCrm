#!/usr/bin/env bash
# Applies new files from supabase/migrations to the server database, once each, in order.
#   bash deploy/migrate.sh
set -euo pipefail
cd "$(dirname "$0")/.."
q() { docker exec -i supabase-db psql -U postgres -d postgres -v ON_ERROR_STOP=1 -qtA "$@"; }
q -c "create schema if not exists deploy_meta; create table if not exists deploy_meta.migrations (name text primary key, applied_at timestamptz default now());" >/dev/null
for f in supabase/migrations/*.sql; do
  name=$(basename "$f")
  if [ "$(q -c "select 1 from deploy_meta.migrations where name = '$name'")" = "1" ]; then continue; fi
  echo "  applying $name"
  { echo "begin;"; cat "$f"; echo; echo "insert into deploy_meta.migrations(name) values ('$name');"; echo "commit;"; } | q >/dev/null
done
echo "• Database is up to date."
