#!/usr/bin/env bash
# Nightly backup on the server: database (including the encryption key in schema "private") + uploaded files.
# Keeps 30 days in /var/backups/safar-crm. Cron: 30 1 * * * bash /path/to/SafarCrm/deploy/backup.sh
set -euo pipefail
cd "$(dirname "$0")/.."
. deploy/instance.sh
DIR=$BACKUP_DIR; mkdir -p "$DIR"; d=$(date +%F_%H%M)
docker exec "$DB_CONTAINER" pg_dump -U postgres -Fc -n public -n private -n auth -n storage -n cron postgres > "$DIR/db-$d.dump"
docker run --rm -v "$PWD/deploy/supabase-docker/volumes:/v:ro" alpine tar -czf - -C /v storage > "$DIR/files-$d.tar.gz"
find "$DIR" -type f -mtime +30 -delete
# record it, so Settings → Data shows when the last backup really ran (ignored before the table exists)
docker exec -i "$DB_CONTAINER" psql -U postgres -d postgres -qtA -c \
  "insert into public.backup_log (db_size, files_size) values ('$(du -h "$DIR/db-$d.dump" | cut -f1)', '$(du -h "$DIR/files-$d.tar.gz" | cut -f1)')" >/dev/null 2>&1 || true
echo "Backup: $DIR/db-$d.dump ($(du -h "$DIR/db-$d.dump" | cut -f1)), files-$d.tar.gz"
