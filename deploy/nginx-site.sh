#!/usr/bin/env bash
# Gets the HTTPS certificate and writes the nginx site for this copy of the CRM, using its own ports.
#   bash deploy/nginx-site.sh safar.apextime.in
# The domain must already point at this server (DNS A record). Other sites on the server are not touched.
set -euo pipefail
cd "$(dirname "$0")/.."
. deploy/instance.sh
DOMAIN="${1:?usage: bash deploy/nginx-site.sh <domain>}"
[[ "$DOMAIN" =~ ^[a-z0-9.-]+\.[a-z]{2,}$ ]] || { echo "That doesn't look like a domain: $DOMAIN"; exit 1; }
SITE=/etc/nginx/sites-available/$DOMAIN
for c in nginx certbot; do command -v $c >/dev/null || { echo "Please install $c first"; exit 1; }; done

me=$(curl -fsS4 https://api.ipify.org 2>/dev/null || true)
dns=$(getent ahostsv4 "$DOMAIN" 2>/dev/null | awk 'NR==1 {print $1}')
if [ -n "$me" ] && [ "$dns" != "$me" ]; then
  echo "$DOMAIN points to '${dns:-nothing}', but this server is $me. Add a DNS A record for $DOMAIN → $me, wait a few minutes, then run this again."
  exit 1
fi

if [ ! -f "/etc/letsencrypt/live/$DOMAIN/fullchain.pem" ]; then
  echo "• Getting the HTTPS certificate for $DOMAIN"
  mkdir -p /var/www/html
  cat > "$SITE" <<EOF
server { listen 80; listen [::]:80; server_name $DOMAIN; location /.well-known/acme-challenge/ { root /var/www/html; } location / { return 404; } }
EOF
  ln -sf "$SITE" "/etc/nginx/sites-enabled/$DOMAIN"
  nginx -t && systemctl reload nginx
  certbot certonly --webroot -w /var/www/html -d "$DOMAIN" --non-interactive --agree-tos --register-unsafely-without-email --keep-until-expiring
fi

echo "• Writing the nginx site (app on 127.0.0.1:$APP_PORT, Supabase on 127.0.0.1:$API_PORT)"
src=deploy/nginx/crm.maxtravel.in.conf
conf=$(sed -e "s/crm\.maxtravel\.in/$DOMAIN/g" -e "s/127\.0\.0\.1:3100/127.0.0.1:$APP_PORT/g" -e "s/127\.0\.0\.1:8100/127.0.0.1:$API_PORT/g" "$src")
# the websocket helper is defined once for the whole server; keep it only if no other site defines it
if grep -rqs 'safar_connection_upgrade {' /etc/nginx/sites-enabled/ --exclude="$DOMAIN"; then
  conf=$(printf '%s\n' "$conf" | grep -v '^map \$http_upgrade \$safar_connection_upgrade')
fi
[ -f /etc/letsencrypt/options-ssl-nginx.conf ] || conf=$(printf '%s\n' "$conf" | grep -v 'options-ssl-nginx.conf')
printf '%s\n' "$conf" > "$SITE"
ln -sf "$SITE" "/etc/nginx/sites-enabled/$DOMAIN"
nginx -t && systemctl reload nginx
echo "✓ https://$DOMAIN is set up in nginx. The CRM answers there once deploy/deploy.sh has run."
