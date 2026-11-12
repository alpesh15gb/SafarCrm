#!/usr/bin/env bash
# Install or update Safar CRM on the server, in one command.
#   First install:  bash deploy/deploy.sh crm.maxtravel.in
#   Every update:   bash deploy/deploy.sh
set -euo pipefail
cd "$(dirname "$0")/.."

# 1. get the latest code, then re-run the NEW copy of this script
if [ "${1:-}" != "--after-pull" ]; then
  if [ -d .git ]; then echo "• Getting the latest code"; git pull --ff-only; fi
  exec bash deploy/deploy.sh --after-pull "${1:-}"
fi
DOMAIN="${2:-}"
. deploy/instance.sh

# 2. first install: Supabase + database. Updates: backup, then apply new database changes
if [ ! -f deploy/.secrets ]; then
  [ -n "$DOMAIN" ] || { echo "First install needs the domain:  bash deploy/deploy.sh crm.maxtravel.in"; exit 1; }
  bash deploy/setup.sh "$DOMAIN"
else
  echo "• Backing up before updating"; bash deploy/backup.sh
  bash deploy/migrate.sh
fi

# 3. build and (re)start the app
echo "• Building and starting the CRM app"
# a CRM container left over from an older version of this script (wrong project name) is removed first;
# containers of other apps are never touched
owner=$(docker inspect -f '{{index .Config.Labels "com.docker.compose.project"}}' "$APP_CONTAINER" 2>/dev/null || true)
if [ -n "$owner" ] && [ "$owner" != "$APP_PROJECT" ]; then docker rm -f "$APP_CONTAINER" >/dev/null; fi
docker compose -f deploy/docker-compose.yml --env-file deploy/.env.production up -d --build
for i in $(seq 1 30); do
  s=$(docker inspect --format '{{.State.Health.Status}}' "$APP_CONTAINER" 2>/dev/null || echo starting)
  [ "$s" = healthy ] && break; sleep 4
done
docker image prune -f >/dev/null
[ "$s" = healthy ] || { echo "The app did not become healthy. See: docker logs --tail 50 $APP_CONTAINER"; exit 1; }
echo "✓ Safar CRM${INSTANCE:+ ($INSTANCE)} is running ($(git log -1 --format='%h %s' 2>/dev/null || echo 'local copy'))."
