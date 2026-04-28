# GPT Image Playground Backend

FastAPI backend for private prompt templates, user isolation, asset storage, and optional server-side image generation proxy.

## Run locally

```bash
pip install -r backend/requirements.txt
npm run backend:dev
```

The Vite dev server proxies `/api/*` to `http://127.0.0.1:8000`.

## Environment

- `OPENAI_API_KEY`: server-side API key used by `/api/generate`.
- `OPENAI_BASE_URL`: upstream API base URL, defaults to `https://api.openai.com/v1`.
- `GIP_DATA_DIR`: local data directory, defaults to `backend/data`.
- `GIP_DATABASE_PATH`: SQLite path, defaults to `backend/data/app.sqlite3`.
- `GIP_ASSET_DIR`: uploaded/generated asset directory, defaults to `backend/data/assets`.
- `GIP_SESSION_SECURE`: set to `true` behind HTTPS.
- `GIP_ALLOW_CLIENT_API_KEY`: set to `true` only if you intentionally allow the browser-provided key to be used by the backend proxy.

## Test

```bash
npm run backend:test
```
