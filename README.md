# Brownsville TX — Public Safety Dashboard

The runnable application lives in [`bv_dashboard/`](bv_dashboard/). See [`bv_dashboard/README.md`](bv_dashboard/README.md) for the full stack description, API reference, and step-by-step run instructions.

## Quick start

```bash
cd bv_dashboard

# First time only — install dependencies
(cd backend  && python3 -m venv .venv && source .venv/bin/activate && pip install fastapi uvicorn httpx pydantic)
(cd frontend && npm install)

# Launch both servers
./start.sh
```

Then open `http://localhost:5173`. API docs are at `http://localhost:8000/docs`.

Full instructions, manual launch steps, environment variables, and troubleshooting: [`bv_dashboard/README.md`](bv_dashboard/README.md).

## Repository layout

| Path                                    | Purpose                                                                 |
|-----------------------------------------|-------------------------------------------------------------------------|
| [`bv_dashboard/`](bv_dashboard/)        | **Canonical app** — FastAPI backend + Vite/React frontend               |
| [`Prompts/`](Prompts/)                  | Source prompt text used to derive `bv_dashboard/backend/data/vlm_prompts.json` |
| [`VLM outputs/`](VLM%20outputs/)        | Raw VLM caption CSV exports                                             |
| `App.tsx`, `ChartsPage.tsx`, `DashboardPage.tsx`, `useApi.ts`, `main.py` | Legacy single-file prototypes — superseded by `bv_dashboard/`, kept for reference only |
| `brownsville_safety_dashboard_1.html`   | Earliest single-file HTML prototype                                     |
