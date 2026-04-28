from __future__ import annotations

import base64
import io
import json
import mimetypes
import re
from collections import defaultdict, deque
from contextlib import asynccontextmanager
from pathlib import Path
from typing import Any
from urllib.parse import urljoin

import httpx
from fastapi import BackgroundTasks, Depends, FastAPI, File, Form, HTTPException, Request, Response, UploadFile
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse
from PIL import Image, UnidentifiedImageError
from pydantic import ValidationError

from .config import settings
from .db import get_conn, init_db
from .schemas import (
    AssetOut,
    AuthIn,
    GenerateIn,
    GenerateOut,
    GenerateRunOut,
    GenerationTaskIn,
    GenerationTaskOut,
    GenerationTaskPatch,
    PromptTemplateIn,
    PromptTemplateOut,
    PromptTemplatePatch,
    SetCoverIn,
    TaskParams,
    UserOut,
)
from .security import create_session_token, hash_password, new_id, now_ms, verify_password

LOGIN_ATTEMPTS: dict[str, deque[int]] = defaultdict(deque)
ALLOWED_IMAGE_MIMES = {"image/png", "image/jpeg", "image/webp"}

@asynccontextmanager
async def lifespan(_: FastAPI):
    init_db()
    yield


app = FastAPI(title="GPT Image Playground API", lifespan=lifespan)

app.add_middleware(
    CORSMiddleware,
    allow_origins=settings.cors_origins,
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)


def json_dumps(value: Any) -> str:
    return json.dumps(value, ensure_ascii=False, separators=(",", ":"))


def json_loads(value: str | None, fallback: Any) -> Any:
    if not value:
        return fallback
    try:
        return json.loads(value)
    except json.JSONDecodeError:
        return fallback


def normalize_base_url(value: str | None) -> str:
    raw = (value or settings.default_api_base_url).strip().rstrip("/")
    if not raw:
        raw = settings.default_api_base_url.rstrip("/")
    if not re.match(r"^[a-zA-Z][a-zA-Z\d+.-]*://", raw):
        raw = f"https://{raw}"
    if not raw.rstrip("/").endswith("/v1"):
        raw = f"{raw}/v1"
    return raw.rstrip("/")


def endpoint_url(base_url: str, endpoint: str) -> str:
    return urljoin(f"{base_url.rstrip('/')}/", endpoint.lstrip("/"))


def row_to_user(row: Any) -> UserOut:
    return UserOut(
        id=row["id"],
        username=row["username"],
        role=row["role"],
        createdAt=row["created_at"],
        updatedAt=row["updated_at"],
    )


def row_to_template(row: Any) -> PromptTemplateOut:
    return PromptTemplateOut(
        id=row["id"],
        userId=row["user_id"],
        title=row["title"],
        description=row["description"],
        prompt=row["prompt"],
        negativePrompt=row["negative_prompt"],
        tags=json_loads(row["tags_json"], []),
        category=row["category"],
        params=TaskParams.model_validate(json_loads(row["params_json"], {})),
        apiMode=row["api_mode"],
        model=row["model"],
        coverImageId=row["cover_image_id"],
        linkedTaskIds=json_loads(row["linked_task_ids_json"], []),
        isFavorite=bool(row["is_favorite"]),
        version=row["version"],
        createdAt=row["created_at"],
        updatedAt=row["updated_at"],
    )


def row_to_task(row: Any) -> GenerationTaskOut:
    return GenerationTaskOut(
        id=row["id"],
        userId=row["user_id"],
        templateId=row["template_id"],
        templateVersionId=row["template_version_id"],
        prompt=row["prompt"],
        params=TaskParams.model_validate(json_loads(row["params_json"], {})),
        inputImageIds=json_loads(row["input_image_ids_json"], []),
        outputImages=json_loads(row["output_image_ids_json"], []),
        actualParams=json_loads(row["actual_params_json"], None),
        actualParamsByImage=json_loads(row["actual_params_by_image_json"], None),
        revisedPromptByImage=json_loads(row["revised_prompt_by_image_json"], None),
        status=row["status"],
        error=row["error"],
        createdAt=row["created_at"],
        finishedAt=row["finished_at"],
        elapsed=row["elapsed"],
        isFavorite=bool(row["is_favorite"]),
        apiMode=row["api_mode"],
        model=row["model"],
    )


