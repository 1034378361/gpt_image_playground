# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

```bash
# Frontend dev server (proxies /api/* to backend)
npm run dev

# Backend dev server
pip install -r backend/requirements.txt
npm run backend:dev

# Build frontend
npm run build

# Frontend tests (vitest)
npm run test              # single run
npm run test:watch        # watch mode
npx vitest run src/lib/mask.test.ts   # single test file

# Backend tests (pytest)
npm run backend:test

# E2E tests (Playwright)
npm run e2e

# Docker (split frontend/backend)
docker compose up --build

# Docker (single all-in-one image)
npm run docker:build:single
```

## Architecture

This is a multi-user image generation studio with a React SPA frontend and a FastAPI backend. The backend is required — the app does not function as a static site.

### Frontend (src/)

- **Framework**: React 19 + Zustand + Tailwind CSS, built with Vite
- **State**: `store.ts` holds all UI/app state via Zustand with `persist` middleware (IndexedDB). `storeBackend.ts` contains server-sync logic (init, polling, generation dispatch).
- **API layer**: `src/lib/backendApi.ts` — all `/api/*` calls. The Vite dev server proxies `/api` to the backend at `http://127.0.0.1:8000`.
- **Local storage**: `src/lib/db.ts` wraps IndexedDB for offline image/task/template caching.
- **Roles**: Three user roles (`user`, `reviewer`, `admin`) checked via `src/lib/roles.ts`.
- **Views**: The app switches between task grid, template grid, and project board views via `currentView` in the store.

### Backend (backend/app/)

- **Framework**: FastAPI with SQLite (single-file DB at `backend/data/app.sqlite3`)
- **Entry**: `main.py` — all route handlers in one file
- **Modules**:
  - `config.py` — settings from env vars (prefixed `GIP_*`)
  - `db.py` — SQLite connection/init with schema migrations
  - `schemas.py` — Pydantic request/response models
  - `security.py` — bcrypt password hashing, session tokens
  - `assets.py` — image storage, thumbnails, data-URL conversion
  - `generation_runtime.py` — async worker queue for image generation tasks
- **Auth**: Cookie-based sessions. First registered user becomes admin.
- **Generation**: Backend proxies requests to OpenAI-compatible image APIs via admin-configured "channels" (each channel has its own base URL, API key, timeout, model list).
- **Data**: All persistent state lives under `backend/data/` (gitignored): SQLite DB, image assets, restore-point archives.

### Deployment (deploy/)

- Two-container compose: `Dockerfile.backend` (uvicorn) + `Dockerfile.frontend` (nginx + built SPA)
- Single all-in-one image: `Dockerfile.all-in-one` via `build-single-image.mjs`
- GitHub Actions publishes to GHCR on version tags

## Key Patterns

- The frontend uses lazy-loaded components (`React.lazy`) for all modals and secondary views.
- Generation tasks flow: frontend submits to `/api/generate` → backend queues in `GenerationRuntime` → workers call upstream API → results stored as assets → frontend polls task status.
- Backend tests use `monkeypatch` + `tmp_path` to isolate each test with a fresh DB and reimported modules.
- UI text is in Chinese (zh-CN).
