from __future__ import annotations

import base64
import io
import json
import mimetypes
import re
import sys
from pathlib import Path
from typing import Any

from fastapi import HTTPException
from PIL import Image, UnidentifiedImageError

from .config import settings
from .db import get_conn
from .schemas import AssetOut, GenerateIn, TaskParams, UserOut
from .security import new_id, now_ms

ALLOWED_IMAGE_MIMES = {"image/png", "image/jpeg", "image/webp"}


def json_loads(value: str | None, fallback: Any) -> Any:
    if not value:
        return fallback
    try:
        return json.loads(value)
    except json.JSONDecodeError:
        return fallback


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
        visualHash=row["visual_hash"] if "visual_hash" in row.keys() else None,
        createdAt=row["created_at"],
    )


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


def compute_visual_hash(image: Image.Image) -> str:
    reduced = image.convert("L").resize((8, 8))
    pixels = list(reduced.tobytes())
    avg = sum(pixels) / max(1, len(pixels))
    bits = "".join("1" if pixel >= avg else "0" for pixel in pixels)
    return f"{int(bits, 2):016x}"


def inspect_image(data: bytes, mime: str) -> tuple[int | None, int | None, bytes | None, str, str]:
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
            thumb.convert("RGB" if thumb.mode not in ("RGB", "RGBA") else thumb.mode).save(
                output,
                format="WEBP",
                quality=82,
            )
            visual_hash = compute_visual_hash(image)
            return width, height, output.getvalue(), detected_mime, visual_hash
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
    width, height, thumbnail_data, detected_mime, visual_hash = inspect_image(data, mime)
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
            INSERT INTO assets (id, user_id, task_id, template_id, type, path, thumbnail_path, mime, width, height, size_bytes, visual_hash, created_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
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
                visual_hash,
                created_at,
            ),
        )
        row = conn.execute("SELECT * FROM assets WHERE id = ? AND user_id = ?", (asset_id, user_id)).fetchone()
    return row_to_asset(row)


def persist_generation_inputs(payload: GenerateIn, user: UserOut) -> tuple[list[str], str | None, str | None]:
    input_asset_ids: list[str] = []
    for data_url in payload.inputImageDataUrls:
        mime, data = data_url_to_bytes(data_url)
        asset = save_asset_bytes(
            user_id=user.id,
            data=data,
            mime=mime,
            asset_type="input",
            task_id=payload.taskId,
            template_id=payload.templateId,
        )
        input_asset_ids.append(asset.id)

    mask_asset_id: str | None = None
    mask_target_image_id: str | None = None
    if payload.maskDataUrl:
        mime, data = data_url_to_bytes(payload.maskDataUrl)
        asset = save_asset_bytes(
            user_id=user.id,
            data=data,
            mime=mime,
            asset_type="mask",
            task_id=payload.taskId,
            template_id=payload.templateId,
        )
        mask_asset_id = asset.id
        mask_target_image_id = input_asset_ids[0] if input_asset_ids else None

    return input_asset_ids, mask_target_image_id, mask_asset_id


def attach_assets_to_task(*, user_id: str, task_id: str, asset_ids: list[str]) -> None:
    attached_ids = [asset_id for asset_id in asset_ids if asset_id]
    if not attached_ids:
        return
    placeholders = ",".join("?" for _ in attached_ids)
    with get_conn() as conn:
        conn.execute(
            f"UPDATE assets SET task_id = ? WHERE user_id = ? AND id IN ({placeholders})",
            (task_id, user_id, *attached_ids),
        )


def delete_asset_files(row: Any) -> None:
    path = Path(row["path"])
    if path.exists():
        path.unlink()
    thumbnail_path = Path(row["thumbnail_path"]) if row["thumbnail_path"] else None
    if thumbnail_path and thumbnail_path.exists():
        thumbnail_path.unlink()


def read_asset_row_or_404(conn: Any, asset_id: str, user_id: str) -> Any:
    row = conn.execute(
        "SELECT * FROM assets WHERE id = ? AND user_id = ?",
        (asset_id, user_id),
    ).fetchone()
    if not row:
        raise HTTPException(status_code=404, detail="Generation asset not found")
    return row