def row_to_asset(row: Any) -> AssetOut:
    return AssetOut(
        id=row["id"],
        userId=row["user_id"],
        taskId=row["task_id"],
        templateId=row["template_id"],
        type=row["type"],
        mime=row["mime"],
        width=row["width"],
        height=row["height"],
        sizeBytes=row["size_bytes"],
        hasThumbnail=bool(row["thumbnail_path"]),
        createdAt=row["created_at"],
    )


def require_user(request: Request) -> UserOut:
    token = request.cookies.get(settings.session_cookie_name)
    if not token:
        raise HTTPException(status_code=401, detail="Not authenticated")

    ts = now_ms()
    with get_conn() as conn:
        row = conn.execute(
            """
            SELECT users.* FROM sessions
            JOIN users ON users.id = sessions.user_id
            WHERE sessions.id = ? AND (sessions.expires_at IS NULL OR sessions.expires_at > ?)
            """,
            (token, ts),
        ).fetchone()
    if not row:
        raise HTTPException(status_code=401, detail="Not authenticated")
    return row_to_user(row)


def set_session_cookie(response: Response, token: str) -> None:
    response.set_cookie(
        settings.session_cookie_name,
        token,
        httponly=True,
        secure=settings.session_secure,
        samesite="lax",
        max_age=settings.session_ttl_seconds,
        path="/",
    )


def assert_auth_not_rate_limited(username: str) -> None:
    key = username.lower()
    window_ms = 15 * 60 * 1000
    now = now_ms()
    attempts = LOGIN_ATTEMPTS[key]
    while attempts and attempts[0] < now - window_ms:
        attempts.popleft()
    if len(attempts) >= 8:
        raise HTTPException(status_code=429, detail="Too many login attempts, please try again later")


def record_failed_auth(username: str) -> None:
    LOGIN_ATTEMPTS[username.lower()].append(now_ms())


def clear_failed_auth(username: str) -> None:
    LOGIN_ATTEMPTS.pop(username.lower(), None)


@app.post("/api/auth/register", response_model=UserOut)
def register(payload: AuthIn, response: Response) -> UserOut:
    username = payload.username.strip()
    if not username:
        raise HTTPException(status_code=400, detail="Username is required")

    user_id = new_id()
    ts = now_ms()
    expires_at = ts + settings.session_ttl_seconds * 1000
    password_hash = hash_password(payload.password)
    token = create_session_token()

    try:
        with get_conn() as conn:
            conn.execute(
                """
                INSERT INTO users (id, username, password_hash, role, created_at, updated_at)
                VALUES (?, ?, ?, 'user', ?, ?)
                """,
                (user_id, username, password_hash, ts, ts),
            )
            conn.execute(
                "INSERT INTO sessions (id, user_id, created_at, expires_at) VALUES (?, ?, ?, ?)",
                (token, user_id, ts, expires_at),
            )
            row = conn.execute("SELECT * FROM users WHERE id = ?", (user_id,)).fetchone()
    except Exception as exc:
        if "UNIQUE" in str(exc).upper():
            raise HTTPException(status_code=409, detail="Username already exists") from exc
        raise

    set_session_cookie(response, token)
    return row_to_user(row)


@app.post("/api/auth/login", response_model=UserOut)
def login(payload: AuthIn, response: Response) -> UserOut:
    username = payload.username.strip()
    assert_auth_not_rate_limited(username)
    with get_conn() as conn:
        row = conn.execute("SELECT * FROM users WHERE username = ?", (username,)).fetchone()
        if not row or not verify_password(payload.password, row["password_hash"]):
            record_failed_auth(username)
            raise HTTPException(status_code=401, detail="Invalid username or password")

        token = create_session_token()
        ts = now_ms()
        expires_at = ts + settings.session_ttl_seconds * 1000
        conn.execute(
            "INSERT INTO sessions (id, user_id, created_at, expires_at) VALUES (?, ?, ?, ?)",
            (token, row["id"], ts, expires_at),
        )

    clear_failed_auth(username)
    set_session_cookie(response, token)
    return row_to_user(row)


@app.post("/api/auth/logout")
def logout(request: Request, response: Response) -> dict[str, bool]:
    token = request.cookies.get(settings.session_cookie_name)
    if token:
        with get_conn() as conn:
            conn.execute("DELETE FROM sessions WHERE id = ?", (token,))
    response.delete_cookie(settings.session_cookie_name, path="/")
    return {"ok": True}


@app.get("/api/auth/me", response_model=UserOut)
def me(user: UserOut = Depends(require_user)) -> UserOut:
    return user


