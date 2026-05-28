from __future__ import annotations

from pathlib import Path

from fastapi import APIRouter, Depends, File, Form, HTTPException, Query, UploadFile
from fastapi.responses import FileResponse
from PIL import UnidentifiedImageError

from ..assets import (
    ALLOWED_IMAGE_MIMES,
    SystemClipboardError,
    asset_is_publicly_visible,
    copy_image_file_to_system_clipboard,
    delete_asset_files,
    save_asset_bytes,
)
from ..config import settings
from ..db import get_conn
from ..dependencies import require_template_operator, require_user
from ..helpers import json_loads
from ..remote_image_cache import (
    REMOTE_IMAGE_PRIVATE_CACHE_CONTROL,
    REMOTE_IMAGE_PUBLIC_CACHE_CONTROL,
    get_cached_remote_image,
    verify_open_prompt_cache_url,
)
from ..schemas import AssetOut, UserOut
from .open_prompt_parsers import OPEN_PROMPT_SOURCES

router = APIRouter(prefix="/api/assets", tags=["assets"])


@router.get("/remote-cache/templates/{template_id}")
async def get_template_remote_image(
    template_id: str,
    url: str = Query(...),
    user: UserOut = Depends(require_user),
) -> FileResponse:
    with get_conn() as conn:
        row = conn.execute("SELECT * FROM prompt_templates WHERE id = ?", (template_id,)).fetchone()
        if not row:
            raise HTTPException(status_code=404, detail="Remote image not found")
        if not _can_read_template_remote_images(row, user):
            raise HTTPException(status_code=404, detail="Remote image not found")
        allowed_urls = _template_remote_image_urls(row)
        cache_control = _template_remote_image_cache_control(row)
    if url not in allowed_urls:
        raise HTTPException(status_code=404, detail="Remote image not found")
    return await get_cached_remote_image(url, cache_control=cache_control)


@router.get("/remote-cache/open-prompt/{source}/{key}")
async def get_open_prompt_remote_image(
    source: str,
    key: str,
    url: str = Query(...),
    sig: str = Query(...),
    user: UserOut = Depends(require_template_operator),
) -> FileResponse:
    del user
    if source not in OPEN_PROMPT_SOURCES or not verify_open_prompt_cache_url(source, key, url, sig):
        raise HTTPException(status_code=404, detail="Remote image not found")
    return await get_cached_remote_image(url)


def _can_read_template_remote_images(row, user: UserOut) -> bool:
    return (
        row["user_id"] == user.id
        or user.role == "admin"
        or (user.role == "reviewer" and row["submission_status"] == "submitted")
        or (row["visibility"] == "public" and row["submission_status"] == "approved")
    )


def _template_remote_image_cache_control(row) -> str:
    if row["visibility"] == "public" and row["submission_status"] == "approved":
        return REMOTE_IMAGE_PUBLIC_CACHE_CONTROL
    return REMOTE_IMAGE_PRIVATE_CACHE_CONTROL


def _template_remote_image_urls(row) -> set[str]:
    urls = {str(row["external_cover_url"] or "").strip()}
    urls.update(str(url).strip() for url in json_loads(row["example_images_json"], []))
    return {url for url in urls if url}


@router.post("", response_model=AssetOut)
async def upload_asset(
    file: UploadFile = File(...),
    type: str = Form("upload"),
    taskId: str | None = Form(None),
    templateId: str | None = Form(None),
    user: UserOut = Depends(require_user),
) -> AssetOut:
    if file.size and file.size > settings.max_upload_bytes:
        raise HTTPException(status_code=413, detail="文件过大")
    data = await file.read()
    if len(data) > settings.max_upload_bytes:
        raise HTTPException(status_code=413, detail="文件过大")
    if type != "upload" or taskId or templateId:
        raise HTTPException(status_code=400, detail="Unsupported asset upload metadata")
    mime = file.content_type or "application/octet-stream"
    return save_asset_bytes(user_id=user.id, data=data, mime=mime, asset_type="upload")


@router.get("/{asset_id}")
def get_asset(asset_id: str, user: UserOut = Depends(require_user)) -> FileResponse:
    with get_conn() as conn:
        row = conn.execute("SELECT * FROM assets WHERE id = ?", (asset_id,)).fetchone()
        if not row:
            raise HTTPException(status_code=404, detail="Asset not found")
        if row["user_id"] != user.id and not asset_is_publicly_visible(conn, row):
            raise HTTPException(status_code=404, detail="Asset not found")
    if not row:
        raise HTTPException(status_code=404, detail="Asset not found")
    return FileResponse(row["path"], media_type=row["mime"])


@router.get("/{asset_id}/thumbnail")
def get_asset_thumbnail(asset_id: str, user: UserOut = Depends(require_user)) -> FileResponse:
    with get_conn() as conn:
        row = conn.execute("SELECT * FROM assets WHERE id = ?", (asset_id,)).fetchone()
        if not row:
            raise HTTPException(status_code=404, detail="Asset thumbnail not found")
        if row["user_id"] != user.id and not asset_is_publicly_visible(conn, row):
            raise HTTPException(status_code=404, detail="Asset thumbnail not found")
    if not row or not row["thumbnail_path"]:
        raise HTTPException(status_code=404, detail="Asset thumbnail not found")
    return FileResponse(row["thumbnail_path"], media_type="image/webp")


@router.post("/{asset_id}/copy-to-clipboard")
def copy_asset_to_system_clipboard(asset_id: str, user: UserOut = Depends(require_user)) -> dict[str, bool | str]:
    with get_conn() as conn:
        row = conn.execute("SELECT * FROM assets WHERE id = ?", (asset_id,)).fetchone()
        if not row:
            raise HTTPException(status_code=404, detail="Asset not found")
        if row["user_id"] != user.id and not asset_is_publicly_visible(conn, row):
            raise HTTPException(status_code=404, detail="Asset not found")

    if row["mime"] not in ALLOWED_IMAGE_MIMES:
        raise HTTPException(status_code=400, detail="Asset is not a supported image")

    try:
        copy_image_file_to_system_clipboard(Path(row["path"]))
    except SystemClipboardError as exc:
        raise HTTPException(status_code=501, detail=str(exc)) from exc
    except (OSError, UnidentifiedImageError) as exc:
        raise HTTPException(status_code=500, detail="Failed to copy image to system clipboard") from exc

    return {"ok": True, "method": "system"}


@router.delete("/{asset_id}")
def delete_asset(asset_id: str, user: UserOut = Depends(require_user)) -> dict[str, bool]:
    with get_conn() as conn:
        row = conn.execute("SELECT * FROM assets WHERE id = ? AND user_id = ?", (asset_id, user.id)).fetchone()
        if not row:
            raise HTTPException(status_code=404, detail="Asset not found")
        conn.execute("DELETE FROM assets WHERE id = ? AND user_id = ?", (asset_id, user.id))

    delete_asset_files(row)
    return {"ok": True}
