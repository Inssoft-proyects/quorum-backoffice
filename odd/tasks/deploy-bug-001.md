# Deploy Script — BUG-001 fix

Run from any terminal that can SSH into the VPS. The script pulls the new
commits, rebuilds the web app, restarts the systemd units, and runs two
smoke curls to confirm the fix is live.

## 1. Pre-flight checks (local)

```bash
cd /planQuorum/dev/quorum-backoffice
git status                         # debe estar clean
git log --oneline | head -5         # últimos commits:
                                     #   77e1f26 fix(web): ... (BUG-001)
                                     #   fd97871 fix(web): ... TS errors
                                     #   1cccb24 test(web): ... audit
```

## 2. Deploy on the VPS

```bash
ssh quorum@quorum.asistentepro.mx
```

Once on the VPS:

```bash
set -euo pipefail

cd /opt/quorum-backoffice

# 1. Pull los 3 commits nuevos
git pull origin feature/wu0-bootstrap

# 2. Install (por si cambian deps; en este commit no hay nuevas, pero barato)
npm install

# 3. Build web (Next.js standalone) + shared (para que api/web lo consuman)
cd /opt/quorum-backoffice
npm run --workspaces --if-present build

# 4. Restart systemd units (orden: api primero, web después)
sudo systemctl restart quorum-backoffice-api
sleep 2
sudo systemctl restart quorum-backoffice-web
sleep 3

# 5. Verificar que los servicios están vivos
sudo systemctl is-active quorum-backoffice-api quorum-backoffice-web
```

## 3. Smoke tests desde la VPS (sin login)

```bash
# Health check de la API (no requiere sesión)
curl -ks -o /dev/null -w "API readyz: %{http_code}\n" \
  https://quorum.asistentepro.mx/backoffice/api/v1/health/readyz

# Login + verificar que el cookie ahora se llama __Host-sid
curl -ks -X POST https://quorum.asistentepro.mx/backoffice/api/v1/auth/login \
  -H "Content-Type: application/json" \
  -d '{"email":"admin@quorum.local","password":"admin1234"}' -i \
  | grep -i 'set-cookie\|HTTP/'

# Esperado:
#   HTTP/2 200
#   set-cookie: __Host-sid=...
```

## 4. Smoke tests desde la VPS (con login + páginas)

```bash
# Login y guardar cookie
curl -ks -X POST https://quorum.asistentepro.mx/backoffice/api/v1/auth/login \
  -H "Content-Type: application/json" \
  -d '{"email":"admin@quorum.local","password":"admin1234"}' \
  -c /tmp/c.txt

# Obtener token del cookie jar
SID=$(grep "__Host-sid" /tmp/c.txt | awk '{print $7}')

# Antes del fix, las 3 páginas devolvían HTML con "__next_error__".
# Después del fix, deberían devolver HTML real (con tokens RSC + payload).
for path in /backoffice/marbetes /backoffice/dispositivos /backoffice/audit; do
  echo "--- GET $path ---"
  curl -ks -H "Cookie: __Host-sid=$SID" -o /tmp/page.html -w "HTTP %{http_code}\n" \
    "https://quorum.asistentepro.mx$path"
  if grep -q '__next_error__' /tmp/page.html; then
    echo "  ✗ STILL BROKEN: error boundary detected"
  else
    echo "  ✓ Looks healthy (no error boundary in HTML)"
  fi
done
```

## 5. Aviso

Una vez completados los pasos 2-4 sin errores, avisame en la sesión y yo
corro la suite completa contra prod para confirmar 24/24 tests verde.

Comando que voy a correr:

```bash
cd /planQuorum/dev/quorum-backoffice/apps/web
npx playwright test --config=e2e/lookfeel/playwright.config.ts --reporter=list
```

Resultado esperado:
- 24/24 tests verde
- `artifacts/findings.json` con P0 count = 0 (BUG-001 cerrado)
- Las 10 interaction-flow tests que fallaban ahora pasan

## 6. Rollback (si algo sale mal)

```bash
ssh quorum@quorum.asistentepro.mx
cd /opt/quorum-backoffice
git checkout HEAD~3 -- apps/web/lib apps/web/app/'(authed)' apps/web/e2e apps/web/package.json
cd /opt/quorum-backoffice
npm run --workspaces --if-present build
sudo systemctl restart quorum-backoffice-api quorum-backoffice-web
```

El HEAD vuelve al commit previo (`2811e37 docs(plan): record Polish WU v1...`)
que era la base estable pre-auditoría.
