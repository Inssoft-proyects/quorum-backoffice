# Production deployment with nginx

This directory contains the production nginx vhost for deploying the
Quorum Backoffice behind an nginx reverse proxy with Let's Encrypt TLS.

## Prerequisites

- Ubuntu 22.04+ on the VPS (or any distro with nginx >= 1.18).
- A registered A-record for `quorum.asistentepro.mx` pointing at the VPS IP.
- Node.js 22 installed (`/usr/bin/node`).
- PostgreSQL 18 + Redis 8 installed and reachable.
- The repo cloned to `/opt/quorum-backoffice`.
- A `quorum` user (non-root) that owns the deployment directory.

## One-time setup

### 1. Install nginx + certbot

```bash
sudo apt install -y nginx certbot python3-certbot-nginx
sudo systemctl enable --now nginx
```

### 2. Install dependencies and build

```bash
sudo -u quorum -i
cd /opt/quorum-backoffice
npm install
npm run --workspaces --if-present build

# Run migrations:
cd apps/api && npm run migrate
```

### 3. Drop in environment files

`/etc/quorum-backoffice/api.env` (mode 0600, owned by root:quorum):

```ini
NODE_ENV=production
LOG_LEVEL=info
API_PORT=3100
API_HOST=127.0.0.1
DATABASE_URL=postgresql://quorum:<pw>@127.0.0.1:5432/quorum_backoffice
REDIS_URL=redis://127.0.0.1:6379
OTP_SERVICE_URL=http://quorum-otp:3000
OTP_SERVICE_TOKEN=<HMAC token>
CANVAS_PORTAL_API_URL=http://portal-api:3000
CANVAS_PORTAL_API_TOKEN=<HMAC token>
SESSION_SECRET=<32+ chars random — generate with `openssl rand -hex 32`>
SESSION_TTL_SECONDS=3600
AUTH_COOKIE_NAME=__Host-sid
AUTH_COOKIE_SECURE=true
AUTH_LOGIN_MAX_ATTEMPTS=5
AUTH_LOGIN_WINDOW_SECONDS=900
ALLOWED_ORIGIN=https://quorum.asistentepro.mx
```

`/etc/quorum-backoffice/web.env`:

```ini
NODE_ENV=production
NEXT_PUBLIC_API_URL=https://quorum.asistentepro.mx
```

### 4. Bootstrap the first admin

```bash
node -e "console.log(require('bcrypt').hashSync('YourInitial!Admin2025', 12))"
# → $2b$12$... (paste into next SQL)

sudo -u postgres psql -d quorum_backoffice -c \
  "INSERT INTO users (email, password_hash, role) \
   VALUES ('admin@asistentepro.mx', '\$2b\$12\$...', 'admin');"
```

### 5. Run the API + Web as systemd services

Use the templates in `infra/systemd/` (or copy from a sibling project):

```ini
# /etc/systemd/system/quorum-backoffice-api.service
[Unit]
Description=Quorum Backoffice API
After=network.target postgresql.service redis-server.service

[Service]
Type=simple
User=quorum
Group=quorum
WorkingDirectory=/opt/quorum-backoffice/apps/api
EnvironmentFile=/etc/quorum-backoffice/api.env
ExecStart=/usr/bin/node dist/src/server.js
Restart=on-failure
RestartSec=5s
NoNewPrivileges=true
PrivateTmp=true
ProtectSystem=strict
ProtectHome=true
ReadWritePaths=/opt/quorum-backoffice/apps/api/dist

[Install]
WantedBy=multi-user.target
```

```ini
# /etc/systemd/system/quorum-backoffice-web.service
[Unit]
Description=Quorum Backoffice Web (Next.js)
After=network.target quorum-backoffice-api.service

[Service]
Type=simple
User=quorum
Group=quorum
WorkingDirectory=/opt/quorum-backoffice/apps/web
EnvironmentFile=/etc/quorum-backoffice/web.env
ExecStart=/usr/bin/node node_modules/next/dist/bin/next start -p 3002
Restart=on-failure
RestartSec=5s
NoNewPrivileges=true
PrivateTmp=true
ProtectSystem=strict
ProtectHome=true

[Install]
WantedBy=multi-user.target
```

```bash
sudo cp /opt/quorum-backoffice/infra/systemd/quorum-backoffice-api.service /etc/systemd/system/
sudo cp /opt/quorum-backoffice/infra/systemd/quorum-backoffice-web.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now quorum-backoffice-api
sudo systemctl enable --now quorum-backoffice-web
```

> **Note**: the systemd templates above live in this README, not as separate files in `infra/systemd/`. Copy them out as needed. If you prefer them committed as files, the WU can add them later.

### 6. Enable the nginx vhost

```bash
sudo cp infra/nginx/quorum.asistentepro.mx.conf /etc/nginx/sites-available/
sudo ln -sf /etc/nginx/sites-available/quorum.asistentepro.mx.conf /etc/nginx/sites-enabled/

# Remove the default site if present.
sudo rm -f /etc/nginx/sites-enabled/default

# Test config.
sudo nginx -t
```

### 7. Provision Let's Encrypt certificate

```bash
sudo certbot --nginx -d quorum.asistentepro.mx
# Follow the prompts. certbot will edit the vhost to point at the issued cert.
sudo systemctl reload nginx
```

certbot auto-renews via a systemd timer. Verify:

```bash
sudo systemctl list-timers | grep certbot
sudo certbot renew --dry-run
```

### 8. Verify

```bash
# TLS + health probe.
curl https://quorum.asistentepro.mx/healthz
# → 200 OK

curl https://quorum.asistentepro.mx/readyz
# → 200 {status:"ok",checks:{pg:"ok",redis:"ok",otp:"ok"}}

# Open the web UI in your browser.
xdg-open https://quorum.asistentepro.mx/login
```

## Operational notes

### Logs

```bash
sudo journalctl -u quorum-backoffice-api -f
sudo journalctl -u quorum-backoffice-web -f
sudo tail -f /var/log/nginx/access.log
sudo tail -f /var/log/nginx/error.log
```

### Update deploy

```bash
sudo -u quorum -i
cd /opt/quorum-backoffice
git pull
npm install
npm run --workspaces --if-present build
exit

sudo systemctl restart quorum-backoffice-api
sudo systemctl restart quorum-backoffice-web
```

Nginx config doesn't change on app updates — no reload needed unless
you modify the vhost.

### Rollback

```bash
sudo git -C /opt/quorum-backoffice checkout HEAD~1 -- infra/nginx/
sudo cp infra/nginx/quorum.asistentepro.mx.conf /etc/nginx/sites-available/
sudo nginx -t && sudo systemctl reload nginx
```

### Known limitation: API dist path

The api `package.json` `main` field is `dist/server.js`, but `tsc`
emits to `dist/src/server.js`. The systemd unit's ExecStart uses
the correct path. If you build the api fresh, verify the path
matches. See `odd/tasks/quorum-backoffice-mvp.md` for the polish
follow-up.