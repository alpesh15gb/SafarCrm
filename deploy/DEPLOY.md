# Deploying Safar CRM to the VPS (crm.maxtravel.in)

What runs on the server:

| Piece | Where | Reachable from |
|---|---|---|
| CRM app (Docker, `safar-crm`) | 127.0.0.1:3100 | nginx only |
| Supabase: database, logins, files, live alerts (Docker, latest official self-hosted release) | 127.0.0.1:8100 | nginx only |
| nginx (already on the server) | ports 80/443 | the internet |

nginx sends `https://crm.maxtravel.in/` to the app, and `/auth/v1`, `/rest/v1`, `/storage/v1` and `/realtime/v1` to Supabase.

**Server needs:** Ubuntu/Debian, 4 GB RAM minimum (Supabase runs about 12 containers), 2 CPUs, 20 GB free disk. Docker with Compose **v2.24.4 or newer** (`docker compose version`), git, nginx and certbot.

---

## 0. Retire the old app safely

Do this before step 4, and keep these backups until the new CRM has run fine for a month.

```bash
# find the old app's containers and its folder
docker ps --format '{{.Names}}\t{{.Ports}}\t{{.Label "com.docker.compose.project.working_dir"}}'
# back up its database (example for a postgres container; adjust names)
docker exec OLD_DB_CONTAINER pg_dumpall -U postgres | gzip > ~/old-crm-final-$(date +%F).sql.gz
# back up its folder (code, .env, uploads)
sudo tar -czf ~/old-crm-folder-$(date +%F).tar.gz /path/to/old/app
# stop it (does NOT delete data volumes)
cd /path/to/old/app && docker compose down
# turn off its nginx site
sudo rm /etc/nginx/sites-enabled/OLD_SITE && sudo nginx -t && sudo systemctl reload nginx
```

Check that ports **3100, 8100, 54322 and 54323** are free: `sudo ss -ltnp | grep -E ':(3100|8100|54322|54323) '` should print nothing.

## 1. DNS

`crm.maxtravel.in` must have an A record pointing to the VPS IP. It probably already does, from the old app.

## 2. Put the code on the server

```bash
git clone https://github.com/alpesh15gb/SafarCrm.git /opt/safar-crm
```

## 3. Start Supabase and create the database

```bash
cd /opt/safar-crm
bash deploy/setup.sh crm.maxtravel.in
```

This does the following:
- Downloads the latest stable official Supabase self-hosted release (the version is saved in `deploy/SUPABASE_VERSION`).
- Generates all passwords and keys into `deploy/.secrets`. **Copy this file to a safe place: without it backups can't be read back.**
- Locks every Supabase port to this server only. Docker skips the firewall, so this matters.
- Turns off public sign-ups and turns on two-step login.
- Starts Supabase and creates the CRM tables, rules, reminders and lists.

## 4. HTTPS certificate and nginx

```bash
# a) temporary site so certbot can verify the domain
sudo tee /etc/nginx/sites-available/crm.maxtravel.in >/dev/null <<'EOF'
server { listen 80; server_name crm.maxtravel.in; location /.well-known/acme-challenge/ { root /var/www/html; } }
EOF
sudo ln -sf /etc/nginx/sites-available/crm.maxtravel.in /etc/nginx/sites-enabled/
sudo nginx -t && sudo systemctl reload nginx
sudo certbot certonly --webroot -w /var/www/html -d crm.maxtravel.in

# b) the real site
sudo cp deploy/nginx/crm.maxtravel.in.conf /etc/nginx/sites-available/crm.maxtravel.in
sudo nginx -t && sudo systemctl reload nginx
```

If `/etc/letsencrypt/options-ssl-nginx.conf` is missing, delete that `include` line.

## 5. Build and start the CRM app

```bash
cd /opt/safar-crm
docker compose -f deploy/docker-compose.yml --env-file deploy/.env.production up -d --build
docker ps --filter name=safar-crm   # should say (healthy) after about 30 seconds
```

## 6. Create the owner login, then finish in the browser

```bash
bash deploy/create-owner.sh owner@maxtravel.in "Owner Name" 'a-strong-password'
```

Open https://crm.maxtravel.in and log in. Then:

1. **Settings → Agency and MAX ID:** name "Max Travel", phone, email, address. Set the web address to `https://crm.maxtravel.in`.
2. **Settings → Agency and MAX ID:** choose the first MAX ID number (it can only move forward).
3. **Settings → Users:** add staff.
4. **My profile:** turn on two-step login for the owner.

## 7. Backups (nightly, keep 30 days)

```bash
sudo crontab -e
# add:
30 1 * * * bash /opt/safar-crm/deploy/backup.sh >> /var/log/safar-backup.log 2>&1
```

Backups go to `/var/backups/safar-crm` and include the database (with the encryption key for ID numbers) and the uploaded files. **Copy them off the server** every week (Google Drive, another server, or a laptop): `rsync -av USER@VPS:/var/backups/safar-crm/ ~/safar-backups/`.

### Restoring a backup

Use this if data is lost or damaged. It replaces everything with the backup, and asks you to type RESTORE first:

```bash
bash deploy/restore.sh /var/backups/safar-crm/db-DATE.dump /var/backups/safar-crm/files-DATE.tar.gz
```

To rebuild on a brand-new server: do steps 2–5 with the **same `deploy/.secrets` file**, skip step 6, then run the restore. Logins, two-step login devices, encrypted ID numbers and the MAX numbering all come back.

### Deleting test data before real use

Removes all cases, customers, suppliers, bookings, payments, tasks, files and client portal logins, and restarts the numbering. Owner and staff logins, settings and lists are kept. It shows what it will delete, asks you to type WIPE, and takes a backup first:

```bash
cd /opt/safar-crm && DRY_RUN=1 bash deploy/wipe-data.sh 1001   # check only: changes nothing
cd /opt/safar-crm && bash deploy/wipe-data.sh 1001             # the real wipe; first case = MAX-1001
```

## Updating the CRM later

```bash
cd /opt/safar-crm && bash deploy/deploy.sh
```

It pulls the latest code from GitHub, backs up, applies database changes, rebuilds the app and waits until it is healthy.

## Admin dashboard (Supabase Studio)

It is never exposed to the internet. To use it, open an SSH tunnel from your computer:

```bash
ssh -L 8100:127.0.0.1:8100 USER@VPS
```

Then open http://localhost:8100 and log in with `DASHBOARD_USERNAME` and `DASHBOARD_PASSWORD` from `deploy/.secrets`.

## Quick checks if something is wrong

```bash
docker logs --tail 50 safar-crm          # the app
docker logs --tail 50 supabase-auth      # logins
docker logs --tail 50 supabase-envoy     # API gateway
curl -sI https://crm.maxtravel.in/login  # should be 200
curl -s https://crm.maxtravel.in/auth/v1/health -H "apikey: $(grep ^ANON_KEY deploy/.secrets | cut -d= -f2)"
```
