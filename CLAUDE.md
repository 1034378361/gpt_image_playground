# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

```bash
# Install dependencies
npm install
uv pip install -r backend/requirements.txt
npx playwright install

# Local development: run backend and frontend in separate terminals
npm run backend:dev
npm run dev

# Frontend type-check/build/preview
npx tsc -b
npm run build
npm run preview

# Frontend tests (Vitest)
npm run test
npm run test:watch
npx vitest run src/store.test.ts
npx vitest run src/lib/mask.test.ts

# Backend tests (Pytest; run through uv so pytest/pytest-asyncio come from backend/requirements.txt)
npm run backend:test
uv run --with-requirements backend/requirements.txt python -m pytest backend/tests/test_api.py
uv run --with-requirements backend/requirements.txt python -m pytest backend/tests/test_generation_runtime.py

# E2E tests (Playwright; tests mock /api routes and start Vite on 127.0.0.1:4174)
npm run e2e
npx playwright test e2e/app.spec.ts

# Release/build smoke checks
npm run version:check
npm run smoke:dist

# Docker / NAS builds
docker compose up --build
npm run docker:build:single
npm run docker:save:single
```

There is no dedicated lint script in `package.json`; `npm run build` runs `tsc -b` before the Vite build. `package.json` is the canonical app version; `npm run version:check` verifies it against `package-lock.json`, release tags, and the NAS single-image env example. `npm run smoke:dist` requires a prior `npm run build` and checks the built `dist/` bundle for required static files and disabled Service Worker registration.

### Code analysis tools

When refactoring, auditing quality, or checking for dead code/security issues, use these proactively:

```bash
# Dead code (Python)
vulture backend/app/ --min-confidence 80

# Dead code + unused deps (TypeScript)
npx knip

# Cyclomatic complexity / maintainability (Python)
radon cc backend/app/ -s -n B
radon mi backend/app/ -s -n B

# Circular dependencies (TypeScript)
madge --circular src/

# Duplication
jscpd src/ --min-lines 5 --reporters console
jscpd backend/app/ --min-lines 5 --reporters console

# Security / dependency audit
bandit -r backend/app/ -ll
npm audit
```

## Architecture

This is a same-origin React SPA plus FastAPI backend for multi-user image generation. The frontend is no longer a standalone static app: production deployments must serve a working `/api/*` backend on the same origin.

### Frontend

- Vite proxies `/api` to `http://127.0.0.1:8000` by default; override with `VITE_BACKEND_PROXY_TARGET`.
- `src/App.tsx` lazy-loads the major views and modals; `src/main.tsx` mounts the React app.
- `src/store.ts` defines the Zustand app state, persisted settings, in-memory image LRU cache, UI state, and local task/template actions.
- `src/storeBackend.ts` handles IndexedDB bootstrap, backend session loading, server sync, generation submission, refresh/polling behavior, admin data loading, and backup/restore calls.
- `src/storeTaskMutations.ts` and `src/storeTemplateActions.ts` hold shared task/template mutation helpers used by the store and backend sync paths.
- `src/lib/backendApi.ts` is the single fetch layer for `/api/*`; requests are cookie-authenticated and use the selected channel/model settings where needed.
- `src/lib/db.ts` stores browser-side tasks, templates, and image blobs in IndexedDB. It is a cache/bootstrap layer, not the source of truth once the user is logged in.
- The UI copy is primarily zh-CN.

### Backend

- `backend/app/main.py` creates the FastAPI app, registers CORS, includes route modules, starts generation workers on lifespan startup, recovers pending tasks, and serves `dist/` as an SPA fallback when a frontend build is present.
- Route handlers live under `backend/app/routes/`: `auth`, `admin`, `assets`, `channels`, `generations`, `projects`, `prompts`, and `templates`.
- `backend/app/generation_runtime.py` is the async queue/worker runtime for generation tasks; route code supplies task preparation, completion, cancellation, and recovery callbacks.
- `backend/app/db.py` owns SQLite connection handling and schema initialization.
- `backend/app/config.py` reads environment variables prefixed with `GIP_*` plus `OPENAI_BASE_URL`.
- `backend/app/security.py` manages password hashing and cookie-backed sessions.

### Data model and flows

- Persistent server state lives under `backend/data/`: SQLite database (`app.sqlite3`), generated/uploaded assets, and restore points.
- Browser IndexedDB caches recent tasks/templates/images for startup and local image reuse, but server data is authoritative once the user is logged in.
- The first registered user becomes admin. Roles are `user`, `reviewer`, and `admin`.
- Admin-managed channels define upstream base URL, API key, timeout, model list, compatibility mode, and Codex CLI mode. Normal users only choose from enabled channels/models.
- Generation flow: frontend prepares prompt/images/mask data, submits to backend generation routes, backend enqueues work in `GenerationRuntime`, workers call the configured upstream image API, then results are stored as assets plus task metadata for polling/sync.
- Templates support private drafts plus reviewed public sharing, and tasks/templates can be grouped into project boards.
- Open prompt imports are handled by backend prompt routes and parser helpers, then appear as reviewed/importable template data in the UI.

### Deployment shape

- `docker-compose.yml` runs split frontend/backend containers and persists `backend/data` for NAS-style deployments.
- `docker-compose.single.yml` and `deploy/Dockerfile.all-in-one` support single-image deployment; `deploy/build-single-image.mjs` builds/saves that image.
- `vercel.json` only covers the frontend shell; a separate same-origin backend/reverse proxy is still required.
- Because the default persistence layer is SQLite, production/NAS setups should avoid multiple backend instances writing the same `backend/data/` directory.
