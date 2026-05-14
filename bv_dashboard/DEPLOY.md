# Deploying the Brownsville Dashboard

Single-host production deployment for the FastAPI backend + Vite SPA. Target
platform is Ubuntu 22.04+ with passwordless sudo (e.g. a Brev VM). The backend
serves both the API and the built SPA on one port — no reverse proxy is
required for internal access.

---

## What gets installed

| Artifact | Path on host |
|---|---|
| App source | `/home/<user>/bv_dashboard/` |
| Backend venv | `bv_dashboard/backend/.venv/` |
| Frontend bundle | `bv_dashboard/frontend/dist/` |
| Env file (secrets) | `bv_dashboard/.env` (mode 0600) |
| Systemd unit | `/etc/systemd/system/bv-dashboard.service` |

The systemd unit assumes the user is `shadeform` and the repo lives at
`/home/shadeform/bv_dashboard`. If your username or path differs, edit
`User=`, `Group=`, `WorkingDirectory=`, `ExecStart=`, `EnvironmentFile=`, and
`ReadWritePaths=` in [deploy/bv-dashboard.service](deploy/bv-dashboard.service)
before running the installer.

---

## First-time deploy

1. **Get the source onto the host** — any method (git clone, scp a tarball,
   etc.). End state: the repo lives at `~/bv_dashboard/` on the target.

2. **Run the installer.** Idempotent — safe to re-run on every release.
   ```bash
   cd ~/bv_dashboard
   bash deploy/install.sh
   ```
   This will:
   - Install Node.js 22 LTS via NodeSource (override major version with
     `BV_NODE_MAJOR=20 bash deploy/install.sh`)
   - Create `backend/.venv` and `pip install -r backend/requirements.txt`
   - Run `npm ci && npm run build` in `frontend/`
   - Copy the systemd unit into place
   - Seed `.env` from `.env.example` (mode 0600) if not already present
   - `systemctl daemon-reload`, `enable`, and `restart bv-dashboard.service`

3. **Edit secrets** and restart:
   ```bash
   $EDITOR ~/bv_dashboard/.env
   sudo systemctl restart bv-dashboard
   ```

4. **Verify health:**
   ```bash
   curl http://localhost:8000/api/health
   # → {"status":"ok","incidents":...,"vlm_observations":...}
   ```

5. **Open the dashboard.** On the host:
   ```
   http://localhost:8000/
   ```
   From your laptop:
   ```bash
   brev port-forward vai-data-ops -p 8000:8000
   # then open http://localhost:8000 locally
   ```

---

## Updates (subsequent deploys)

Pull or copy fresh source onto the host, then:
```bash
cd ~/bv_dashboard
bash deploy/install.sh   # idempotent — only rebuilds what changed
```

The installer reuses the venv and node_modules; expect a clean run in ~30s
when nothing changed and ~3 minutes on a cold install.

---

## Environment variables

All optional — defaults documented in
[`.env.example`](.env.example). Recommended minimum for a host reachable
from outside localhost:

```ini
ANTHROPIC_API_KEY=sk-ant-...    # enables live AI analysis
BV_ANALYZE_TOKEN=<random-32+>   # required header on /api/analyze
BV_RELOAD_TOKEN=<random-32+>    # required header on /api/vlm/reload
```

`/api/vlm/reload` is **fail-closed**: if `BV_RELOAD_TOKEN` is unset the
endpoint returns 503 ("reload disabled"). To enable hot CSV reloads, set the
token and pass it as `X-Reload-Token`. If the endpoint is disabled, restart
the service instead (`sudo systemctl restart bv-dashboard`).

| Variable | Purpose | Default |
|---|---|---|
| `ANTHROPIC_API_KEY` | Live `/api/analyze` streaming | unset → rule-based fallback |
| `BV_ANALYZE_MODEL` | Anthropic model SKU | `claude-sonnet-4-6` |
| `BV_ANALYZE_TOKEN` | HMAC gate on `/api/analyze` | unset → unauthenticated |
| `BV_RELOAD_TOKEN` | HMAC gate on `/api/vlm/reload` | unset → unauthenticated (warns) |
| `BV_CORS_ORIGINS` | CORS allowlist | localhost only |
| `BV_ANALYZE_RATE` | slowapi rule | `20/minute` |
| `BV_RELOAD_RATE` | slowapi rule | `5/minute` |
| `BV_PORT` | uvicorn bind port | `8000` |
| `BV_WORKERS` | uvicorn worker count (keep at 1 — see note below) | `1` |
| `BV_FRONTEND_DIST` | Static dir to serve | `<repo>/frontend/dist` |
| `BV_TLS_DOMAIN` | Domain for Caddy auto-TLS at install time | unset → no TLS |

> **Workers must stay at 1** unless you also externalise VLM data. Each
> uvicorn worker is a separate Python process with its own in-memory copy
> of the VLM observations, and `/api/vlm/reload` only refreshes the worker
> that handles the request. With `BV_WORKERS=2+` the cache drifts across
> processes. The app is read-mostly and I/O-light, so 1 worker is plenty
> for the expected internal load.

---

## Operations

| Task | Command |
|---|---|
| Service status | `systemctl status bv-dashboard` |
| Tail logs | `journalctl -u bv-dashboard -f` |
| Last 200 lines | `journalctl -u bv-dashboard -n 200 --no-pager` |
| Restart | `sudo systemctl restart bv-dashboard` |
| Stop | `sudo systemctl stop bv-dashboard` |
| Disable on boot | `sudo systemctl disable bv-dashboard` |
| Hot-reload VLM CSVs without restart | `curl -X POST -H "X-Reload-Token: $BV_RELOAD_TOKEN" http://localhost:8000/api/vlm/reload` |

---

## Going public (HTTPS)

The single-port setup is fine for internal access via `brev port-forward` or a
SSH tunnel. To expose the dashboard on the open internet, run the installer
with `BV_TLS_DOMAIN` set — Caddy gets installed, the [Caddyfile.example](deploy/Caddyfile.example)
template is rendered with your domain, and Let's Encrypt auto-provisions the cert:

```bash
# Point DNS for dashboard.example.com at this host's public IP first.
cd ~/bv_dashboard
BV_TLS_DOMAIN=dashboard.example.com bash deploy/install.sh
```

The default already fails-closed on `/api/vlm/reload` when `BV_RELOAD_TOKEN`
is unset (returns 503). Still set both `BV_ANALYZE_TOKEN` and
`BV_RELOAD_TOKEN` in `.env` before exposing publicly so the AI endpoint is
also gated. After updating `.env`:

```bash
sudo systemctl restart bv-dashboard
```

---

## Rollback

The installer doesn't snapshot the prior bundle. To roll back: redeploy the
previous source tree and re-run `bash deploy/install.sh`. State that's safe
across restarts:

- VLM CSV data files in `backend/data/` (unaffected by deploys)
- `.env` secrets (not overwritten by the installer once present)

There is no database; incident data is generated in memory from a fixed seed
(`random.Random(42)` at [backend/main.py:163](backend/main.py#L163)), so the
dashboard is fully reproducible across hosts.

---

## Manual launch (for debugging)

If you need to bypass systemd:
```bash
cd ~/bv_dashboard
source backend/.venv/bin/activate
bash deploy/run-prod.sh        # foreground; Ctrl+C to stop
```

For the dev experience (hot-reload frontend + auto-reload backend), use the
legacy [start.sh](start.sh) instead — but don't run that as a production
service, it spins up the Vite dev server.
