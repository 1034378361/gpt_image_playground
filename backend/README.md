# GPT Image Playground Backend

FastAPI backend for account login, user isolation, admin-managed API channels, template review, asset storage, and server-side image generation.

The frontend is no longer supported as a frontend-only static site. Production deployments must expose this backend on the same origin under `/api/*`.

## Run locally

```bash
pip install -r backend/requirements.txt
npm run backend:dev
```

The Vite dev server proxies `/api/*` to `http://127.0.0.1:8000`.

## Environment

- `OPENAI_BASE_URL`: fallback upstream API base URL, defaults to `https://api.openai.com/v1`.
- `GIP_REQUEST_TIMEOUT_SECONDS`: default request timeout for new channels, defaults to `300`.
- `GIP_GENERATION_WORKER_COUNT`: number of concurrent backend generation workers, defaults to `4`.
- `GIP_DATA_DIR`: local data directory, defaults to `backend/data`.
- `GIP_DATABASE_PATH`: SQLite path, defaults to `backend/data/app.sqlite3`.
- `GIP_ASSET_DIR`: uploaded/generated asset directory, defaults to `backend/data/assets`.
- `GIP_SESSION_SECURE`: set to `true` behind HTTPS.

Upstream Base URL, API Key, request timeout, and model availability are configured by administrator accounts through `/api/admin/channels`; they are not accepted from normal browser generation requests.

Admin users can also use `/api/admin/system/export` and `/api/admin/system/import` to back up and restore the server database plus stored image assets.

## Docker / NAS

For NAS deployment, prefer the repository root `docker-compose.yml`, which starts:

- `backend`: this FastAPI service
- `frontend`: an nginx container that serves the built frontend and proxies same-origin `/api/*` requests back to the backend

The backend container persists all state under:

```text
/app/backend/data
```

Map that path to a host volume so these items survive container recreation:

- `app.sqlite3`
- `assets/`
- `restore-points/`

If you run through HTTPS on your NAS reverse proxy, set:

```env
GIP_SESSION_SECURE=true
```

Because the default storage is SQLite, NAS deployments should run only one backend instance against a given data directory.

## Test

```bash
npm run backend:test
```