@app.get("/api/templates", response_model=list[PromptTemplateOut])
def list_templates(user: UserOut = Depends(require_user)) -> list[PromptTemplateOut]:
    with get_conn() as conn:
        rows = conn.execute(
            "SELECT * FROM prompt_templates WHERE user_id = ? ORDER BY updated_at DESC",
            (user.id,),
        ).fetchall()
    return [row_to_template(row) for row in rows]


@app.post("/api/templates", response_model=PromptTemplateOut)
def create_template(payload: PromptTemplateIn, user: UserOut = Depends(require_user)) -> PromptTemplateOut:
    template_id = new_id()
    ts = now_ms()
    with get_conn() as conn:
        conn.execute(
            """
            INSERT INTO prompt_templates (
              id, user_id, title, description, prompt, negative_prompt, tags_json, category,
              params_json, api_mode, model, cover_image_id, linked_task_ids_json,
              is_favorite, version, created_at, updated_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?)
            """,
            (
                template_id,
                user.id,
                payload.title,
                payload.description,
                payload.prompt,
                payload.negativePrompt,
                json_dumps(payload.tags),
                payload.category,
                payload.params.model_dump_json(),
                payload.apiMode,
                payload.model,
                payload.coverImageId,
                json_dumps(payload.linkedTaskIds),
                int(payload.isFavorite),
                ts,
                ts,
            ),
        )
        row = conn.execute("SELECT * FROM prompt_templates WHERE id = ? AND user_id = ?", (template_id, user.id)).fetchone()
    return row_to_template(row)


def get_template_or_404(template_id: str, user_id: str) -> PromptTemplateOut:
    with get_conn() as conn:
        row = conn.execute(
            "SELECT * FROM prompt_templates WHERE id = ? AND user_id = ?",
            (template_id, user_id),
        ).fetchone()
    if not row:
        raise HTTPException(status_code=404, detail="Template not found")
    return row_to_template(row)


@app.get("/api/templates/{template_id}", response_model=PromptTemplateOut)
def get_template(template_id: str, user: UserOut = Depends(require_user)) -> PromptTemplateOut:
    return get_template_or_404(template_id, user.id)


@app.patch("/api/templates/{template_id}", response_model=PromptTemplateOut)
def patch_template(template_id: str, payload: PromptTemplatePatch, user: UserOut = Depends(require_user)) -> PromptTemplateOut:
    existing = get_template_or_404(template_id, user.id)
    data = payload.model_dump(exclude_unset=True)
    if not data:
        return existing

    ts = now_ms()
    next_template = PromptTemplateOut.model_validate({**existing.model_dump(), **data})
    with get_conn() as conn:
        conn.execute(
            """
            UPDATE prompt_templates SET
              title = ?, description = ?, prompt = ?, negative_prompt = ?, tags_json = ?,
              category = ?, params_json = ?, api_mode = ?, model = ?, cover_image_id = ?,
              linked_task_ids_json = ?, is_favorite = ?, version = version + 1, updated_at = ?
            WHERE id = ? AND user_id = ?
            """,
            (
                next_template.title,
                next_template.description,
                next_template.prompt,
                next_template.negativePrompt,
                json_dumps(next_template.tags),
                next_template.category,
                next_template.params.model_dump_json(),
                next_template.apiMode,
                next_template.model,
                next_template.coverImageId,
                json_dumps(next_template.linkedTaskIds),
                int(next_template.isFavorite),
                ts,
                template_id,
                user.id,
            ),
        )
        row = conn.execute("SELECT * FROM prompt_templates WHERE id = ? AND user_id = ?", (template_id, user.id)).fetchone()
    return row_to_template(row)


@app.delete("/api/templates/{template_id}")
def delete_template(template_id: str, user: UserOut = Depends(require_user)) -> dict[str, bool]:
    with get_conn() as conn:
        cur = conn.execute("DELETE FROM prompt_templates WHERE id = ? AND user_id = ?", (template_id, user.id))
    if cur.rowcount == 0:
        raise HTTPException(status_code=404, detail="Template not found")
    return {"ok": True}


@app.post("/api/templates/{template_id}/duplicate", response_model=PromptTemplateOut)
def duplicate_template(template_id: str, user: UserOut = Depends(require_user)) -> PromptTemplateOut:
    source = get_template_or_404(template_id, user.id)
    payload = PromptTemplateIn(
        title=f"{source.title} 副本",
        description=source.description,
        prompt=source.prompt,
        negativePrompt=source.negativePrompt,
        tags=source.tags,
        category=source.category,
        params=source.params,
        apiMode=source.apiMode,
        model=source.model,
        coverImageId=source.coverImageId,
        linkedTaskIds=[],
        isFavorite=False,
    )
    return create_template(payload, user)


