from __future__ import annotations

import base64
import json
import mimetypes
import re
from contextlib import asynccontextmanager
from pathlib import Path
from typing import Any
from urllib.parse import urljoin

import httpx
from fastapi import Depends, FastAPI, File, Form, HTTPException, Request, Response, UploadFile
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse
from pydantic import ValidationError

from .config import settings
from .db import get_conn, init_db
from .schemas import (
    AssetOut,
    AuthIn,
    GenerateIn,
    GenerateOut,
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

@asynccontextmanager
async def lifespan(_: FastAPI):
    init_db()
    yield


app = FastAPI(title="GPT Image Playground API", lifespan=lifespan)

app.add_middleware(
    CORSMiddleware,
    allow_origins=["http://127.0.0.1:5173", "http://localhost:5173"],
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
        createdAt=row["created_at"],
    )


def require_user(request: Request) -> UserOut:
    token = request.cookies.get(settings.session_cookie_name)
    if not token:
        raise HTTPException(status_code=401, detail="Not authenticated")

    with get_conn() as conn:
        row = conn.execute(
            """
            SELECT users.* FROM sessions
            JOIN users ON users.id = sessions.user_id
            WHERE sessions.id = ?
            """,
            (token,),
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
        path="/",
    )


@app.post("/api/auth/register", response_model=UserOut)
def register(payload: AuthIn, response: Response) -> UserOut:
    username = payload.username.strip()
    if not username:
        raise HTTPException(status_code=400, detail="Username is required")

    user_id = new_id()
    ts = now_ms()
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
                "INSERT INTO sessions (id, user_id, created_at, expires_at) VALUES (?, ?, ?, NULL)",
                (token, user_id, ts),
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
    with get_conn() as conn:
        row = conn.execute("SELECT * FROM users WHERE username = ?", (username,)).fetchone()
        if not row or not verify_password(payload.password, row["password_hash"]):
            raise HTTPException(status_code=401, detail="Invalid username or password")

        token = create_session_token()
        conn.execute(
            "INSERT INTO sessions (id, user_id, created_at, expires_at) VALUES (?, ?, ?, NULL)",
            (token, row["id"], now_ms()),
        )

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
              input_image_ids_json, output_image_ids_json, status, error, created_at,
              finished_at, elapsed, is_favorite, api_mode, model
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
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
              input_image_ids_json = ?, output_image_ids_json = ?, status = ?, error = ?,
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


def save_asset_bytes(
    *,
    user_id: str,
    data: bytes,
    mime: str,
    asset_type: str,
    task_id: str | None = None,
    template_id: str | None = None,
) -> AssetOut:
    asset_id = new_id()
    created_at = now_ms()
    user_dir = settings.asset_dir / user_id
    user_dir.mkdir(parents=True, exist_ok=True)
    path = user_dir / f"{asset_id}{asset_ext(mime)}"
    path.write_bytes(data)

    with get_conn() as conn:
        conn.execute(
            """
            INSERT INTO assets (id, user_id, task_id, template_id, type, path, mime, width, height, size_bytes, created_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, NULL, NULL, ?, ?)
            """,
            (asset_id, user_id, task_id, template_id, asset_type, str(path), mime, len(data), created_at),
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


@app.post("/api/generate", response_model=GenerateOut)
async def generate(payload: GenerateIn, user: UserOut = Depends(require_user)) -> GenerateOut:
    task_id = payload.taskId or new_id()
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

    try:
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
    except (httpx.HTTPError, ValueError, ValidationError) as exc:
        finished_at = now_ms()
        patch_generation(
            task_id,
            GenerationTaskPatch(status="error", error=str(exc), finishedAt=finished_at, elapsed=finished_at - started_at),
            user,
        )
        raise HTTPException(status_code=502, detail=str(exc)) from exc
