#!/bin/bash
# start.sh — Launch both backend and frontend

set -e

ROOT="$(cd "$(dirname "$0")" && pwd)"

echo ""
echo "  ⬡  Brownsville TX Public Safety Dashboard"
echo "  ─────────────────────────────────────────"
echo ""

# Backend
cd "$ROOT/backend"
echo "  → Starting FastAPI backend on http://localhost:8000"
uvicorn main:app --reload --port 8000 &
BACKEND_PID=$!
sleep 1

# Frontend
cd "$ROOT/frontend"
echo "  → Starting Vite frontend on http://localhost:5173"
npm run dev &
FRONTEND_PID=$!

echo ""
echo "  Dashboard: http://localhost:5173"
echo "  API docs:  http://localhost:8000/docs"
echo "  Press Ctrl+C to stop both servers."
echo ""

trap "kill $BACKEND_PID $FRONTEND_PID 2>/dev/null; exit 0" INT TERM
wait
