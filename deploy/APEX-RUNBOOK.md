# Go-live runbook: Apex VPS → crm.maxtravel.in

Exact commands for this server. The new CRM is set up **next to** the old one and tested. The domain is switched only at the end, and switching back takes one command.

What we know about Apex:
- 15 GB RAM, 4 CPUs, Docker Compose v5.5.
- nginx site file: `/etc/nginx/conf.d/maxtravel-crm.conf`.
- The certificate already exists.
- The old CRM lives in `/opt/max-travel-crm`. Its data (SQLite file and uploads) is in the Docker volume `max-travel-crm_agency-data`.

**Don't touch** `max-travel-booking-*`, apexbooks, peoplenexa or any other app. None of the steps below affect them.

---

## Quick reference

| When | Command (on Apex) |
|---|---|
| First install | `git clone https://github.com/alpesh15gb/SafarCrm.git /opt/safar-crm && cd /opt/safar-crm && bash deploy/deploy.sh crm.maxtravel.in` |
| Every update after that | `cd /opt/safar-crm && bash deploy/deploy.sh` |

`deploy.sh` does everything in order:
1. pulls the latest code;
2. backs up (on updates);
3. applies new database changes;
4. rebuilds and restarts the app;
5. waits until the app is healthy.

The rest of this page is the one-time switch-over from the old CRM.

---

## On Apex

### 1. Safety copies of the old CRM

Change nothing yet; only copy.

```bash
mkdir -p /root/retired-old-crm
cp /etc/nginx/conf.d/maxtravel-crm.conf /root/retired-old-crm/maxtravel-crm.conf.bak
docker run --rm -v max-travel-crm_agency-data:/data:ro -v /root/retired-old-crm:/b alpine \
  tar -czf /b/agency-data-$(date +%F).tar.gz -C /data .
ls -lh /root/retired-old-crm
```

### 2. Check that ports are free

```bash
ss -ltnp | grep -E ':(3100|8100|54322|54323) ' || echo "ports free"
```

### 3. Install

The old CRM keeps running during this step.

```bash
git clone https://github.com/alpesh15gb/SafarCrm.git /opt/safar-crm
cd /opt/safar-crm && bash deploy/deploy.sh crm.maxtravel.in
```

The first run downloads images, which takes about 5–10 minutes. It ends with "✓ Safar CRM is running".

**Now save the secrets off the server.** Copy everything this prints into your password manager:

```bash
cat /opt/safar-crm/deploy/.secrets
```

### 4. Check that both parts answer

```bash
curl -s -o /dev/null -w "app %{http_code}\n" http://127.0.0.1:3100/login                          # → 200
curl -s -o /dev/null -w "supabase %{http_code}\n" http://127.0.0.1:8100/auth/v1/health \
  -H "apikey: $(grep ^ANON_KEY deploy/.secrets | cut -d= -f2)"                                     # → 200
```

### 5. Create the owner login

```bash
bash deploy/create-owner.sh OWNER_EMAIL "Owner Name" 'A-Strong-Password'
```

### 6. Switch the domain to the new CRM

Downtime is a few seconds.

```bash
cp deploy/nginx/crm.maxtravel.in.conf /etc/nginx/conf.d/maxtravel-crm.conf
[ -f /etc/letsencrypt/options-ssl-nginx.conf ] || sed -i '/options-ssl-nginx/d' /etc/nginx/conf.d/maxtravel-crm.conf
nginx -t && systemctl reload nginx
curl -s -o /dev/null -w "live %{http_code}\n" https://crm.maxtravel.in/login                        # → 200
```

If `nginx -t` reports an error, nothing has changed yet: put the backup back (see Rollback) and send me the message.

### 7. Check in the browser

Open https://crm.maxtravel.in and log in as the owner. Then:
- create a test customer and case, and add a booking;
- upload a ticket and download it again;
- delete the test case.

Check the bell icon too. If all of that works, stop the old app:

```bash
cd /opt/max-travel-crm && docker compose stop      # "stop" keeps everything; its data volume is untouched
```

### 8. Nightly backups

```bash
(crontab -l 2>/dev/null; echo "30 1 * * * bash /opt/safar-crm/deploy/backup.sh >> /var/log/safar-backup.log 2>&1") | crontab -
bash /opt/safar-crm/deploy/backup.sh       # run one now to check it works
```

Copy `/var/backups/safar-crm` off the server every week.

### 9. In the CRM

- **Settings → Agency and MAX ID:** agency details, web address `https://crm.maxtravel.in`, first MAX ID.
- **Settings → Users:** add staff.
- **My profile:** turn on two-step login for the owner.

---

## Rollback (back to the old CRM)

```bash
cp /root/retired-old-crm/maxtravel-crm.conf.bak /etc/nginx/conf.d/maxtravel-crm.conf && nginx -t && systemctl reload nginx
cd /opt/max-travel-crm && docker compose start
```

The new CRM can stay running in the background; it doesn't affect the old one.

## After a month of running fine

Remove the old CRM for good. Keep the files in `/root/retired-old-crm`.

```bash
cd /opt/max-travel-crm && docker compose down        # add -v only if you are sure you never need its data again
```

---

## A second, separate copy on the same server (e.g. safar.apextime.in)

Same code, but its **own** database, logins, files, ports and backups. The first copy in `/opt/safar-crm` is not
touched: it keeps its names (`supabase-db`, `safar-crm`) and ports (3100, 8100). The second copy lives in its own
folder and every name gets its prefix (`apex-supabase-db`, `safar-apex`, …). It needs about 2.5 GB more memory.

```bash
free -h                                                    # "available" should be 3 GB or more
# 1. DNS: an A record safar.apextime.in → this server's IP (check: getent hosts safar.apextime.in)
# 2. a copy of the code, from the first copy (no GitHub login needed), following the same branch
git clone -b "$(git -C /opt/safar-crm branch --show-current)" /opt/safar-crm /opt/safar-apex
cd /opt/safar-apex && git remote set-url origin "$(git -C /opt/safar-crm remote get-url origin)"
# 3. names and ports for this copy (picks the first free ports, normally app 3200 / Supabase 8200)
bash deploy/new-instance.sh apex safar.apextime.in
# 4. HTTPS certificate and nginx site
bash deploy/nginx-site.sh safar.apextime.in
# 5. Supabase, database and app (the first start downloads images: several minutes)
bash deploy/deploy.sh safar.apextime.in
# 6. ticket reading: the same extraction service as the first copy, then restart the app
grep '^EXTRACTION_' /opt/safar-crm/deploy/.env.production >> deploy/.env.production && bash deploy/deploy.sh
# 7. the owner login for this copy
bash deploy/create-owner.sh owner@example.com "Owner Name" 'a-strong-password'
# 8. nightly backup (its own folder: /var/backups/safar-apex)
(crontab -l 2>/dev/null; echo "45 1 * * * bash /opt/safar-apex/deploy/backup.sh >> /var/log/safar-apex-backup.log 2>&1") | crontab -
```

Updates: `cd /opt/safar-apex && bash deploy/deploy.sh` (each copy is updated on its own).
Database commands for this copy use its container: `docker exec -i apex-supabase-db psql -U postgres -d postgres …`
Its secrets are in `/opt/safar-apex/deploy/.secrets`; keep a copy somewhere safe, like the first copy's.
