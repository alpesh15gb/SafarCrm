#!/usr/bin/env bash
# Full backup of the local CRM database (data + files list). Keeps the last 30.
#   npm run backup          (run daily; see README "Backups")
set -euo pipefail
cd "$(dirname "$0")/.."
mkdir -p backups
f="backups/safar-$(date +%Y-%m-%d_%H%M).sql.gz"
docker exec supabase_db_safarcrm pg_dump -U postgres --clean --if-exists -n public -n private -n auth -n storage postgres | gzip > "$f"
# uploaded files live in the storage container's volume; copy them too
docker cp supabase_storage_safarcrm:/mnt "backups/files-$(date +%Y-%m-%d)" 2>/dev/null || true
ls -1t backups/safar-*.sql.gz | tail -n +31 | xargs -r rm --
echo "Backup saved: $f ($(du -h "$f" | cut -f1))"
