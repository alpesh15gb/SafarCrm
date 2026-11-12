#!/usr/bin/env bash
# Prepares a SECOND, fully separate copy of the CRM on a server that already runs one (its own database, logins,
# files, ports and backups). Run once, in the new copy's folder, before its first deploy:
#   git clone -b <branch> https://github.com/alpesh15gb/SafarCrm.git /opt/safar-apex
#   cd /opt/safar-apex && bash deploy/new-instance.sh apex safar.apextime.in
#   bash deploy/nginx-site.sh safar.apextime.in        (HTTPS certificate and nginx site)
#   bash deploy/deploy.sh safar.apextime.in            (Supabase, database, app)
# The name (letters and digits) prefixes every container. The first free set of ports is picked automatically.
set -euo pipefail
cd "$(dirname "$0")/.."
NAME="${1:?usage: bash deploy/new-instance.sh <name, e.g. apex> <domain>}"
DOMAIN="${2:?usage: bash deploy/new-instance.sh <name> <domain>}"
[[ "$NAME" =~ ^[a-z][a-z0-9]{1,15}$ ]] || { echo "The name must be 2-16 lowercase letters or digits, starting with a letter (e.g. apex)."; exit 1; }
[ ! -f deploy/.secrets ] || { echo "This folder already has a running copy (deploy/.secrets exists). Nothing changed."; exit 1; }
[ "$(pwd)" != "/opt/safar-crm" ] || { echo "Run this in the NEW copy's folder (e.g. /opt/safar-apex), not in /opt/safar-crm."; exit 1; }
for c in docker git openssl; do command -v $c >/dev/null || { echo "Please install $c first"; exit 1; }; done

if docker ps -a --format '{{.Names}}' | grep -qx "${NAME}-supabase-db\|safar-${NAME}"; then
  echo "Containers named for '$NAME' already exist on this server. Pick another name."; exit 1
fi

# ports: step by 100 from the first copy's (3100/8100/54322) until all four are free
used() { ss -Hltn "sport = :$1" 2>/dev/null | grep -q . || docker ps --format '{{.Ports}}' | grep -q ":$1->"; }
step=100
while used $((3100 + step)) || used $((8100 + step)) || used $((54322 + step)) || used $((54323 + step)); do
  step=$((step + 100)); [ $step -le 900 ] || { echo "No free set of ports found."; exit 1; }
done

# memory: a second Supabase needs roughly 2-3 GB more
avail=$(awk '/MemAvailable/ {print int($2/1024)}' /proc/meminfo 2>/dev/null || echo 0)
if [ "$avail" -gt 0 ] && [ "$avail" -lt 2500 ]; then
  echo "Warning: only ${avail} MB of memory is free. A second copy needs about 2500 MB more; it may be slow or fail to start."
  read -r -p "Continue anyway? Type YES: " ok; [ "$ok" = "YES" ] || { echo "Cancelled."; exit 1; }
fi

cat > deploy/instance.env <<ENV
# Second copy of the CRM on this server ($DOMAIN). Written by deploy/new-instance.sh; read by every deploy script.
INSTANCE=$NAME
DB_CONTAINER=${NAME}-supabase-db
APP_CONTAINER=safar-${NAME}
WORKER_CONTAINER=safar-${NAME}-worker
APP_PROJECT=safar-${NAME}
APP_IMAGE=safar-${NAME}:latest
SB_PROJECT=${NAME}-supabase
APP_PORT=$((3100 + step))
API_PORT=$((8100 + step))
POOLER_PORT=$((54322 + step))
POOLER_TX_PORT=$((54323 + step))
POOLER_TENANT=${NAME}
BACKUP_DIR=/var/backups/safar-${NAME}
ENV
echo "✓ deploy/instance.env written for '$NAME' ($DOMAIN):"
sed -n 's/^\(APP_PORT\|API_PORT\|DB_CONTAINER\|APP_CONTAINER\|BACKUP_DIR\)=/  &/p' deploy/instance.env
echo "Next: bash deploy/nginx-site.sh $DOMAIN   then   bash deploy/deploy.sh $DOMAIN"
