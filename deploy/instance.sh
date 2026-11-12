# Names and ports of this copy of the CRM on the server. Sourced by every deploy script (after `cd` to the repo root).
#
# The first copy (crm.maxtravel.in in /opt/safar-crm) uses the defaults below and has no deploy/instance.env.
# A second, fully separate copy on the same server (its own database, logins and files) gets a deploy/instance.env,
# written once by `bash deploy/new-instance.sh <name> <domain>`, that changes every name and port so the two
# copies never touch each other's containers, data, ports or backups.
if [ -f deploy/instance.env ]; then set -a; . deploy/instance.env; set +a; fi
: "${INSTANCE:=}"                                   # empty for the first copy
: "${DB_CONTAINER:=supabase-db}"                    # the Postgres container of this copy's Supabase
: "${APP_CONTAINER:=safar-crm}"                     # the CRM web app container
: "${WORKER_CONTAINER:=safar-import-worker}"        # the ticket-reading worker container
: "${APP_PROJECT:=safar-crm}"                       # Docker Compose project of the app
: "${APP_IMAGE:=safar-crm:latest}"
: "${SB_PROJECT:=}"                                 # Docker Compose project of Supabase (empty: Supabase's own default)
: "${APP_PORT:=3100}"                               # app, reachable only from this server (nginx)
: "${API_PORT:=8100}"                               # Supabase API gateway, reachable only from this server (nginx)
: "${POOLER_PORT:=54322}"                           # database pooler (session), this server only
: "${POOLER_TX_PORT:=54323}"                        # database pooler (transaction), this server only
: "${POOLER_TENANT:=maxtravel}"
: "${BACKUP_DIR:=/var/backups/safar-crm}"
API_URL="http://127.0.0.1:$API_PORT"
export INSTANCE DB_CONTAINER APP_CONTAINER WORKER_CONTAINER APP_PROJECT APP_IMAGE SB_PROJECT APP_PORT API_PORT \
       POOLER_PORT POOLER_TX_PORT POOLER_TENANT BACKUP_DIR API_URL
