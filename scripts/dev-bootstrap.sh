#!/usr/bin/env bash
# dev-bootstrap.sh — Idempotent local environment bootstrap for quorum-backoffice.
# Installs Redis, creates quorum_backoffice + quorum_backoffice_test DBs.
# Run with: bash scripts/dev-bootstrap.sh

set -euo pipefail

log()  { printf '\033[1;34m[bootstrap]\033[0m %s\n' "$*"; }
warn() { printf '\033[1;33m[bootstrap][warn]\033[0m %s\n' "$*"; }
fail() { printf '\033[1;31m[bootstrap][fail]\033[0m %s\n' "$*" >&2; exit 1; }

require_cmd() {
  command -v "$1" >/dev/null 2>&1 || fail "missing required command: $1"
}

PG_DB="${PG_DATABASE:-quorum_backoffice}"
PG_DB_TEST="${PG_DATABASE_TEST:-quorum_backoffice_test}"
PG_USER_BOOTSTRAP="${PG_USER_BOOTSTRAP:-postgres}"

# ---- 1. Redis ----
if command -v redis-cli >/dev/null 2>&1 && redis-cli ping >/dev/null 2>&1; then
  log "redis-cli reports PONG; skipping install."
else
  log "installing redis-server (apt)..."
  require_cmd apt-get
  sudo apt-get update -y >/dev/null
  sudo apt-get install -y redis-server >/dev/null
  log "starting redis-server..."
  if command -v systemctl >/dev/null; then
    sudo systemctl enable --now redis-server 2>/dev/null || sudo service redis-server start
  else
    sudo service redis-server start
  fi
  for _ in $(seq 1 10); do
    if redis-cli ping >/dev/null 2>&1; then break; fi
    sleep 1
  done
  redis-cli ping | grep -q PONG || fail "redis did not become ready"
fi

# ---- 2. PostgreSQL databases ----
require_cmd psql

db_exists() {
  local db=$1
  sudo -u "${PG_USER_BOOTSTRAP}" psql -tAc "SELECT 1 FROM pg_database WHERE datname='${db}'" 2>/dev/null | grep -q 1
}

create_db() {
  local db=$1
  if db_exists "$db"; then
    log "database ${db} already exists; skipping create."
  else
    log "creating database ${db}..."
    sudo -u "${PG_USER_BOOTSTRAP}" createdb "${db}" || fail "createdb ${db} failed"
  fi
  log "ensuring pgcrypto extension on ${db}..."
  sudo -u "${PG_USER_BOOTSTRAP}" psql -d "${db}" -c "CREATE EXTENSION IF NOT EXISTS pgcrypto;" >/dev/null
}

create_db "${PG_DB}"
create_db "${PG_DB_TEST}"

# ---- 3. App user (idempotent) ----
APP_DB_USER="${APP_DB_USER:-websop}"
APP_DB_PASSWORD_VALUE="${APP_DB_PASSWORD:-quorum_backoffice_dev}"
if sudo -u "${PG_USER_BOOTSTRAP}" psql -tAc "SELECT 1 FROM pg_roles WHERE rolname='${APP_DB_USER}'" 2>/dev/null | grep -q 1; then
  log "role ${APP_DB_USER} already exists; skipping create."
else
  log "creating role ${APP_DB_USER}..."
  if ! sudo -u "${PG_USER_BOOTSTRAP}" psql -c "CREATE USER ${APP_DB_USER} WITH PASSWORD '${APP_DB_PASSWORD_VALUE}' SUPERUSER;" 2>/dev/null; then warn "could not create role ${APP_DB_USER} (peer-auth user likely present). continuing."; fi
fi

log "bootstrap complete."
log "DATABASE_URL=postgresql://${APP_DB_USER}:${APP_DB_PASSWORD_VALUE}@127.0.0.1:5432/${PG_DB}"
log "DATABASE_URL_TEST=postgresql://${APP_DB_USER}:${APP_DB_PASSWORD_VALUE}@127.0.0.1:5432/${PG_DB_TEST}"