@app.post("/api/templates/{template_id}/set-cover", response_model=PromptTemplateOut)
def set_template_cover(template_id: str, payload: SetCoverIn, user: UserOut = Depends(require_user)) -> PromptTemplateOut:
    get_template_or_404(template_id, user.id)
    with get_conn() as conn:
        asset = conn.execute(
            "SELECT id FROM assets WHERE id = ? AND user_id = ?",
            (payload.imageId, user.id),
        ).fetchone()
        if not asset:
            raise HTTPException(status_code=404, detail="Asset not found")
    return patch_template(template_id, PromptTemplatePatch(coverImageId=payload.imageId), user)


@app.get("/api/generations", response_model=list[GenerationTaskOut])
def list_generations(user: UserOut = Depends(require_user)) -> list[GenerationTaskOut]:
    with get_conn() as conn:
        rows = conn.execute(
            "SELECT * FROM generation_tasks WHERE user_id = ? ORDER BY created_at DESC",
            (user.id,),
        ).fetchall()
    return [row_to_task(row) for row in rows]


def insert_generation(payload: GenerationTaskIn, user_id: str) -> GenerationTaskOut:
    task_id = payload.id or new_id()
    created_at = payload.createdAt or now_ms()
    with get_conn() as conn:
        conn.execute(
            """
            INSERT OR REPLACE INTO generation_tasks (
              id, user_id, template_id, template_version_id, prompt, params_json,
              input_image_ids_json, output_image_ids_json, actual_params_json,
              actual_params_by_image_json, revised_prompt_by_image_json, status, error, created_at,
              finished_at, elapsed, is_favorite, api_mode, model
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            """,
            (
                task_id,
                user_id,
                payload.templateId,
                payload.templateVersionId,
                payload.prompt,
                payload.params.model_dump_json(),
                json_dumps(payload.inputImageIds),
                json_dumps(payload.outputImages),
                json_dumps(payload.actualParams) if payload.actualParams is not None else None,
                json_dumps(payload.actualParamsByImage) if payload.actualParamsByImage is not None else None,
                json_dumps(payload.revisedPromptByImage) if payload.revisedPromptByImage is not None else None,
                payload.status,
                payload.error,
                created_at,
                payload.finishedAt,
                payload.elapsed,
                int(payload.isFavorite),
                payload.apiMode,
                payload.model,
            ),
        )
        row = conn.execute("SELECT * FROM generation_tasks WHERE id = ? AND user_id = ?", (task_id, user_id)).fetchone()
    return row_to_task(row)


@app.post("/api/generations", response_model=GenerationTaskOut)
def create_generation(payload: GenerationTaskIn, user: UserOut = Depends(require_user)) -> GenerationTaskOut:
    return insert_generation(payload, user.id)


@app.get("/api/generations/{task_id}", response_model=GenerationTaskOut)
def get_generation(task_id: str, user: UserOut = Depends(require_user)) -> GenerationTaskOut:
    with get_conn() as conn:
        row = conn.execute(
            "SELECT * FROM generation_tasks WHERE id = ? AND user_id = ?",
            (task_id, user.id),
        ).fetchone()
    if not row:
        raise HTTPException(status_code=404, detail="Generation not found")
    return row_to_task(row)


@app.patch("/api/generations/{task_id}", response_model=GenerationTaskOut)
def patch_generation(task_id: str, payload: GenerationTaskPatch, user: UserOut = Depends(require_user)) -> GenerationTaskOut:
    existing = get_generation(task_id, user)
    data = payload.model_dump(exclude_unset=True)
    if not data:
        return existing
    next_task = GenerationTaskOut.model_validate({**existing.model_dump(), **data})
    with get_conn() as conn:
        conn.execute(
            """
            UPDATE generation_tasks SET
              template_id = ?, template_version_id = ?, prompt = ?, params_json = ?,
              input_image_ids_json = ?, output_image_ids_json = ?, actual_params_json = ?,
              actual_params_by_image_json = ?, revised_prompt_by_image_json = ?, status = ?, error = ?,
              finished_at = ?, elapsed = ?, is_favorite = ?
            WHERE id = ? AND user_id = ?
            """,
            (
                next_task.templateId,
                next_task.templateVersionId,
                next_task.prompt,
                next_task.params.model_dump_json(),
                json_dumps(next_task.inputImageIds),
                json_dumps(next_task.outputImages),
                json_dumps(next_task.actualParams) if next_task.actualParams is not None else None,
                json_dumps(next_task.actualParamsByImage) if next_task.actualParamsByImage is not None else None,
                json_dumps(next_task.revisedPromptByImage) if next_task.revisedPromptByImage is not None else None,
                next_task.status,
                next_task.error,
                next_task.finishedAt,
                next_task.elapsed,
                int(next_task.isFavorite),
                task_id,
                user.id,
            ),
        )
        row = conn.execute("SELECT * FROM generation_tasks WHERE id = ? AND user_id = ?", (task_id, user.id)).fetchone()
    return row_to_task(row)


