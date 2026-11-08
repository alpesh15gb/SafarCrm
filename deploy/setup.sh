#!/usr/bin/env bash
# One-time server setup. Downloads the latest stable official Supabase self-hosted release, writes
# secrets, starts it (private to this server), applies the CRM database, and writes deploy/.env.production.
# Safe to re-run: existing secrets are kept.
#   bash deploy/setup.sh crm.maxtravel.in
set -euo pipefail
cd "$(dirname "$0")/.."
DOMAIN="${1:?usage: bash deploy/setup.sh crm.maxtravel.in}"
SB=deploy/supabase-docker
REPO=https://github.com/supabase/supabase
for c in docker git openssl; do command -v $c >/dev/null || { echo "Please install $c first"; exit 1; }; done

if [ ! -d "$SB" ]; then
  REF=$(git ls-remote --tags --refs "$REPO" | sed 's#^.*refs/tags/##' | grep -E '^self-hosted/v[0-9]' | sort -V | tail -1)
  [ -n "$REF" ] || { echo "Could not find a Supabase self-hosted release"; exit 1; }
  echo "• Downloading Supabase $REF"
  tmp=$(mktemp -d)
  git clone -q --depth 1 --branch "$REF" --filter=blob:none --sparse "$REPO" "$tmp/supabase"
  git -C "$tmp/supabase" sparse-checkout set docker
  cp -r "$tmp/supabase/docker" "$SB" && rm -rf "$tmp"
  cp "$SB/.env.example" "$SB/.env"
  echo "$REF" > deploy/SUPABASE_VERSION
fi
cp deploy/supabase-safar.yml "$SB/docker-compose.safar.yml"

setenv() { # setenv FILE KEY VALUE  (replace or append)
  local v=${3//|/\\|}
  if grep -q "^$2=" "$1"; then sed -i "s|^$2=.*|$2=$v|" "$1"; else printf '%s=%s\n' "$2" "$3" >> "$1"; fi
}

if [ ! -f deploy/.secrets ]; then
  echo "• Generating secrets (saved in deploy/.secrets; keep a copy somewhere safe)"
  ( sh "$SB/utils/generate-keys.sh" </dev/null | grep -E '^[A-Z0-9_]+=' ; echo "DASHBOARD_USERNAME=maxadmin" ) > deploy/.secrets
  chmod 600 deploy/.secrets
fi
set -a; . deploy/.secrets; set +a

while IFS='=' read -r k v; do [ -n "$k" ] && setenv "$SB/.env" "$k" "$v"; done < deploy/.secrets
setenv "$SB/.env" COMPOSE_FILE "docker-compose.yml:docker-compose.safar.yml"
setenv "$SB/.env" API_GW_HTTP_PORT "127.0.0.1:8100"          # gateway reachable only by this server's nginx
setenv "$SB/.env" SITE_URL "https://$DOMAIN"
setenv "$SB/.env" SUPABASE_PUBLIC_URL "https://$DOMAIN"
setenv "$SB/.env" API_EXTERNAL_URL "https://$DOMAIN/auth/v1"
setenv "$SB/.env" ADDITIONAL_REDIRECT_URLS ""
setenv "$SB/.env" DISABLE_SIGNUP "true"                       # only the owner creates logins
setenv "$SB/.env" ENABLE_EMAIL_SIGNUP "true"                  # email + password login stays on
setenv "$SB/.env" ENABLE_EMAIL_AUTOCONFIRM "true"
setenv "$SB/.env" ENABLE_ANONYMOUS_USERS "false"
setenv "$SB/.env" ENABLE_PHONE_SIGNUP "false"
setenv "$SB/.env" POOLER_TENANT_ID "maxtravel"
chmod 600 "$SB/.env"

cat > deploy/.env.production <<ENV
CRM_DOMAIN=$DOMAIN
NEXT_PUBLIC_APP_URL=https://$DOMAIN
NEXT_PUBLIC_SUPABASE_URL=https://$DOMAIN
NEXT_PUBLIC_SUPABASE_ANON_KEY=$ANON_KEY
SUPABASE_SERVICE_ROLE_KEY=$SERVICE_ROLE_KEY
APP_PORT=3100
ENV
chmod 600 deploy/.env.production

echo "• Starting Supabase (the first start downloads images; this can take several minutes)"
( cd "$SB" && docker compose up -d --wait )

echo "• Waiting for file storage to finish its setup"
for i in $(seq 1 60); do
  docker exec supabase-db psql -U postgres -tAc "select to_regclass('storage.buckets') is not null" 2>/dev/null | grep -q t && break
  sleep 5
done
bash deploy/migrate.sh
echo
echo "Supabase is running and the CRM database is ready. Next: deploy/DEPLOY.md step 4."