def generation_payload_from_row(row: Any, user: UserOut) -> GenerateIn:
    input_image_ids = json_loads(row["input_image_ids_json"], [])
    input_rows: dict[str, Any] = {}
    mask_row: Any | None = None
    with get_conn() as conn:
        for asset_id in input_image_ids:
            asset_row = read_asset_row_or_404(conn, str(asset_id), user.id)
            input_rows[str(asset_id)] = asset_row
        if row["mask_image_id"]:
            mask_row = read_asset_row_or_404(conn, row["mask_image_id"], user.id)

    input_data_urls = [
        bytes_to_data_url(input_rows[asset_id]["mime"], Path(input_rows[asset_id]["path"]).read_bytes())
        for asset_id in input_image_ids
        if asset_id in input_rows
    ]
    mask_data_url = bytes_to_data_url(mask_row["mime"], Path(mask_row["path"]).read_bytes()) if mask_row else None
    return GenerateIn(
        taskId=row["id"],
        templateId=row["template_id"],
        templateVersionId=row["template_version_id"],
        projectId=row["project_id"] if "project_id" in row.keys() else None,
        parentTaskId=row["parent_task_id"] if "parent_task_id" in row.keys() else None,
        experimentId=row["experiment_id"] if "experiment_id" in row.keys() else None,
        variationLabel=row["variation_label"] if "variation_label" in row.keys() else None,
        prompt=row["prompt"],
        params=TaskParams.model_validate(json_loads(row["params_json"], {})),
        inputImageDataUrls=input_data_urls,
        maskDataUrl=mask_data_url,
        channelId=row["channel_id"],
        model=row["model"],
    )


def asset_is_publicly_visible(conn: Any, row: Any) -> bool:
    if row["template_id"] and row["type"] == "generated":
        public_template = conn.execute(
            """
            SELECT 1 FROM prompt_templates
            WHERE id = ? AND visibility = 'public' AND submission_status = 'approved'
            """,
            (row["template_id"],),
        ).fetchone()
        if public_template:
            return True
    public_cover = conn.execute(
        """
        SELECT 1 FROM prompt_templates
        WHERE cover_image_id = ? AND visibility = 'public' AND submission_status = 'approved'
        """,
        (row["id"],),
    ).fetchone()
    return bool(public_cover)


class SystemClipboardError(RuntimeError):
    pass


def copy_image_file_to_system_clipboard(path: Path) -> None:
    if sys.platform != "win32":
        raise SystemClipboardError("System image clipboard is only supported on Windows")

    import ctypes

    with Image.open(path) as image:
        output = io.BytesIO()
        image.convert("RGB").save(output, "BMP")
        dib_data = output.getvalue()[14:]

    user32 = ctypes.windll.user32
    kernel32 = ctypes.windll.kernel32
    cf_dib = 8
    gmem_moveable = 0x0002

    user32.OpenClipboard.argtypes = [ctypes.c_void_p]
    user32.OpenClipboard.restype = ctypes.c_bool
    user32.EmptyClipboard.argtypes = []
    user32.EmptyClipboard.restype = ctypes.c_bool
    user32.SetClipboardData.argtypes = [ctypes.c_uint, ctypes.c_void_p]
    user32.SetClipboardData.restype = ctypes.c_void_p
    user32.CloseClipboard.argtypes = []
    user32.CloseClipboard.restype = ctypes.c_bool
    kernel32.GlobalAlloc.argtypes = [ctypes.c_uint, ctypes.c_size_t]
    kernel32.GlobalAlloc.restype = ctypes.c_void_p
    kernel32.GlobalLock.argtypes = [ctypes.c_void_p]
    kernel32.GlobalLock.restype = ctypes.c_void_p
    kernel32.GlobalUnlock.argtypes = [ctypes.c_void_p]
    kernel32.GlobalUnlock.restype = ctypes.c_bool
    kernel32.GlobalFree.argtypes = [ctypes.c_void_p]
    kernel32.GlobalFree.restype = ctypes.c_void_p

    if not user32.OpenClipboard(None):
        raise SystemClipboardError("Failed to open system clipboard")

    handle = None
    clipboard_owns_handle = False
    try:
        if not user32.EmptyClipboard():
            raise SystemClipboardError("Failed to empty system clipboard")

        handle = kernel32.GlobalAlloc(gmem_moveable, len(dib_data))
        if not handle:
            raise SystemClipboardError("Failed to allocate clipboard memory")

        locked = kernel32.GlobalLock(handle)
        if not locked:
            raise SystemClipboardError("Failed to lock clipboard memory")
        try:
            ctypes.memmove(locked, dib_data, len(dib_data))
        finally:
            kernel32.GlobalUnlock(handle)

        if not user32.SetClipboardData(cf_dib, handle):
            raise SystemClipboardError("Failed to set clipboard image data")
        clipboard_owns_handle = True
    finally:
        user32.CloseClipboard()
        if handle and not clipboard_owns_handle:
            kernel32.GlobalFree(handle)
