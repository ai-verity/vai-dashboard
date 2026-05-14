#!/bin/bash
# install.sh — one-shot installer for the Brownsville Dashboard.
#
# Target: Ubuntu 22.04+ with passwordless sudo. Idempotent — safe to re-run
# after pulling new code. Performs:
#   1. Install Node.js 22 LTS (via NodeSource) if missing.
#   2. Create / refresh the backend Python venv and install requirements.
#   3. npm ci + npm run build for the frontend.
#   4. Install (or refresh) the systemd unit at /etc/systemd/system/.
#   5. Reload systemd and (re)start bv-dashboard.service.
#
# Run from the repo root:
#   bash deploy/install.sh

set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
SERVICE_NAME="bv-dashboard.service"
SERVICE_SRC="$ROOT/deploy/$SERVICE_NAME"
SERVICE_DST="/etc/systemd/system/$SERVICE_NAME"
NODE_MAJOR="${BV_NODE_MAJOR:-22}"

log() { printf '\n→ %s\n' "$*"; }

# 1. Node.js -----------------------------------------------------------------
if ! command -v node >/dev/null 2>&1; then
    log "Installing Node.js ${NODE_MAJOR}.x via NodeSource"
    curl -fsSL "https://deb.nodesource.com/setup_${NODE_MAJOR}.x" | sudo -E bash -
    sudo apt-get install -y nodejs
else
    log "Node.js already installed: $(node --version)"
fi

# 2. Backend venv ------------------------------------------------------------
log "Setting up backend venv at backend/.venv"
cd "$ROOT/backend"
if [ ! -d .venv ]; then
    python3 -m venv .venv
fi
# shellcheck disable=SC1091
source .venv/bin/activate
pip install --quiet --upgrade pip
pip install --quiet -r requirements.txt
deactivate

# 3. Frontend build ----------------------------------------------------------
log "Building frontend bundle"
cd "$ROOT/frontend"
if [ -f package-lock.json ]; then
    npm ci
else
    npm install
fi
npm run build

# 4. Systemd unit ------------------------------------------------------------
log "Installing systemd unit at $SERVICE_DST"
sudo install -m 0644 "$SERVICE_SRC" "$SERVICE_DST"

# 5. .env scaffold -----------------------------------------------------------
if [ ! -f "$ROOT/.env" ]; then
    log "Seeding .env from .env.example (review and fill in secrets)"
    cp "$ROOT/.env.example" "$ROOT/.env"
    chmod 600 "$ROOT/.env"
fi

# 6. Start / restart service -------------------------------------------------
log "Reloading systemd and (re)starting $SERVICE_NAME"
sudo systemctl daemon-reload
sudo systemctl enable "$SERVICE_NAME"
sudo systemctl restart "$SERVICE_NAME"

sleep 2
sudo systemctl --no-pager --full status "$SERVICE_NAME" | head -20 || true

# 7. Optional TLS via Caddy --------------------------------------------------
# Set BV_TLS_DOMAIN=dashboard.example.com before running install.sh to enable.
# Requires DNS for the domain to already point at this host's public IP.
if [ -n "${BV_TLS_DOMAIN:-}" ]; then
    log "Configuring TLS reverse proxy for $BV_TLS_DOMAIN via Caddy"

    if ! command -v caddy >/dev/null 2>&1; then
        log "Installing Caddy from official apt repo"
        sudo apt-get install -y debian-keyring debian-archive-keyring apt-transport-https curl
        curl -fsSL "https://dl.cloudsmith.io/public/caddy/stable/gpg.key" | \
            sudo gpg --batch --yes --dearmor -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
        curl -fsSL "https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt" | \
            sudo tee /etc/apt/sources.list.d/caddy-stable.list >/dev/null
        sudo apt-get update
        sudo apt-get install -y caddy
    fi

    CADDYFILE_RENDERED="$(mktemp)"
    sed "s|__BV_TLS_DOMAIN__|${BV_TLS_DOMAIN}|g" "$ROOT/deploy/Caddyfile.example" > "$CADDYFILE_RENDERED"
    sudo install -m 0644 "$CADDYFILE_RENDERED" /etc/caddy/Caddyfile
    rm -f "$CADDYFILE_RENDERED"

    sudo systemctl enable caddy
    sudo systemctl reload caddy || sudo systemctl restart caddy

    TLS_NOTE="  Public URL:     https://$BV_TLS_DOMAIN  (Caddy auto-provisions Let's Encrypt)"
else
    TLS_NOTE="  TLS:            disabled (rerun with BV_TLS_DOMAIN=dashboard.example.com to enable)"
fi

cat <<EOF

✓ Install complete.
  Service:        systemctl status $SERVICE_NAME
  Logs:           journalctl -u $SERVICE_NAME -f
  Local health:   curl http://localhost:8000/api/health
  Edit secrets:   \$EDITOR $ROOT/.env  (then: sudo systemctl restart $SERVICE_NAME)
$TLS_NOTE

EOF
