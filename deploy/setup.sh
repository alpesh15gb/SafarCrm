#!/usr/bin/env bash
# One-time server setup. Downloads the latest stable official Supabase self-hosted release, writes
# secrets, starts it (private to this server), applies the CRM database, and writes deploy/.env.production.
# Safe to re-run: existing secrets are kept.
#   bash deploy/setup.sh crm.maxtravel.in
set -euo pipefail
cd "$(dirname "$0")/.."
DOMAIN="${1:?usage: bash deploy/setup.sh crm.maxtravel.in}"
. deploy/instance.sh
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
  if [ -n "$INSTANCE" ]; then
    # a second copy on this server: every Supabase container gets this copy's prefix, so nothing clashes with the
    # first copy. Realtime is found by its host name, whose first part ("realtime-dev") must stay the same.
    grep -rl 'realtime-dev\.supabase-realtime' "$SB" | xargs -r sed -i "s/realtime-dev\.supabase-realtime/realtime-dev.${INSTANCE}-supabase-realtime/g"
    sed -i -E "s/^(\s*container_name:\s*)\"?supabase-/\1${INSTANCE}-supabase-/" "$SB/docker-compose.yml"
    sed -i -E "s/^name:\s*supabase\s*$/name: ${INSTANCE}-supabase/" "$SB/docker-compose.yml"
  fi
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
setenv "$SB/.env" API_GW_HTTP_PORT "127.0.0.1:$API_PORT"      # gateway reachable only by this server's nginx
if [ -n "$INSTANCE" ]; then
  setenv "$SB/.env" COMPOSE_PROJECT_NAME "$SB_PROJECT"
  # every port Supabase publishes moves to this copy's own port on 127.0.0.1, or is not published at all.
  # Worked out from Supabase's own file, so it holds whatever ports the downloaded release uses.
  ( cd "$SB" && COMPOSE_FILE=docker-compose.yml:docker-compose.safar.yml docker compose config --format json ) \
    | docker run --rm -i -e API_PORT -e POOLER_PORT -e POOLER_TX_PORT node:22-alpine node -e '
        let s = ""; process.stdin.on("data", (d) => (s += d)).on("end", () => {
          const cfg = JSON.parse(s), e = process.env, out = ["# written by deploy/setup.sh for this copy: its own ports, 127.0.0.1 only", "services:"];
          // kept: the API gateway (already set to the port of this copy above) and the database pooler; anything else
          // (dashboards, HTTPS on the gateway, analytics) is reached inside Docker only, so it is not published
          const pool = { 5432: e.POOLER_PORT, 6543: e.POOLER_TX_PORT };
          for (const [name, svc] of Object.entries(cfg.services || {})) {
            if (!svc.ports || !svc.ports.length) continue;
            const keep = [];
            for (const p of svc.ports) {
              if (String(p.published) === String(e.API_PORT)) keep.push(`127.0.0.1:${e.API_PORT}:${p.target}`);
              else if (name === "supavisor" && pool[p.target]) keep.push(`127.0.0.1:${pool[p.target]}:${p.target}`);
            }
            out.push(`  ${name}:`);
            if (!keep.length) { out.push("    ports: !reset []"); continue; }
            out.push("    ports: !override");
            for (const k of keep) out.push(`      - "${k}"`);
          }
          if (!out.some((l) => l.includes(`:${e.API_PORT}:`))) { console.error("The Supabase API gateway port was not found in its compose file."); process.exit(1); }
          console.log(out.join("\n"));
        });' > "$SB/docker-compose.instance.yml"
  setenv "$SB/.env" COMPOSE_FILE "docker-compose.yml:docker-compose.safar.yml:docker-compose.instance.yml"
fi
setenv "$SB/.env" SITE_URL "https://$DOMAIN"
setenv "$SB/.env" SUPABASE_PUBLIC_URL "https://$DOMAIN"
setenv "$SB/.env" API_EXTERNAL_URL "https://$DOMAIN/auth/v1"
setenv "$SB/.env" ADDITIONAL_REDIRECT_URLS ""
setenv "$SB/.env" DISABLE_SIGNUP "true"                       # only the owner creates logins
setenv "$SB/.env" ENABLE_EMAIL_SIGNUP "true"                  # email + password login stays on
setenv "$SB/.env" ENABLE_EMAIL_AUTOCONFIRM "true"
setenv "$SB/.env" ENABLE_ANONYMOUS_USERS "false"
setenv "$SB/.env" ENABLE_PHONE_SIGNUP "false"
setenv "$SB/.env" POOLER_TENANT_ID "$POOLER_TENANT"
chmod 600 "$SB/.env"

if [ ! -f deploy/.env.production ]; then
  # the ticket-reading worker gets its own secret; the extraction service settings are added by hand (DEPLOY.md)
  cat > deploy/.env.production <<ENV
CRM_DOMAIN=$DOMAIN
NEXT_PUBLIC_APP_URL=https://$DOMAIN
NEXT_PUBLIC_SUPABASE_URL=https://$DOMAIN
NEXT_PUBLIC_SUPABASE_ANON_KEY=$ANON_KEY
SUPABASE_SERVICE_ROLE_KEY=$SERVICE_ROLE_KEY
APP_PORT=$APP_PORT
IMPORT_WORKER_SECRET=$(openssl rand -hex 24)
ENV
  chmod 600 deploy/.env.production
fi

echo "• Starting Supabase (the first start downloads images; this can take several minutes)"
( cd "$SB" && docker compose up -d --wait )

echo "• Waiting for file storage to finish its setup"
for i in $(seq 1 60); do
  docker exec "$DB_CONTAINER" psql -U postgres -tAc "select to_regclass('storage.buckets') is not null" 2>/dev/null | grep -q t && break
  sleep 5
done
bash deploy/migrate.sh
echo
echo "Supabase is running and the CRM database is ready. Next: deploy/DEPLOY.md step 4."