@app.delete("/api/generations/{task_id}")
def delete_generation(task_id: str, user: UserOut = Depends(require_user)) -> dict[str, bool]:
    with get_conn() as conn:
        cur = conn.execute("DELETE FROM generation_tasks WHERE id = ? AND user_id = ?", (task_id, user.id))
    if cur.rowcount == 0:
        raise HTTPException(status_code=404, detail="Generation not found")
    return {"ok": True}


def asset_ext(mime: str) -> str:
    return {
        "image/png": ".png",
        "image/jpeg": ".jpg",
        "image/webp": ".webp",
    }.get(mime, mimetypes.guess_extension(mime) or ".bin")


def data_url_to_bytes(data_url: str) -> tuple[str, bytes]:
    match = re.match(r"^data:([^;,]+);base64,(.*)$", data_url, re.DOTALL)
    if not match:
        raise ValueError("Invalid data URL")
    mime = match.group(1)
    return mime, base64.b64decode(match.group(2))


def bytes_to_data_url(mime: str, data: bytes) -> str:
    return f"data:{mime};base64,{base64.b64encode(data).decode('ascii')}"


def inspect_image(data: bytes, mime: str) -> tuple[int | None, int | None, bytes | None, str]:
    if mime not in ALLOWED_IMAGE_MIMES:
        raise HTTPException(status_code=400, detail="Only PNG, JPEG, and WebP images are allowed")
    if len(data) > settings.max_upload_bytes:
        raise HTTPException(status_code=413, detail="Image is too large")

    try:
        with Image.open(io.BytesIO(data)) as image:
            detected_mime = Image.MIME.get(image.format or "", mime)
            if detected_mime not in ALLOWED_IMAGE_MIMES:
                raise HTTPException(status_code=400, detail="Only PNG, JPEG, and WebP images are allowed")
            width, height = image.size
            thumb = image.copy()
            thumb.thumbnail((settings.thumbnail_max_size, settings.thumbnail_max_size))
            output = io.BytesIO()
            thumb.convert("RGB" if thumb.mode not in ("RGB", "RGBA") else thumb.mode).save(output, format="WEBP", quality=82)
            return width, height, output.getvalue(), detected_mime
    except (UnidentifiedImageError, OSError) as exc:
        raise HTTPException(status_code=400, detail="Invalid image file") from exc


def save_asset_bytes(
    *,
    user_id: str,
    data: bytes,
    mime: str,
    asset_type: str,
    task_id: str | None = None,
    template_id: str | None = None,
) -> AssetOut:
    width, height, thumbnail_data, detected_mime = inspect_image(data, mime)
    asset_id = new_id()
    created_at = now_ms()
    user_dir = settings.asset_dir / user_id
    user_dir.mkdir(parents=True, exist_ok=True)
    path = user_dir / f"{asset_id}{asset_ext(detected_mime)}"
    thumbnail_path = user_dir / f"{asset_id}.thumb.webp"
    path.write_bytes(data)
    if thumbnail_data:
        thumbnail_path.write_bytes(thumbnail_data)

    with get_conn() as conn:
        conn.execute(
            """
            INSERT INTO assets (id, user_id, task_id, template_id, type, path, thumbnail_path, mime, width, height, size_bytes, created_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            """,
            (
                asset_id,
                user_id,
                task_id,
                template_id,
                asset_type,
                str(path),
                str(thumbnail_path) if thumbnail_data else None,
                detected_mime,
                width,
                height,
                len(data),
                created_at,
            ),
        )
        row = conn.execute("SELECT * FROM assets WHERE id = ? AND user_id = ?", (asset_id, user_id)).fetchone()
    return row_to_asset(row)


@app.post("/api/assets", response_model=AssetOut)
async def upload_asset(
    file: UploadFile = File(...),
    type: str = Form("upload"),
    taskId: str | None = Form(None),
    templateId: str | None = Form(None),
    user: UserOut = Depends(require_user),
) -> AssetOut:
    data = await file.read()
    mime = file.content_type or "application/octet-stream"
    return save_asset_bytes(user_id=user.id, data=data, mime=mime, asset_type=type, task_id=taskId, template_id=templateId)


