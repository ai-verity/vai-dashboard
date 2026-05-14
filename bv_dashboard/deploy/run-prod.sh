#!/bin/bash
# run-prod.sh — production launcher called by systemd.
# Activates the backend venv and runs uvicorn bound to 0.0.0.0:8000.
# Frontend bundle (frontend/dist) is built once at install time, not here.

set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT/backend"

# shellcheck disable=SC1091
source .venv/bin/activate

# Default to one worker. The VLM data is loaded in-memory per process and
# /api/vlm/reload only refreshes the worker that handles the request, so >1
# worker causes the cache to drift across processes. Bump BV_WORKERS only if
# you also externalise the data layer (e.g. Redis) or accept the drift.
exec uvicorn main:app \
    --host 0.0.0.0 \
    --port "${BV_PORT:-8000}" \
    --workers "${BV_WORKERS:-1}" \
    --proxy-headers \
    --forwarded-allow-ips='*'
