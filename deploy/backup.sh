#!/usr/bin/env bash
# Nightly backup on the server: database (including the encryption key in schema "private") + uploaded files.
# Keeps 30 days in /var/backups/safar-crm. Cron: 30 1 * * * bash /path/to/SafarCrm/deploy/backup.sh
set -euo pipefail
cd "$(dirname "$0")/.."
DIR=${BACKUP_DIR:-/var/backups/safar-crm}; mkdir -p "$DIR"; d=$(date +%F_%H%M)
docker exec supabase-db pg_dump -U postgres -Fc -n public -n private -n auth -n storage -n cron postgres > "$DIR/db-$d.dump"
docker run --rm -v "$PWD/deploy/supabase-docker/volumes:/v:ro" alpine tar -czf - -C /v storage > "$DIR/files-$d.tar.gz"
find "$DIR" -type f -mtime +30 -delete
echo "Backup: $DIR/db-$d.dump ($(du -h "$DIR/db-$d.dump" | cut -f1)), files-$d.tar.gz"