@app.get("/api/assets/{asset_id}")
def get_asset(asset_id: str, user: UserOut = Depends(require_user)) -> FileResponse:
    with get_conn() as conn:
        row = conn.execute("SELECT * FROM assets WHERE id = ? AND user_id = ?", (asset_id, user.id)).fetchone()
    if not row:
        raise HTTPException(status_code=404, detail="Asset not found")
    return FileResponse(row["path"], media_type=row["mime"])


@app.get("/api/assets/{asset_id}/thumbnail")
def get_asset_thumbnail(asset_id: str, user: UserOut = Depends(require_user)) -> FileResponse:
    with get_conn() as conn:
        row = conn.execute("SELECT * FROM assets WHERE id = ? AND user_id = ?", (asset_id, user.id)).fetchone()
    if not row or not row["thumbnail_path"]:
        raise HTTPException(status_code=404, detail="Asset thumbnail not found")
    return FileResponse(row["thumbnail_path"], media_type="image/webp")


@app.delete("/api/assets/{asset_id}")
def delete_asset(asset_id: str, user: UserOut = Depends(require_user)) -> dict[str, bool]:
    with get_conn() as conn:
        row = conn.execute("SELECT * FROM assets WHERE id = ? AND user_id = ?", (asset_id, user.id)).fetchone()
        if not row:
            raise HTTPException(status_code=404, detail="Asset not found")
        conn.execute("DELETE FROM assets WHERE id = ? AND user_id = ?", (asset_id, user.id))

    path = Path(row["path"])
    if path.exists():
        path.unlink()
    thumbnail_path = Path(row["thumbnail_path"]) if row["thumbnail_path"] else None
    if thumbnail_path and thumbnail_path.exists():
        thumbnail_path.unlink()
    return {"ok": True}


def api_key_for_request(payload: GenerateIn) -> str:
    if settings.openai_api_key:
        return settings.openai_api_key
    if settings.allow_client_api_key and payload.settings.apiKey:
        return payload.settings.apiKey
    raise HTTPException(status_code=400, detail="Backend proxy API key is not configured")


def pick_actual_params(source: dict[str, Any]) -> dict[str, Any]:
    keys = ["size", "quality", "output_format", "output_compression", "moderation", "n"]
    return {key: source[key] for key in keys if key in source and source[key] is not None}


def normalize_base64_image(value: str, fallback_mime: str) -> str:
    return value if value.startswith("data:") else f"data:{fallback_mime};base64,{value}"


async def fetch_image_as_data_url(client: httpx.AsyncClient, url: str, fallback_mime: str) -> str:
    response = await client.get(url)
    response.raise_for_status()
    mime = response.headers.get("content-type", fallback_mime).split(";")[0]
    return bytes_to_data_url(mime, response.content)


