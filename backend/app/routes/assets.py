from __future__ import annotations

from pathlib import Path

from fastapi import APIRouter, Depends, File, Form, HTTPException, UploadFile
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
from ..db import get_conn
from ..dependencies import require_user
from ..schemas import AssetOut, UserOut

router = APIRouter(prefix="/api/assets", tags=["assets"])


@router.post("", response_model=AssetOut)
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
