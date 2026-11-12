#!/usr/bin/env bash
# Creates the agency owner's login (role boss). Run once after setup.
#   bash deploy/create-owner.sh owner@maxtravel.in "Owner Name" 'a-strong-password'
set -euo pipefail
cd "$(dirname "$0")/.."
. deploy/instance.sh
EMAIL="${1:?email}"; NAME="${2:?name}"; PASS="${3:?password}"
[ ${#PASS} -ge 8 ] || { echo "Password must be at least 8 characters"; exit 1; }
set -a; . deploy/.secrets; set +a
body=$(docker run --rm -e E="$EMAIL" -e N="$NAME" -e P="$PASS" node:22-alpine node -e \
  'console.log(JSON.stringify({email:process.env.E,password:process.env.P,email_confirm:true,app_metadata:{role:"boss",full_name:process.env.N}}))')
curl -fsS -X POST "$API_URL/auth/v1/admin/users" \
  -H "apikey: $SERVICE_ROLE_KEY" -H "Authorization: Bearer $SERVICE_ROLE_KEY" -H "Content-Type: application/json" \
  -d "$body" >/dev/null && echo "Owner login created for $EMAIL."