async def call_upstream(payload: GenerateIn) -> tuple[list[str], dict[str, Any] | None, list[dict[str, Any] | None], list[str | None]]:
    api_key = api_key_for_request(payload)
    base_url = normalize_base_url(payload.settings.baseUrl)
    timeout = payload.settings.timeout or settings.request_timeout_seconds
    headers = {
        "Authorization": f"Bearer {api_key}",
        "Cache-Control": "no-store, no-cache, max-age=0",
        "Pragma": "no-cache",
    }
    fallback_mime = {
        "png": "image/png",
        "jpeg": "image/jpeg",
        "webp": "image/webp",
    }.get(payload.params.output_format, "image/png")

    async with httpx.AsyncClient(timeout=timeout) as client:
        if payload.settings.apiMode == "responses":
            body: dict[str, Any] = {
                "model": payload.settings.model,
                "input": {
                    "role": "user",
                    "content": [
                        {"type": "input_text", "text": f"Use the following text as the complete prompt. Do not rewrite it:\n{payload.prompt}"},
                        *[
                            {"type": "input_image", "image_url": data_url}
                            for data_url in payload.inputImageDataUrls
                        ],
                    ],
                }
                if payload.inputImageDataUrls
                else f"Use the following text as the complete prompt. Do not rewrite it:\n{payload.prompt}",
                "tools": [
                    {
                        "type": "image_generation",
                        "action": "edit" if payload.inputImageDataUrls else "generate",
                        "size": payload.params.size,
                        "output_format": payload.params.output_format,
                        **({} if payload.settings.codexCli else {"quality": payload.params.quality}),
                        **(
                            {"output_compression": payload.params.output_compression}
                            if payload.params.output_format != "png" and payload.params.output_compression is not None
                            else {}
                        ),
                        **({"input_image_mask": {"image_url": payload.maskDataUrl}} if payload.maskDataUrl else {}),
                    }
                ],
                "tool_choice": "required",
            }
            response = await client.post(endpoint_url(base_url, "responses"), headers={**headers, "Content-Type": "application/json"}, json=body)
            response.raise_for_status()
            data = response.json()
            results: list[str] = []
            actual_params_list: list[dict[str, Any] | None] = []
            revised_prompts: list[str | None] = []
            for item in data.get("output", []):
                if item.get("type") != "image_generation_call":
                    continue
                result = item.get("result")
                if isinstance(result, str) and result.strip():
                    results.append(normalize_base64_image(result, fallback_mime))
                    actual_params_list.append(pick_actual_params(item) or None)
                    revised_prompts.append(item.get("revised_prompt"))
            if not results:
                raise ValueError("接口未返回可用图片数据")
            return results, actual_params_list[0], actual_params_list, revised_prompts

        if payload.inputImageDataUrls:
            files: list[tuple[str, tuple[str, bytes, str]]] = []
            for index, data_url in enumerate(payload.inputImageDataUrls):
                mime, data = data_url_to_bytes(data_url)
                files.append(("image[]", (f"input-{index + 1}{asset_ext(mime)}", data, mime)))
            if payload.maskDataUrl:
                mask_mime, mask_data = data_url_to_bytes(payload.maskDataUrl)
                files.append(("mask", ("mask.png", mask_data, mask_mime)))
            form = {
                "model": payload.settings.model,
                "prompt": payload.prompt if not payload.settings.codexCli else f"Use the following text as the complete prompt. Do not rewrite it:\n{payload.prompt}",
                "size": payload.params.size,
                "output_format": payload.params.output_format,
                "moderation": payload.params.moderation,
            }
            if not payload.settings.codexCli:
                form["quality"] = payload.params.quality
            if payload.params.output_format != "png" and payload.params.output_compression is not None:
                form["output_compression"] = str(payload.params.output_compression)
            if payload.params.n > 1:
                form["n"] = str(payload.params.n)
            response = await client.post(endpoint_url(base_url, "images/edits"), headers=headers, data=form, files=files)
        else:
            body = {
                "model": payload.settings.model,
                "prompt": payload.prompt if not payload.settings.codexCli else f"Use the following text as the complete prompt. Do not rewrite it:\n{payload.prompt}",
                "size": payload.params.size,
                "output_format": payload.params.output_format,
                "moderation": payload.params.moderation,
            }
            if not payload.settings.codexCli:
                body["quality"] = payload.params.quality
            if payload.params.output_format != "png" and payload.params.output_compression is not None:
                body["output_compression"] = payload.params.output_compression
            if payload.params.n > 1:
                body["n"] = payload.params.n
            response = await client.post(endpoint_url(base_url, "images/generations"), headers={**headers, "Content-Type": "application/json"}, json=body)

        response.raise_for_status()
        data = response.json()
        images: list[str] = []
        revised_prompts: list[str | None] = []
        for item in data.get("data", []):
            if item.get("b64_json"):
                images.append(normalize_base64_image(item["b64_json"], fallback_mime))
                revised_prompts.append(item.get("revised_prompt"))
            elif item.get("url"):
                images.append(await fetch_image_as_data_url(client, item["url"], fallback_mime))
                revised_prompts.append(item.get("revised_prompt"))
        if not images:
            raise ValueError("接口未返回可用图片数据")
        actual_params = pick_actual_params(data) or None
        return images, actual_params, [actual_params for _ in images], revised_prompts


def map_actual_params_by_image(
    output_ids: list[str],
    actual_params_list: list[dict[str, Any] | None],
) -> dict[str, dict[str, Any]] | None:
    mapped = {
        output_ids[index]: params
        for index, params in enumerate(actual_params_list)
        if index < len(output_ids) and params
    }
    return mapped or None


def map_revised_prompts_by_image(output_ids: list[str], revised_prompts: list[str | None]) -> dict[str, str] | None:
    mapped = {
        output_ids[index]: prompt
        for index, prompt in enumerate(revised_prompts)
        if index < len(output_ids) and prompt
    }
    return mapped or None


async def complete_generation_task(payload: GenerateIn, user: UserOut, started_at: int) -> GenerateOut:
    task_id = payload.taskId or new_id()
    try:
        input_asset_ids: list[str] = []
        for data_url in payload.inputImageDataUrls:
            mime, data = data_url_to_bytes(data_url)
            asset = save_asset_bytes(
                user_id=user.id,
                data=data,
                mime=mime,
                asset_type="input",
                task_id=task_id,
                template_id=payload.templateId,
            )
            input_asset_ids.append(asset.id)
        if payload.maskDataUrl:
            mime, data = data_url_to_bytes(payload.maskDataUrl)
            save_asset_bytes(
                user_id=user.id,
                data=data,
                mime=mime,
                asset_type="mask",
                task_id=task_id,
                template_id=payload.templateId,
            )
        if input_asset_ids:
            patch_generation(task_id, GenerationTaskPatch(inputImageIds=input_asset_ids), user)

        images, actual_params, actual_params_list, revised_prompts = await call_upstream(payload)
        output_assets: list[AssetOut] = []
        for data_url in images:
            mime, data = data_url_to_bytes(data_url)
            output_assets.append(
                save_asset_bytes(
                    user_id=user.id,
                    data=data,
                    mime=mime,
                    asset_type="generated",
                    task_id=task_id,
                    template_id=payload.templateId,
                )
            )
        output_ids = [asset.id for asset in output_assets]
        finished_at = now_ms()
        task = patch_generation(
            task_id,
            GenerationTaskPatch(
                outputImages=output_ids,
                actualParams={**actual_params, "n": len(output_ids)} if actual_params else {"n": len(output_ids)},
                actualParamsByImage=map_actual_params_by_image(output_ids, actual_params_list),
                revisedPromptByImage=map_revised_prompts_by_image(output_ids, revised_prompts),
                status="done",
                finishedAt=finished_at,
                elapsed=finished_at - started_at,
            ),
            user,
        )
        return GenerateOut(
            task=task,
            images=images,
            outputAssets=output_assets,
            actualParams=actual_params,
            actualParamsList=actual_params_list,
            revisedPrompts=revised_prompts,
        )
    except (httpx.HTTPError, ValueError, ValidationError, HTTPException) as exc:
        finished_at = now_ms()
        patch_generation(
            task_id,
            GenerationTaskPatch(status="error", error=str(exc), finishedAt=finished_at, elapsed=finished_at - started_at),
            user,
        )
        raise


async def complete_generation_task_safely(payload: GenerateIn, user: UserOut, started_at: int) -> None:
    try:
        await complete_generation_task(payload, user, started_at)
    except Exception as exc:
        if payload.taskId:
            finished_at = now_ms()
            patch_generation(
                payload.taskId,
                GenerationTaskPatch(status="error", error=str(exc), finishedAt=finished_at, elapsed=finished_at - started_at),
                user,
            )
        return


@app.post("/api/generations/run", response_model=GenerateRunOut)
async def run_generation(payload: GenerateIn, background_tasks: BackgroundTasks, user: UserOut = Depends(require_user)) -> GenerateRunOut:
    task_id = payload.taskId or new_id()
    payload = payload.model_copy(update={"taskId": task_id})
    started_at = now_ms()
    task = insert_generation(
        GenerationTaskIn(
            id=task_id,
            templateId=payload.templateId,
            templateVersionId=payload.templateVersionId,
            prompt=payload.prompt,
            params=payload.params,
            inputImageIds=[],
            outputImages=[],
            status="running",
            createdAt=started_at,
            apiMode=payload.settings.apiMode,
            model=payload.settings.model,
        ),
        user.id,
    )
    background_tasks.add_task(complete_generation_task_safely, payload, user, started_at)
    return GenerateRunOut(task=task)


@app.post("/api/generate", response_model=GenerateOut)
async def generate(payload: GenerateIn, user: UserOut = Depends(require_user)) -> GenerateOut:
    task_id = payload.taskId or new_id()
    payload = payload.model_copy(update={"taskId": task_id})
    started_at = now_ms()
    insert_generation(
        GenerationTaskIn(
            id=task_id,
            templateId=payload.templateId,
            templateVersionId=payload.templateVersionId,
            prompt=payload.prompt,
            params=payload.params,
            inputImageIds=[],
            outputImages=[],
            status="running",
            createdAt=started_at,
            apiMode=payload.settings.apiMode,
            model=payload.settings.model,
        ),
        user.id,
    )
    try:
        return await complete_generation_task(payload, user, started_at)
    except (httpx.HTTPError, ValueError, ValidationError, HTTPException) as exc:
        raise HTTPException(status_code=502, detail=str(exc)) from exc
