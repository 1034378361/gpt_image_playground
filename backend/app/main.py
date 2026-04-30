from __future__ import annotations

import asyncio
import hashlib
import io
import json
import re
import shutil
import time
import zipfile
from collections import defaultdict, deque
from contextlib import asynccontextmanager
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Callable
from urllib.parse import quote_plus, urljoin, urlparse

import httpx
from fastapi import Body, Depends, FastAPI, File, Form, HTTPException, Query, Request, Response, UploadFile
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse, StreamingResponse
from PIL import UnidentifiedImageError
from pydantic import ValidationError

from .assets import (
    ALLOWED_IMAGE_MIMES,
    SystemClipboardError,
    attach_assets_to_task,
    asset_ext,
    asset_is_publicly_visible,
    bytes_to_data_url,
    copy_image_file_to_system_clipboard,
    data_url_to_bytes,
    delete_asset_files,
    generation_payload_from_row,
    persist_generation_inputs,
    row_to_asset,
    save_asset_bytes,
)
from .config import settings
from .db import get_conn, init_db
from .generation_runtime import GenerationExecution, GenerationRuntime
from .schemas import (
    AdminApiChannelOut,
    ApiChannelIn,
    ApiChannelOut,
    ApiChannelPatch,
    AssetOut,
    AutoImportRunOut,
    AutoImportSettingsOut,
    AutoImportSettingsPatch,
    AuditLogOut,
    AuthIn,
    ChannelCompatibilityStatus,
    ChannelModel,
    ChannelHealthStatus,
    CodexCliMode,
    GenerateIn,
    GenerateOut,
    GenerateRunOut,
    GenerationDiagnosticOut,
    GenerationQueueStatsOut,
    GenerationPreflightIn,
    GenerationPreflightOut,
    GenerationTaskIn,
    GenerationTaskOut,
    GenerationTaskPatch,
    OpenPromptImportIn,
    OpenPromptDiscoveryOut,
    OpenPromptPreviewItemOut,
    OpenPromptPreviewOut,
    OpenPromptSourceOut,
    ChannelLeaderboardOut,
    PromptOptimizeIn,
    PromptOptimizeOut,
    PromptTemplateIn,
    PromptTemplateOut,
    PromptTemplatePatch,
    ProjectBoardIn,
    ProjectBoardOut,
    ProjectBoardPatch,
    RateTemplateIn,
    RejectTemplateIn,
    SetCoverIn,
    SystemBackupImportOut,
    SystemBackupPreviewOut,
    TaskParams,
    TemplatePackImportIn,
    TemplatePackImportOut,
    TemplateSampleOut,
    TemplateVersionOut,
    UserRolePatchIn,
    UserOut,
)
from .security import create_session_token, hash_password, new_id, now_ms, verify_password

LOGIN_ATTEMPTS: dict[str, deque[int]] = defaultdict(deque)
ACTIVE_TASK_STATUSES = {"queued", "running"}
FINAL_TASK_STATUSES = {"done", "error", "canceled"}


@dataclass(frozen=True)
class OpenPromptSource:
    id: str
    label: str
    readme_url: str
    repo_url: str
    raw_base_url: str
    source_name: str
    license_name: str
    parser: Callable[["OpenPromptSource", str], list[dict[str, str | list[str]]]]

AUTO_IMPORT_WORKER_TASKS: set[asyncio.Task[None]] = set()
AUTO_IMPORT_LOCK = asyncio.Lock()

DEFAULT_AUTO_IMPORT_SETTINGS: dict[str, Any] = {
    "enabled": False,
    "runHour": 3,
    "searchQueries": [
        "gpt image prompts",
        "gpt-image-2 prompts",
        "gpt4o image prompts",
        "image generation prompts",
    ],
    "trustedRepos": [],
    "includeKnownSources": True,
    "autoApproveTrusted": False,
    "maxRepositories": 12,
    "maxTemplatesPerRun": 80,
    "minHotScore": 20.0,
}
GENERATION_RUNTIME: GenerationRuntime


@asynccontextmanager
async def lifespan(_: FastAPI):
    init_db()
    recover_pending_generation_tasks()
    ensure_generation_workers()
    await enqueue_pending_generation_tasks()
    ensure_auto_import_worker()
    try:
        yield
    finally:
        for task in list(AUTO_IMPORT_WORKER_TASKS):
            task.cancel()
        await GENERATION_RUNTIME.shutdown()
        if AUTO_IMPORT_WORKER_TASKS:
            await asyncio.gather(*AUTO_IMPORT_WORKER_TASKS, return_exceptions=True)


app = FastAPI(title="GPT Image Playground API", lifespan=lifespan)

app.add_middleware(
    CORSMiddleware,
    allow_origins=settings.cors_origins,
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)


@app.get("/api/health")
def healthcheck() -> dict[str, bool]:
    return {"ok": True}


def json_dumps(value: Any) -> str:
    return json.dumps(value, ensure_ascii=False, separators=(",", ":"))


def json_loads(value: str | None, fallback: Any) -> Any:
    if not value:
        return fallback
    try:
        return json.loads(value)
    except json.JSONDecodeError:
        return fallback


SERVER_BACKUP_TABLES = [
    "users",
    "projects",
    "prompt_templates",
    "prompt_template_versions",
    "template_ratings",
    "api_channels",
    "generation_tasks",
    "assets",
    "audit_logs",
    "auto_import_settings",
    "open_prompt_discoveries",
    "auto_import_runs",
]


def get_frontend_index_path() -> Path | None:
    dist_dir = settings.frontend_dist_dir
    index_path = dist_dir / "index.html"
    return index_path if dist_dir.is_dir() and index_path.is_file() else None


def resolve_frontend_file(relative_path: str) -> Path | None:
    index_path = get_frontend_index_path()
    if index_path is None:
        return None
    dist_dir = settings.frontend_dist_dir.resolve()
    requested = (dist_dir / relative_path.lstrip("/")).resolve()
    try:
        requested.relative_to(dist_dir)
    except ValueError:
        return None
    return requested if requested.is_file() else None


def row_to_plain_dict(row: Any) -> dict[str, Any]:
    return {key: row[key] for key in row.keys()}


def build_server_backup_archive() -> bytes:
    exported_at = now_ms()
    with get_conn() as conn:
        tables = {
            table: [row_to_plain_dict(row) for row in conn.execute(f"SELECT * FROM {table}").fetchall()]
            for table in SERVER_BACKUP_TABLES
        }

    image_files: dict[str, dict[str, Any]] = {}
    zip_buffer = io.BytesIO()
    with zipfile.ZipFile(zip_buffer, mode="w", compression=zipfile.ZIP_DEFLATED) as archive:
        for asset in tables["assets"]:
            asset_id = str(asset["id"])
            asset_path = Path(str(asset["path"]))
            if not asset_path.exists():
                continue
            asset_rel_path = f"assets/{asset['user_id']}/{asset_path.name}"
            archive.write(asset_path, asset_rel_path)
            thumbnail_rel_path: str | None = None
            thumbnail_path = Path(str(asset["thumbnail_path"])) if asset.get("thumbnail_path") else None
            if thumbnail_path and thumbnail_path.exists():
                thumbnail_rel_path = f"assets/{asset['user_id']}/{thumbnail_path.name}"
                archive.write(thumbnail_path, thumbnail_rel_path)
            image_files[asset_id] = {
                "path": asset_rel_path,
                "thumbnailPath": thumbnail_rel_path,
            }

        manifest = {
            "version": 1,
            "exportedAt": exported_at,
            "tables": tables,
            "imageFiles": image_files,
        }
        archive.writestr("server-backup.json", json.dumps(manifest, ensure_ascii=False, indent=2))
    return zip_buffer.getvalue()


def parse_server_backup_manifest(archive_bytes: bytes) -> tuple[dict[str, Any], dict[str, list[dict[str, Any]]], dict[str, Any]]:
    with zipfile.ZipFile(io.BytesIO(archive_bytes), mode="r") as archive:
        try:
            manifest = json.loads(archive.read("server-backup.json").decode("utf-8"))
        except KeyError as exc:
            raise HTTPException(status_code=400, detail="备份文件缺少 server-backup.json") from exc
        except json.JSONDecodeError as exc:
            raise HTTPException(status_code=400, detail="备份清单格式无效") from exc

        tables = manifest.get("tables")
        if not isinstance(tables, dict):
            raise HTTPException(status_code=400, detail="备份清单缺少 tables")
        image_files = manifest.get("imageFiles") or {}
        if not isinstance(image_files, dict):
            raise HTTPException(status_code=400, detail="备份清单中的 imageFiles 无效")

        users = [dict(item) for item in tables.get("users") or [] if isinstance(item, dict)]
        if not users:
            raise HTTPException(status_code=400, detail="备份中没有用户数据，无法恢复")
        if not any(str(item.get("role")) == "admin" for item in users):
            users[0]["role"] = "admin"
            users[0]["updated_at"] = now_ms()
        tables["users"] = users

        return manifest, tables, image_files


def build_server_backup_preview(archive_bytes: bytes) -> SystemBackupPreviewOut:
    manifest, tables, image_files = parse_server_backup_manifest(archive_bytes)
    table_counts = {
        table_name: len(rows) for table_name, rows in tables.items() if isinstance(rows, list)
    }
    return SystemBackupPreviewOut(
        version=int(manifest.get("version") or 1),
        exportedAt=manifest.get("exportedAt"),
        tableCounts=table_counts,
        assetFileCount=len(image_files),
        hasAdminUser=any(str(row.get("role")) == "admin" for row in tables.get("users", [])),
        totalRecords=sum(table_counts.values()),
    )


def create_restore_point() -> str:
    settings.restore_point_dir.mkdir(parents=True, exist_ok=True)
    filename = f"restore-{time.strftime('%Y%m%d-%H%M%S')}.zip"
    restore_path = settings.restore_point_dir / filename
    restore_path.write_bytes(build_server_backup_archive())

    restore_points = sorted(
        settings.restore_point_dir.glob("restore-*.zip"),
        key=lambda item: item.stat().st_mtime,
        reverse=True,
    )
    for stale_path in restore_points[settings.restore_point_retention :]:
        try:
            stale_path.unlink()
        except OSError:
            pass
    return filename


def restore_server_backup_archive(archive_bytes: bytes, response: Response, actor: UserOut) -> None:
    with zipfile.ZipFile(io.BytesIO(archive_bytes), mode="r") as archive:
        _, tables, image_files = parse_server_backup_manifest(archive_bytes)

        if settings.asset_dir.exists():
            shutil.rmtree(settings.asset_dir)
        settings.asset_dir.mkdir(parents=True, exist_ok=True)

        for asset in tables.get("assets") or []:
            if not isinstance(asset, dict):
                continue
            asset_id = str(asset.get("id") or "")
            if not asset_id:
                continue
            file_info = image_files.get(asset_id)
            if not isinstance(file_info, dict):
                raise HTTPException(status_code=400, detail=f"备份中缺少资源文件映射：{asset_id}")
            file_path = str(file_info.get("path") or "")
            if not file_path:
                raise HTTPException(status_code=400, detail=f"备份中缺少资源文件：{asset_id}")
            target_dir = settings.asset_dir / str(asset["user_id"])
            target_dir.mkdir(parents=True, exist_ok=True)
            target_path = target_dir / Path(file_path).name
            try:
                target_path.write_bytes(archive.read(file_path))
            except KeyError as exc:
                raise HTTPException(status_code=400, detail=f"备份中找不到资源文件：{file_path}") from exc
            asset["path"] = str(target_path)

            thumbnail_path = file_info.get("thumbnailPath")
            if thumbnail_path:
                target_thumbnail_path = target_dir / Path(str(thumbnail_path)).name
                try:
                    target_thumbnail_path.write_bytes(archive.read(str(thumbnail_path)))
                except KeyError as exc:
                    raise HTTPException(status_code=400, detail=f"备份中找不到缩略图文件：{thumbnail_path}") from exc
                asset["thumbnail_path"] = str(target_thumbnail_path)
            else:
                asset["thumbnail_path"] = None

    delete_order = [
        "sessions",
        "template_ratings",
        "prompt_template_versions",
        "assets",
        "generation_tasks",
        "prompt_templates",
        "projects",
        "api_channels",
        "audit_logs",
        "open_prompt_discoveries",
        "auto_import_runs",
        "auto_import_settings",
        "users",
    ]

    with get_conn() as conn:
        for table in delete_order:
            conn.execute(f"DELETE FROM {table}")

        for row in tables.get("users") or []:
            conn.execute(
                """
                INSERT INTO users (id, username, password_hash, role, created_at, updated_at)
                VALUES (?, ?, ?, ?, ?, ?)
                """,
                (
                    row["id"],
                    row["username"],
                    row["password_hash"],
                    row["role"],
                    row["created_at"],
                    row["updated_at"],
                ),
            )

        for row in tables.get("projects") or []:
            conn.execute(
                """
                INSERT INTO projects (id, user_id, name, description, color, is_archived, created_at, updated_at)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?)
                """,
                (
                    row["id"],
                    row["user_id"],
                    row["name"],
                    row["description"],
                    row["color"],
                    row["is_archived"],
                    row["created_at"],
                    row["updated_at"],
                ),
            )

        for row in tables.get("api_channels") or []:
            conn.execute(
                """
                INSERT INTO api_channels (
                  id, name, base_url, api_key, models_json, timeout_seconds, codex_cli, codex_cli_mode,
                  health_status, health_message, health_checked_at, health_latency_ms,
                  compatibility_status, compatibility_message, compatibility_checked_at,
                  is_enabled, created_at, updated_at
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                """,
                (
                    row["id"],
                    row["name"],
                    row["base_url"],
                    row["api_key"],
                    row["models_json"],
                    row["timeout_seconds"],
                    row["codex_cli"],
                    row.get("codex_cli_mode", "auto"),
                    row.get("health_status", "unknown"),
                    row.get("health_message", ""),
                    row.get("health_checked_at"),
                    row.get("health_latency_ms"),
                    row.get("compatibility_status", "unknown"),
                    row.get("compatibility_message", ""),
                    row.get("compatibility_checked_at"),
                    row["is_enabled"],
                    row["created_at"],
                    row["updated_at"],
                ),
            )

        for row in tables.get("prompt_templates") or []:
            conn.execute(
                """
                INSERT INTO prompt_templates (
                  id, user_id, project_id, title, description, prompt, negative_prompt, tags_json, category,
                  params_json, channel_id, api_mode, model, cover_image_id, external_cover_url, example_images_json,
                  recommended_channel_id, recommended_api_mode, recommended_model, linked_task_ids_json,
                  is_favorite, favorite_count, usage_count, success_count, failure_count, rating_total, rating_count,
                  last_used_at, quality_score, source_name, source_url, source_author, license_name,
                  form_fields_json, collections_json, is_featured, visibility, submission_status,
                  submitted_at, reviewed_at, reviewed_by, rejection_reason, version, created_at, updated_at
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                """,
                (
                    row["id"],
                    row["user_id"],
                    row.get("project_id"),
                    row["title"],
                    row["description"],
                    row["prompt"],
                    row.get("negative_prompt"),
                    row["tags_json"],
                    row["category"],
                    row["params_json"],
                    row.get("channel_id"),
                    row["api_mode"],
                    row["model"],
                    row.get("cover_image_id"),
                    row.get("external_cover_url"),
                    row.get("example_images_json", "[]"),
                    row.get("recommended_channel_id"),
                    row.get("recommended_api_mode"),
                    row.get("recommended_model", ""),
                    row["linked_task_ids_json"],
                    row["is_favorite"],
                    row.get("favorite_count", 0),
                    row.get("usage_count", 0),
                    row.get("success_count", 0),
                    row.get("failure_count", 0),
                    row.get("rating_total", 0),
                    row.get("rating_count", 0),
                    row.get("last_used_at"),
                    row.get("quality_score", 0),
                    row.get("source_name", ""),
                    row.get("source_url", ""),
                    row.get("source_author", ""),
                    row.get("license_name", ""),
                    row.get("form_fields_json", "[]"),
                    row.get("collections_json", "[]"),
                    row.get("is_featured", 0),
                    row.get("visibility", "private"),
                    row.get("submission_status", "draft"),
                    row.get("submitted_at"),
                    row.get("reviewed_at"),
                    row.get("reviewed_by"),
                    row.get("rejection_reason"),
                    row.get("version", 1),
                    row["created_at"],
                    row["updated_at"],
                ),
            )

        for row in tables.get("prompt_template_versions") or []:
            conn.execute(
                """
                INSERT INTO prompt_template_versions (id, template_id, version, snapshot_json, created_by, created_at)
                VALUES (?, ?, ?, ?, ?, ?)
                """,
                (
                    row["id"],
                    row["template_id"],
                    row["version"],
                    row["snapshot_json"],
                    row.get("created_by"),
                    row["created_at"],
                ),
            )

        for row in tables.get("template_ratings") or []:
            conn.execute(
                """
                INSERT INTO template_ratings (template_id, user_id, score, updated_at)
                VALUES (?, ?, ?, ?)
                """,
                (row["template_id"], row["user_id"], row["score"], row["updated_at"]),
            )

        for row in tables.get("generation_tasks") or []:
            conn.execute(
                """
                INSERT INTO generation_tasks (
                  id, user_id, template_id, template_version_id, project_id, parent_task_id, experiment_id, variation_label,
                  prompt, params_json, input_image_ids_json, mask_target_image_id, mask_image_id, output_image_ids_json,
                  actual_params_json, actual_params_by_image_json, revised_prompt_by_image_json, status, error,
                  created_at, finished_at, elapsed, is_favorite, diagnostics_json, channel_id, api_mode, model
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                """,
                (
                    row["id"],
                    row["user_id"],
                    row.get("template_id"),
                    row.get("template_version_id"),
                    row.get("project_id"),
                    row.get("parent_task_id"),
                    row.get("experiment_id"),
                    row.get("variation_label"),
                    row["prompt"],
                    row["params_json"],
                    row["input_image_ids_json"],
                    row.get("mask_target_image_id"),
                    row.get("mask_image_id"),
                    row["output_image_ids_json"],
                    row.get("actual_params_json"),
                    row.get("actual_params_by_image_json"),
                    row.get("revised_prompt_by_image_json"),
                    row["status"],
                    row.get("error"),
                    row["created_at"],
                    row.get("finished_at"),
                    row.get("elapsed"),
                    row.get("is_favorite", 0),
                    row.get("diagnostics_json", "[]"),
                    row.get("channel_id"),
                    row.get("api_mode"),
                    row.get("model"),
                ),
            )

        for row in tables.get("assets") or []:
            conn.execute(
                """
                INSERT INTO assets (
                  id, user_id, task_id, template_id, type, path, thumbnail_path, mime,
                  width, height, size_bytes, visual_hash, created_at
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                """,
                (
                    row["id"],
                    row["user_id"],
                    row.get("task_id"),
                    row.get("template_id"),
                    row["type"],
                    row["path"],
                    row.get("thumbnail_path"),
                    row["mime"],
                    row.get("width"),
                    row.get("height"),
                    row["size_bytes"],
                    row.get("visual_hash"),
                    row["created_at"],
                ),
            )

        for row in tables.get("audit_logs") or []:
            conn.execute(
                """
                INSERT INTO audit_logs (id, actor_user_id, actor_username, action, resource_type, resource_id, details_json, created_at)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?)
                """,
                (
                    row["id"],
                    row.get("actor_user_id"),
                    row.get("actor_username"),
                    row["action"],
                    row["resource_type"],
                    row.get("resource_id"),
                    row.get("details_json", "{}"),
                    row["created_at"],
                ),
            )

        for row in tables.get("auto_import_settings") or []:
            conn.execute(
                """
                INSERT INTO auto_import_settings (id, settings_json, github_token, last_run_at, updated_at)
                VALUES (?, ?, ?, ?, ?)
                """,
                (
                    row["id"],
                    row["settings_json"],
                    row.get("github_token", ""),
                    row.get("last_run_at"),
                    row["updated_at"],
                ),
            )

        for row in tables.get("open_prompt_discoveries") or []:
            conn.execute(
                """
                INSERT INTO open_prompt_discoveries (
                  id, source_id, label, repo_url, description, stars, forks, hot_score, prompt_count,
                  license_name, last_seen_at, last_imported_at, last_status, last_message
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                """,
                (
                    row["id"],
                    row["source_id"],
                    row["label"],
                    row["repo_url"],
                    row.get("description", ""),
                    row.get("stars", 0),
                    row.get("forks", 0),
                    row.get("hot_score", 0),
                    row.get("prompt_count", 0),
                    row.get("license_name", ""),
                    row["last_seen_at"],
                    row.get("last_imported_at"),
                    row.get("last_status", ""),
                    row.get("last_message", ""),
                ),
            )

        for row in tables.get("auto_import_runs") or []:
            conn.execute(
                """
                INSERT INTO auto_import_runs (
                  id, status, trigger, started_at, finished_at, discovered_repositories, selected_repositories,
                  created, updated, skipped, submitted, approved, message, details_json
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                """,
                (
                    row["id"],
                    row["status"],
                    row["trigger"],
                    row["started_at"],
                    row.get("finished_at"),
                    row.get("discovered_repositories", 0),
                    row.get("selected_repositories", 0),
                    row.get("created", 0),
                    row.get("updated", 0),
                    row.get("skipped", 0),
                    row.get("submitted", 0),
                    row.get("approved", 0),
                    row.get("message", ""),
                    row.get("details_json", "{}"),
                ),
            )

        restored_users = tables.get("users") or []
        target_user = next((row for row in restored_users if row["username"] == actor.username), None) or next(
            (row for row in restored_users if row["role"] == "admin"),
            restored_users[0],
        )
        session_token = create_session_token()
        conn.execute(
            "INSERT INTO sessions (id, user_id, created_at, expires_at) VALUES (?, ?, ?, ?)",
            (session_token, target_user["id"], now_ms(), None),
        )

    set_session_cookie(response, session_token)


def compact_message(value: Any, limit: int = 280) -> str:
    text = " ".join(str(value or "").split())
    if len(text) <= limit:
        return text
    return f"{text[: limit - 1]}…"


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


def insert_audit_log(
    conn: Any,
    actor: UserOut | None,
    action: str,
    resource_type: str,
    resource_id: str | None = None,
    details: dict[str, Any] | None = None,
) -> None:
    conn.execute(
        """
        INSERT INTO audit_logs (id, actor_user_id, actor_username, action, resource_type, resource_id, details_json, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        """,
        (
            new_id(),
            actor.id if actor else None,
            actor.username if actor else None,
            action,
            resource_type,
            resource_id,
            json_dumps(details or {}),
            now_ms(),
        ),
    )


def write_audit_log(
    actor: UserOut | None,
    action: str,
    resource_type: str,
    resource_id: str | None = None,
    details: dict[str, Any] | None = None,
) -> None:
    with get_conn() as conn:
        insert_audit_log(conn, actor, action, resource_type, resource_id, details)


def row_to_audit_log(row: Any) -> AuditLogOut:
    return AuditLogOut(
        id=row["id"],
        actorUserId=row["actor_user_id"],
        actorUsername=row["actor_username"],
        action=row["action"],
        resourceType=row["resource_type"],
        resourceId=row["resource_id"],
        details=json_loads(row["details_json"], {}),
        createdAt=row["created_at"],
    )


def row_to_user(row: Any) -> UserOut:
    return UserOut(
        id=row["id"],
        username=row["username"],
        role=row["role"],
        createdAt=row["created_at"],
        updatedAt=row["updated_at"],
    )


def row_to_project(row: Any) -> ProjectBoardOut:
    return ProjectBoardOut(
        id=row["id"],
        name=row["name"],
        description=row["description"] or "",
        color=row["color"] or "#3b82f6",
        isArchived=bool(row["is_archived"]),
        taskCount=int(row["task_count"] if "task_count" in row.keys() and row["task_count"] is not None else 0),
        templateCount=int(
            row["template_count"] if "template_count" in row.keys() and row["template_count"] is not None else 0
        ),
        createdAt=row["created_at"],
        updatedAt=row["updated_at"],
    )


def api_key_preview(api_key: str | None) -> str:
    if not api_key:
        return ""
    if len(api_key) <= 8:
        return "••••"
    return f"{api_key[:3]}••••{api_key[-4:]}"


def normalize_trusted_repo_value(value: str) -> str:
    raw = str(value or "").strip()
    if not raw:
        return ""
    if raw.startswith("http://") or raw.startswith("https://"):
        parsed = urlparse(raw)
        parts = [part for part in parsed.path.strip("/").split("/") if part]
        if len(parts) >= 2 and "github.com" in parsed.netloc.lower():
            return f"{parts[0]}/{parts[1].removesuffix('.git')}".lower()
    if raw.lower().startswith("github.com/"):
        parts = [part for part in raw.split("/", 1)[1].strip("/").split("/") if part]
        if len(parts) >= 2:
            return f"{parts[0]}/{parts[1].removesuffix('.git')}".lower()
    if re.match(r"^[\w.-]+/[\w.-]+(?:\.git)?$", raw):
        owner, repo = raw.split("/", 1)
        return f"{owner}/{repo.removesuffix('.git')}".lower()
    return raw.lower()


def normalize_repo_from_url(url: str) -> str:
    return normalize_trusted_repo_value(url)


def unique_clean_strings(values: list[str] | None, *, limit: int, max_len: int) -> list[str]:
    seen: set[str] = set()
    results: list[str] = []
    for raw in values or []:
        value = re.sub(r"\s+", " ", str(raw or "")).strip()
        if not value:
            continue
        value = value[:max_len]
        key = value.lower()
        if key in seen:
            continue
        seen.add(key)
        results.append(value)
        if len(results) >= limit:
            break
    return results


def sanitize_auto_import_settings(data: dict[str, Any] | None) -> dict[str, Any]:
    merged = {**DEFAULT_AUTO_IMPORT_SETTINGS, **(data or {})}
    search_queries = unique_clean_strings(merged.get("searchQueries"), limit=12, max_len=120)
    trusted_repos = [
        normalized
        for normalized in (
            normalize_trusted_repo_value(value)
            for value in unique_clean_strings(merged.get("trustedRepos"), limit=50, max_len=200)
        )
        if normalized
    ]
    if not search_queries:
        search_queries = list(DEFAULT_AUTO_IMPORT_SETTINGS["searchQueries"])
    return {
        "enabled": bool(merged.get("enabled")),
        "runHour": max(0, min(23, int(merged.get("runHour") or 0))),
        "searchQueries": search_queries,
        "trustedRepos": sorted(set(trusted_repos)),
        "includeKnownSources": bool(merged.get("includeKnownSources")),
        "autoApproveTrusted": bool(merged.get("autoApproveTrusted")),
        "maxRepositories": max(1, min(50, int(merged.get("maxRepositories") or 1))),
        "maxTemplatesPerRun": max(1, min(300, int(merged.get("maxTemplatesPerRun") or 1))),
        "minHotScore": max(0.0, min(10000.0, float(merged.get("minHotScore") or 0))),
    }


def local_day_key(ts_ms: int | None) -> str:
    if not ts_ms:
        return ""
    local = time.localtime(ts_ms / 1000)
    return f"{local.tm_year}-{local.tm_yday}"


def local_run_time_ms(run_hour: int, reference_ms: int) -> int:
    local = time.localtime(reference_ms / 1000)
    return int(
        time.mktime(
            (
                local.tm_year,
                local.tm_mon,
                local.tm_mday,
                max(0, min(23, run_hour)),
                0,
                0,
                local.tm_wday,
                local.tm_yday,
                local.tm_isdst,
            )
        )
        * 1000
    )


def next_auto_import_run_at(data: dict[str, Any]) -> int | None:
    if not data.get("enabled"):
        return None
    ts = now_ms()
    candidate = local_run_time_ms(int(data.get("runHour") or 0), ts)
    last_run_at = data.get("lastRunAt")
    if last_run_at and local_day_key(int(last_run_at)) == local_day_key(ts):
        return candidate + 24 * 60 * 60 * 1000
    if candidate <= ts:
        return ts
    return candidate


def should_run_auto_import_now(data: dict[str, Any]) -> bool:
    if not data.get("enabled"):
        return False
    ts = now_ms()
    if ts < local_run_time_ms(int(data.get("runHour") or 0), ts):
        return False
    last_run_at = data.get("lastRunAt")
    return not last_run_at or local_day_key(int(last_run_at)) != local_day_key(ts)


def read_auto_import_settings() -> tuple[dict[str, Any], str]:
    with get_conn() as conn:
        row = conn.execute("SELECT * FROM auto_import_settings WHERE id = 'default'").fetchone()
    if not row:
        return sanitize_auto_import_settings({}), ""
    data = sanitize_auto_import_settings(json_loads(row["settings_json"], {}))
    data["lastRunAt"] = row["last_run_at"]
    data["updatedAt"] = row["updated_at"]
    return data, row["github_token"] or ""


def auto_import_settings_out(data: dict[str, Any], github_token: str) -> AutoImportSettingsOut:
    return AutoImportSettingsOut(
        enabled=bool(data.get("enabled")),
        runHour=int(data.get("runHour") or 0),
        githubTokenPreview=api_key_preview(github_token),
        searchQueries=list(data.get("searchQueries") or []),
        trustedRepos=list(data.get("trustedRepos") or []),
        includeKnownSources=bool(data.get("includeKnownSources")),
        autoApproveTrusted=bool(data.get("autoApproveTrusted")),
        maxRepositories=int(data.get("maxRepositories") or 1),
        maxTemplatesPerRun=int(data.get("maxTemplatesPerRun") or 1),
        minHotScore=float(data.get("minHotScore") or 0),
        lastRunAt=data.get("lastRunAt"),
        nextRunAt=next_auto_import_run_at(data),
        updatedAt=data.get("updatedAt"),
    )


def row_to_auto_import_run(row: Any) -> AutoImportRunOut:
    return AutoImportRunOut(
        id=row["id"],
        status=row["status"],
        trigger=row["trigger"],
        startedAt=row["started_at"],
        finishedAt=row["finished_at"],
        discoveredRepositories=int(row["discovered_repositories"] or 0),
        selectedRepositories=int(row["selected_repositories"] or 0),
        created=int(row["created"] or 0),
        updated=int(row["updated"] or 0),
        skipped=int(row["skipped"] or 0),
        submitted=int(row["submitted"] or 0),
        approved=int(row["approved"] or 0),
        message=row["message"] or "",
        details=json_loads(row["details_json"], {}),
    )


def row_to_open_prompt_discovery(row: Any) -> OpenPromptDiscoveryOut:
    return OpenPromptDiscoveryOut(
        id=row["id"],
        sourceId=row["source_id"],
        label=row["label"],
        repoUrl=row["repo_url"],
        description=row["description"] or "",
        stars=int(row["stars"] or 0),
        forks=int(row["forks"] or 0),
        hotScore=float(row["hot_score"] or 0),
        promptCount=int(row["prompt_count"] or 0),
        licenseName=row["license_name"] or "",
        lastSeenAt=row["last_seen_at"],
        lastImportedAt=row["last_imported_at"],
        lastStatus=row["last_status"] or "",
        lastMessage=row["last_message"] or "",
    )


def normalize_codex_cli_mode(value: str | None) -> CodexCliMode:
    if value == "standard" or value == "codex":
        return value
    return "auto"


def normalize_channel_health_status(value: str | None) -> ChannelHealthStatus:
    if value in {"checking", "healthy", "degraded", "error"}:
        return value
    return "unknown"


def normalize_channel_compatibility_status(value: str | None) -> ChannelCompatibilityStatus:
    if value in {"checking", "standard", "codex", "error"}:
        return value
    return "unknown"


def effective_codex_cli(row: Any) -> bool:
    mode = normalize_codex_cli_mode(row["codex_cli_mode"] if "codex_cli_mode" in row.keys() else None)
    if mode == "codex":
        return True
    if mode == "standard":
        return False
    return bool(row["codex_cli"])


def row_to_channel(row: Any) -> ApiChannelOut:
    return ApiChannelOut(
        id=row["id"],
        name=row["name"],
        models=[ChannelModel.model_validate(item) for item in json_loads(row["models_json"], [])],
        timeoutSeconds=int(row["timeout_seconds"] or settings.request_timeout_seconds),
        codexCli=effective_codex_cli(row),
        codexCliMode=normalize_codex_cli_mode(row["codex_cli_mode"] if "codex_cli_mode" in row.keys() else None),
        healthStatus=normalize_channel_health_status(row["health_status"] if "health_status" in row.keys() else None),
        healthMessage=row["health_message"] if "health_message" in row.keys() else "",
        healthCheckedAt=row["health_checked_at"] if "health_checked_at" in row.keys() else None,
        healthLatencyMs=row["health_latency_ms"] if "health_latency_ms" in row.keys() else None,
        compatibilityStatus=normalize_channel_compatibility_status(
            row["compatibility_status"] if "compatibility_status" in row.keys() else None
        ),
        compatibilityMessage=row["compatibility_message"] if "compatibility_message" in row.keys() else "",
        compatibilityCheckedAt=row["compatibility_checked_at"] if "compatibility_checked_at" in row.keys() else None,
        isEnabled=bool(row["is_enabled"]),
        createdAt=row["created_at"],
        updatedAt=row["updated_at"],
    )


def row_to_admin_channel(row: Any) -> AdminApiChannelOut:
    public = row_to_channel(row).model_dump()
    return AdminApiChannelOut(
        **public,
        baseUrl=row["base_url"],
        apiKeyPreview=api_key_preview(row["api_key"]),
    )


def row_to_template(row: Any) -> PromptTemplateOut:
    return PromptTemplateOut(
        id=row["id"],
        userId=row["user_id"],
        projectId=row["project_id"] if "project_id" in row.keys() else None,
        title=row["title"],
        description=row["description"],
        prompt=row["prompt"],
        negativePrompt=row["negative_prompt"],
        tags=json_loads(row["tags_json"], []),
        category=row["category"],
        params=TaskParams.model_validate(json_loads(row["params_json"], {})),
        channelId=row["channel_id"],
        apiMode=row["api_mode"],
        model=row["model"],
        coverImageId=row["cover_image_id"],
        externalCoverUrl=row["external_cover_url"] if "external_cover_url" in row.keys() else None,
        exampleImages=json_loads(row["example_images_json"] if "example_images_json" in row.keys() else None, []),
        recommendedChannelId=(row["recommended_channel_id"] if "recommended_channel_id" in row.keys() else None) or None,
        recommendedApiMode=(row["recommended_api_mode"] if "recommended_api_mode" in row.keys() else None) or None,
        recommendedModel=(row["recommended_model"] if "recommended_model" in row.keys() else "") or "",
        linkedTaskIds=json_loads(row["linked_task_ids_json"], []),
        isFavorite=bool(row["is_favorite"]),
        sourceName=row["source_name"] if "source_name" in row.keys() else "",
        sourceUrl=row["source_url"] if "source_url" in row.keys() else "",
        sourceAuthor=row["source_author"] if "source_author" in row.keys() else "",
        licenseName=row["license_name"] if "license_name" in row.keys() else "",
        formFields=json_loads(row["form_fields_json"] if "form_fields_json" in row.keys() else None, []),
        collections=json_loads(row["collections_json"] if "collections_json" in row.keys() else None, []),
        isFeatured=bool(row["is_featured"] if "is_featured" in row.keys() else 0),
        visibility=row["visibility"],
        submissionStatus=row["submission_status"],
        submittedAt=row["submitted_at"],
        reviewedAt=row["reviewed_at"],
        reviewedBy=row["reviewed_by"],
        rejectionReason=row["rejection_reason"],
        favoriteCount=int(row["favorite_count"] if "favorite_count" in row.keys() and row["favorite_count"] is not None else 0),
        usageCount=int(row["usage_count"] if "usage_count" in row.keys() and row["usage_count"] is not None else 0),
        successCount=int(row["success_count"] if "success_count" in row.keys() and row["success_count"] is not None else 0),
        failureCount=int(row["failure_count"] if "failure_count" in row.keys() and row["failure_count"] is not None else 0),
        ratingCount=int(row["rating_count"] if "rating_count" in row.keys() and row["rating_count"] is not None else 0),
        averageRating=round(
            float(row["rating_total"] or 0) / float(row["rating_count"] or 1),
            2,
        )
        if "rating_total" in row.keys() and "rating_count" in row.keys() and row["rating_count"]
        else 0,
        lastUsedAt=row["last_used_at"] if "last_used_at" in row.keys() else None,
        qualityScore=float(row["quality_score"] if "quality_score" in row.keys() and row["quality_score"] is not None else 0),
        version=row["version"],
        createdAt=row["created_at"],
        updatedAt=row["updated_at"],
    )


def row_to_template_version(row: Any) -> TemplateVersionOut:
    return TemplateVersionOut(
        id=row["id"],
        templateId=row["template_id"],
        version=int(row["version"]),
        snapshot=json_loads(row["snapshot_json"], {}),
        createdBy=row["created_by"],
        createdAt=row["created_at"],
    )


def row_to_task(row: Any) -> GenerationTaskOut:
    return GenerationTaskOut(
        id=row["id"],
        userId=row["user_id"],
        templateId=row["template_id"],
        templateVersionId=row["template_version_id"],
        projectId=row["project_id"] if "project_id" in row.keys() else None,
        parentTaskId=row["parent_task_id"] if "parent_task_id" in row.keys() else None,
        experimentId=row["experiment_id"] if "experiment_id" in row.keys() else None,
        variationLabel=row["variation_label"] if "variation_label" in row.keys() else None,
        prompt=row["prompt"],
        params=TaskParams.model_validate(json_loads(row["params_json"], {})),
        inputImageIds=json_loads(row["input_image_ids_json"], []),
        maskTargetImageId=row["mask_target_image_id"],
        maskImageId=row["mask_image_id"],
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
        diagnostics=json_loads(row["diagnostics_json"] if "diagnostics_json" in row.keys() else None, []),
        channelId=row["channel_id"],
        apiMode=row["api_mode"],
        model=row["model"],
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


def require_admin(user: UserOut = Depends(require_user)) -> UserOut:
    if user.role != "admin":
        raise HTTPException(status_code=403, detail="Admin privileges required")
    return user


def can_manage_template_library(user: UserOut) -> bool:
    return user.role in {"admin", "reviewer"}


def require_template_operator(user: UserOut = Depends(require_user)) -> UserOut:
    if not can_manage_template_library(user):
        raise HTTPException(status_code=403, detail="Template review privileges required")
    return user


def get_project_row_or_404(conn: Any, project_id: str, user: UserOut) -> Any:
    row = conn.execute(
        "SELECT * FROM projects WHERE id = ? AND user_id = ?",
        (project_id, user.id),
    ).fetchone()
    if not row:
        raise HTTPException(status_code=404, detail="Project not found")
    return row


def resolve_owned_project_id(project_id: str | None, user: UserOut) -> str | None:
    normalized = (project_id or "").strip()
    if not normalized:
        return None
    with get_conn() as conn:
        get_project_row_or_404(conn, normalized, user)
    return normalized


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
            user_count = conn.execute("SELECT COUNT(*) AS count FROM users").fetchone()["count"]
            role = "admin" if user_count == 0 else "user"
            conn.execute(
                """
                INSERT INTO users (id, username, password_hash, role, created_at, updated_at)
                VALUES (?, ?, ?, ?, ?, ?)
                """,
                (user_id, username, password_hash, role, ts, ts),
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


def normalize_channel_models(models: list[ChannelModel]) -> list[ChannelModel]:
    normalized: list[ChannelModel] = []
    seen: set[str] = set()
    source = models or [ChannelModel(id="gpt-image-2", label="GPT Image 2", apiMode="images", enabled=True)]
    for model in source:
        model_id = model.id.strip()
        if not model_id or model_id in seen:
            continue
        seen.add(model_id)
        normalized.append(
            ChannelModel(
                id=model_id,
                label=model.label.strip() or model_id,
                apiMode=model.apiMode,
                enabled=model.enabled,
            )
        )
    if not normalized:
        raise HTTPException(status_code=400, detail="At least one model is required")
    return normalized


def get_channel_row_or_404(channel_id: str, *, admin: bool = False) -> Any:
    with get_conn() as conn:
        if admin:
            row = conn.execute("SELECT * FROM api_channels WHERE id = ?", (channel_id,)).fetchone()
        else:
            row = conn.execute(
                "SELECT * FROM api_channels WHERE id = ? AND is_enabled = 1",
                (channel_id,),
            ).fetchone()
    if not row:
        raise HTTPException(status_code=404, detail="Channel not found")
    return row


def get_enabled_channel_model(channel_id: str, model_id: str) -> tuple[Any, ChannelModel]:
    row = get_channel_row_or_404(channel_id)
    for model in row_to_channel(row).models:
        if model.id == model_id and model.enabled:
            return row, model
    raise HTTPException(status_code=400, detail="Selected model is not available for this channel")


def validate_template_channel_selection(channel_id: str | None, api_mode: str, model_id: str) -> None:
    if not channel_id:
        raise HTTPException(status_code=400, detail="Channel is required")
    _, selected_model = get_enabled_channel_model(channel_id, model_id)
    if selected_model.apiMode != api_mode:
        raise HTTPException(status_code=400, detail="Selected model does not match the chosen API mode")


def record_channel_health(
    channel_id: str,
    status: ChannelHealthStatus,
    message: str,
    latency_ms: int | None = None,
    checked_at: int | None = None,
) -> None:
    with get_conn() as conn:
        conn.execute(
            """
            UPDATE api_channels
            SET health_status = ?, health_message = ?, health_checked_at = ?, health_latency_ms = ?, updated_at = ?
            WHERE id = ?
            """,
            (status, compact_message(message), checked_at or now_ms(), latency_ms, now_ms(), channel_id),
        )


def record_channel_compatibility(
    channel_id: str,
    status: ChannelCompatibilityStatus,
    message: str,
    checked_at: int | None = None,
) -> None:
    with get_conn() as conn:
        conn.execute(
            """
            UPDATE api_channels
            SET compatibility_status = ?, compatibility_message = ?, compatibility_checked_at = ?, updated_at = ?
            WHERE id = ?
            """,
            (status, compact_message(message), checked_at or now_ms(), now_ms(), channel_id),
        )


def reset_channel_health(conn: Any, channel_id: str) -> None:
    conn.execute(
        """
        UPDATE api_channels
        SET health_status = 'unknown', health_message = '', health_checked_at = NULL, health_latency_ms = NULL
        WHERE id = ?
        """,
        (channel_id,),
    )


def reset_channel_compatibility(conn: Any, channel_id: str) -> None:
    conn.execute(
        """
        UPDATE api_channels
        SET compatibility_status = 'unknown', compatibility_message = '', compatibility_checked_at = NULL
        WHERE id = ?
        """,
        (channel_id,),
    )


def response_model_ids(data: Any) -> set[str]:
    if not isinstance(data, dict):
        return set()
    items = data.get("data")
    if not isinstance(items, list):
        return set()
    ids: set[str] = set()
    for item in items:
        if isinstance(item, dict) and isinstance(item.get("id"), str):
            ids.add(item["id"])
    return ids


async def perform_channel_health_check(channel_id: str, actor: UserOut | None = None) -> AdminApiChannelOut:
    row = get_channel_row_or_404(channel_id, admin=True)
    record_channel_health(channel_id, "checking", "正在检测渠道")
    base_url = normalize_base_url(row["base_url"])
    api_key = (row["api_key"] or "").strip()
    timeout = min(float(row["timeout_seconds"] or settings.request_timeout_seconds), 20.0)
    headers = {"Authorization": f"Bearer {api_key}", "Cache-Control": "no-store"}
    started = time.perf_counter()
    status: ChannelHealthStatus
    message: str

    try:
        async with httpx.AsyncClient(timeout=timeout) as client:
            response = await client.get(endpoint_url(base_url, "models"), headers=headers)
        latency_ms = int((time.perf_counter() - started) * 1000)
        if 200 <= response.status_code < 300:
            upstream_models = response_model_ids(response.json())
            configured_models = {model.id for model in row_to_channel(row).models if model.enabled}
            missing_models = sorted(configured_models - upstream_models) if upstream_models else []
            if missing_models:
                status = "degraded"
                message = f"/models 可访问，但配置模型未全部返回：{', '.join(missing_models[:5])}"
            else:
                status = "healthy"
                message = "/models 检测成功"
        elif response.status_code in {401, 403}:
            status = "error"
            message = f"认证失败，HTTP {response.status_code}"
        elif response.status_code == 404:
            status = "degraded"
            message = "/models 不可用，生成接口可能仍可用"
        else:
            status = "error"
            message = f"健康检测失败，HTTP {response.status_code}"
    except httpx.TimeoutException:
        latency_ms = int((time.perf_counter() - started) * 1000)
        status = "error"
        message = "健康检测超时"
    except (httpx.HTTPError, ValueError):
        latency_ms = int((time.perf_counter() - started) * 1000)
        status = "error"
        message = "健康检测请求失败"

    with get_conn() as conn:
        conn.execute(
            """
            UPDATE api_channels
            SET health_status = ?, health_message = ?, health_checked_at = ?, health_latency_ms = ?, updated_at = ?
            WHERE id = ?
            """,
            (status, compact_message(message), now_ms(), latency_ms, now_ms(), channel_id),
        )
        insert_audit_log(
            conn,
            actor,
            "channel.health_check",
            "api_channel",
            channel_id,
            {"status": status, "message": message, "latencyMs": latency_ms},
        )
        updated = conn.execute("SELECT * FROM api_channels WHERE id = ?", (channel_id,)).fetchone()
    return row_to_admin_channel(updated)


async def perform_channel_compatibility_check(channel_id: str, actor: UserOut | None = None) -> AdminApiChannelOut:
    row = get_channel_row_or_404(channel_id, admin=True)
    channel = row_to_channel(row)
    selected_model = next((model for model in channel.models if model.enabled), None)
    if not selected_model:
        raise HTTPException(status_code=400, detail="Channel has no enabled models")
    api_key = (row["api_key"] or "").strip()
    if not api_key:
        raise HTTPException(status_code=400, detail="The selected channel does not have an API key configured")

    with get_conn() as conn:
        conn.execute(
            """
            UPDATE api_channels
            SET compatibility_status = 'checking', compatibility_message = ?, compatibility_checked_at = ?, updated_at = ?
            WHERE id = ?
            """,
            ("正在检测接口兼容性", now_ms(), now_ms(), channel_id),
        )

    base_url = normalize_base_url(row["base_url"])
    timeout = min(float(row["timeout_seconds"] or settings.request_timeout_seconds), 60.0)
    fallback_mime = "image/png"
    probe_payload = GenerateIn(
        channelId=channel_id,
        model=selected_model.id,
        prompt="Compatibility probe: generate a simple white square.",
        params=TaskParams(
            size="auto",
            quality="low",
            output_format="png",
            output_compression=None,
            moderation="auto",
            n=1,
        ),
        inputImageDataUrls=[],
        maskDataUrl=None,
    )

    status: ChannelCompatibilityStatus
    message: str
    detected_codex_cli = False
    try:
        async with httpx.AsyncClient(timeout=timeout) as client:
            await call_upstream_once(client, probe_payload, selected_model, api_key, base_url, fallback_mime, False)
        status = "standard"
        message = "已确认兼容标准 OpenAI Images / Responses 参数"
        detected_codex_cli = False
    except httpx.HTTPStatusError as exc:
        if is_unsupported_quality_error(exc):
            status = "codex"
            message = "检测到 quality 参数不受支持，判定为 Codex CLI 风格兼容接口"
            detected_codex_cli = True
        else:
            status = "error"
            message = f"兼容性检测失败，HTTP {exc.response.status_code}"
    except httpx.TimeoutException:
        status = "error"
        message = "兼容性检测超时"
    except (httpx.HTTPError, ValueError, ValidationError):
        status = "error"
        message = "兼容性检测请求失败"

    with get_conn() as conn:
        conn.execute(
            """
            UPDATE api_channels
            SET codex_cli = CASE WHEN codex_cli_mode = 'auto' THEN ? ELSE codex_cli END,
                compatibility_status = ?, compatibility_message = ?, compatibility_checked_at = ?,
                health_status = CASE WHEN ? IN ('standard', 'codex') THEN 'healthy' ELSE health_status END,
                health_message = CASE WHEN ? IN ('standard', 'codex') THEN '兼容性检测已连通' ELSE health_message END,
                health_checked_at = CASE WHEN ? IN ('standard', 'codex') THEN ? ELSE health_checked_at END,
                updated_at = ?
            WHERE id = ?
            """,
            (
                int(detected_codex_cli),
                status,
                compact_message(message),
                now_ms(),
                status,
                status,
                status,
                now_ms(),
                now_ms(),
                channel_id,
            ),
        )
        insert_audit_log(
            conn,
            actor,
            "channel.compatibility_check",
            "api_channel",
            channel_id,
            {"status": status, "message": message, "model": selected_model.id},
        )
        updated = conn.execute("SELECT * FROM api_channels WHERE id = ?", (channel_id,)).fetchone()
    return row_to_admin_channel(updated)


@app.get("/api/channels", response_model=list[ApiChannelOut])
def list_public_channels(user: UserOut = Depends(require_user)) -> list[ApiChannelOut]:
    with get_conn() as conn:
        rows = conn.execute(
            "SELECT * FROM api_channels WHERE is_enabled = 1 ORDER BY updated_at DESC",
        ).fetchall()
    channels = [row_to_channel(row) for row in rows]
    return [
        channel.model_copy(update={"models": [model for model in channel.models if model.enabled]})
        for channel in channels
        if any(model.enabled for model in channel.models)
    ]


@app.get("/api/channels/leaderboard", response_model=list[ChannelLeaderboardOut])
def list_channel_leaderboard(user: UserOut = Depends(require_user)) -> list[ChannelLeaderboardOut]:
    del user
    with get_conn() as conn:
        rows = conn.execute(
            """
            SELECT
              generation_tasks.channel_id,
              generation_tasks.model,
              generation_tasks.api_mode,
              COUNT(*) AS total_count,
              SUM(CASE WHEN generation_tasks.status = 'done' THEN 1 ELSE 0 END) AS success_count,
              SUM(CASE WHEN generation_tasks.status = 'error' THEN 1 ELSE 0 END) AS failure_count,
              AVG(CASE WHEN generation_tasks.status = 'done' THEN generation_tasks.elapsed ELSE NULL END) AS average_elapsed,
              MAX(generation_tasks.created_at) AS last_used_at,
              api_channels.name AS channel_name,
              api_channels.health_status,
              api_channels.compatibility_status
            FROM generation_tasks
            LEFT JOIN api_channels ON api_channels.id = generation_tasks.channel_id
            WHERE generation_tasks.channel_id IS NOT NULL
            GROUP BY generation_tasks.channel_id, generation_tasks.model, generation_tasks.api_mode
            ORDER BY success_count DESC, total_count DESC, last_used_at DESC
            LIMIT 20
            """
        ).fetchall()
    results: list[ChannelLeaderboardOut] = []
    for row in rows:
        total = int(row["total_count"] or 0)
        success = int(row["success_count"] or 0)
        failure = int(row["failure_count"] or 0)
        results.append(
            ChannelLeaderboardOut(
                channelId=row["channel_id"],
                channelName=row["channel_name"] or "未知渠道",
                model=row["model"] or "",
                apiMode=row["api_mode"],
                totalCount=total,
                successCount=success,
                failureCount=failure,
                successRate=round(success / total, 3) if total else 0,
                averageElapsed=int(row["average_elapsed"]) if row["average_elapsed"] is not None else None,
                lastUsedAt=row["last_used_at"],
                healthStatus=normalize_channel_health_status(row["health_status"]),
                compatibilityStatus=normalize_channel_compatibility_status(row["compatibility_status"]),
            )
        )
    return results


@app.get("/api/admin/channels", response_model=list[AdminApiChannelOut])
def list_admin_channels(admin: UserOut = Depends(require_admin)) -> list[AdminApiChannelOut]:
    with get_conn() as conn:
        rows = conn.execute("SELECT * FROM api_channels ORDER BY updated_at DESC").fetchall()
    return [row_to_admin_channel(row) for row in rows]


@app.post("/api/admin/channels", response_model=AdminApiChannelOut)
def create_channel(payload: ApiChannelIn, admin: UserOut = Depends(require_admin)) -> AdminApiChannelOut:
    channel_id = new_id()
    ts = now_ms()
    name = payload.name.strip()
    base_url = normalize_base_url(payload.baseUrl)
    api_key = payload.apiKey.strip()
    timeout_seconds = max(10, min(600, int(payload.timeoutSeconds or settings.request_timeout_seconds)))
    codex_cli_mode = (
        payload.codexCliMode
        if "codexCliMode" in payload.model_fields_set
        else ("codex" if payload.codexCli else "auto")
    )
    detected_codex_cli = payload.codexCli if codex_cli_mode == "auto" else codex_cli_mode == "codex"
    if not name:
        raise HTTPException(status_code=400, detail="Channel name is required")
    if not api_key:
        raise HTTPException(status_code=400, detail="API key is required")
    models = normalize_channel_models(payload.models)
    with get_conn() as conn:
        conn.execute(
            """
            INSERT INTO api_channels (id, name, base_url, api_key, models_json, timeout_seconds, codex_cli, codex_cli_mode, is_enabled, created_at, updated_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            """,
            (
                channel_id,
                name,
                base_url,
                api_key,
                json_dumps([model.model_dump() for model in models]),
                timeout_seconds,
                int(detected_codex_cli),
                codex_cli_mode,
                int(payload.isEnabled),
                ts,
                ts,
            ),
        )
        insert_audit_log(
            conn,
            admin,
            "channel.create",
            "api_channel",
            channel_id,
            {
                "name": name,
                "models": [model.id for model in models],
                "timeoutSeconds": timeout_seconds,
                "codexCliMode": codex_cli_mode,
                "isEnabled": bool(payload.isEnabled),
            },
        )
        row = conn.execute("SELECT * FROM api_channels WHERE id = ?", (channel_id,)).fetchone()
    return row_to_admin_channel(row)


@app.patch("/api/admin/channels/{channel_id}", response_model=AdminApiChannelOut)
def patch_channel(channel_id: str, payload: ApiChannelPatch, admin: UserOut = Depends(require_admin)) -> AdminApiChannelOut:
    row = get_channel_row_or_404(channel_id, admin=True)
    data = payload.model_dump(exclude_unset=True)
    if not data:
        return row_to_admin_channel(row)
    current = row_to_admin_channel(row)
    next_name = (payload.name if payload.name is not None else current.name).strip()
    next_base_url = normalize_base_url(payload.baseUrl if payload.baseUrl is not None else current.baseUrl)
    next_api_key = payload.apiKey.strip() if payload.apiKey is not None else row["api_key"]
    next_models = normalize_channel_models(payload.models if payload.models is not None else current.models)
    next_timeout_seconds = max(
        10,
        min(
            600,
            int(
                payload.timeoutSeconds
                if payload.timeoutSeconds is not None
                else (row["timeout_seconds"] or settings.request_timeout_seconds)
            ),
        ),
    )
    current_mode = normalize_codex_cli_mode(row["codex_cli_mode"] if "codex_cli_mode" in row.keys() else None)
    if payload.codexCliMode is not None:
        next_codex_cli_mode = payload.codexCliMode
    elif payload.codexCli is not None:
        next_codex_cli_mode = "codex" if payload.codexCli else "standard"
    else:
        next_codex_cli_mode = current_mode
    if next_codex_cli_mode == "codex":
        next_codex_cli = True
    elif next_codex_cli_mode == "standard":
        next_codex_cli = False
    elif payload.codexCli is not None:
        next_codex_cli = payload.codexCli
    elif next_codex_cli_mode != current_mode:
        next_codex_cli = False
    else:
        next_codex_cli = bool(row["codex_cli"])
    next_enabled = payload.isEnabled if payload.isEnabled is not None else current.isEnabled
    if not next_name:
        raise HTTPException(status_code=400, detail="Channel name is required")
    if not next_api_key:
        raise HTTPException(status_code=400, detail="API key is required")
    ts = now_ms()
    with get_conn() as conn:
        conn.execute(
            """
            UPDATE api_channels SET
              name = ?, base_url = ?, api_key = ?, models_json = ?, timeout_seconds = ?, codex_cli = ?, codex_cli_mode = ?, is_enabled = ?, updated_at = ?
            WHERE id = ?
            """,
            (
                next_name,
                next_base_url,
                next_api_key,
                json_dumps([model.model_dump() for model in next_models]),
                next_timeout_seconds,
                int(next_codex_cli),
                next_codex_cli_mode,
                int(next_enabled),
                ts,
                channel_id,
            ),
        )
        reset_channel_health(conn, channel_id)
        reset_channel_compatibility(conn, channel_id)
        insert_audit_log(
            conn,
            admin,
            "channel.update",
            "api_channel",
            channel_id,
            {
                "name": next_name,
                "changed": sorted(data.keys()),
                "models": [model.id for model in next_models],
                "timeoutSeconds": next_timeout_seconds,
                "codexCliMode": next_codex_cli_mode,
                "isEnabled": bool(next_enabled),
            },
        )
        updated = conn.execute("SELECT * FROM api_channels WHERE id = ?", (channel_id,)).fetchone()
    return row_to_admin_channel(updated)


@app.delete("/api/admin/channels/{channel_id}")
def delete_channel(channel_id: str, admin: UserOut = Depends(require_admin)) -> dict[str, bool]:
    with get_conn() as conn:
        row = conn.execute("SELECT name FROM api_channels WHERE id = ?", (channel_id,)).fetchone()
        cur = conn.execute("DELETE FROM api_channels WHERE id = ?", (channel_id,))
        if cur.rowcount:
            insert_audit_log(
                conn,
                admin,
                "channel.delete",
                "api_channel",
                channel_id,
                {"name": row["name"] if row else ""},
            )
    if cur.rowcount == 0:
        raise HTTPException(status_code=404, detail="Channel not found")
    return {"ok": True}


@app.post("/api/admin/channels/{channel_id}/health-check", response_model=AdminApiChannelOut)
async def check_channel_health(channel_id: str, admin: UserOut = Depends(require_admin)) -> AdminApiChannelOut:
    return await perform_channel_health_check(channel_id, admin)


@app.post("/api/admin/channels/{channel_id}/compatibility-check", response_model=AdminApiChannelOut)
async def check_channel_compatibility(channel_id: str, admin: UserOut = Depends(require_admin)) -> AdminApiChannelOut:
    return await perform_channel_compatibility_check(channel_id, admin)


@app.get("/api/admin/audit-logs", response_model=list[AuditLogOut])
def list_audit_logs(limit: int = Query(100, ge=1, le=300), admin: UserOut = Depends(require_admin)) -> list[AuditLogOut]:
    with get_conn() as conn:
        rows = conn.execute(
            "SELECT * FROM audit_logs ORDER BY created_at DESC LIMIT ?",
            (limit,),
        ).fetchall()
    return [row_to_audit_log(row) for row in rows]


@app.get("/api/admin/users", response_model=list[UserOut])
def list_admin_users(admin: UserOut = Depends(require_admin)) -> list[UserOut]:
    del admin
    with get_conn() as conn:
        rows = conn.execute("SELECT * FROM users ORDER BY created_at ASC, username ASC").fetchall()
    return [row_to_user(row) for row in rows]


@app.patch("/api/admin/users/{user_id}/role", response_model=UserOut)
def update_admin_user_role(
    user_id: str,
    payload: UserRolePatchIn,
    admin: UserOut = Depends(require_admin),
) -> UserOut:
    if user_id == admin.id and payload.role != "admin":
        raise HTTPException(status_code=400, detail="不能移除当前登录管理员自己的管理员权限")

    with get_conn() as conn:
        target = conn.execute("SELECT * FROM users WHERE id = ?", (user_id,)).fetchone()
        if not target:
            raise HTTPException(status_code=404, detail="User not found")
        previous_role = str(target["role"])
        if target["role"] == "admin" and payload.role != "admin":
            admin_count = conn.execute(
                "SELECT COUNT(*) AS count FROM users WHERE role = 'admin'"
            ).fetchone()["count"]
            if admin_count <= 1:
                raise HTTPException(status_code=400, detail="系统至少需要保留一个管理员")
        ts = now_ms()
        conn.execute(
            "UPDATE users SET role = ?, updated_at = ? WHERE id = ?",
            (payload.role, ts, user_id),
        )
        row = conn.execute("SELECT * FROM users WHERE id = ?", (user_id,)).fetchone()
        insert_audit_log(
            conn,
            admin,
            "user.role_update",
            "user",
            user_id,
            {
                "username": row["username"],
                "previousRole": previous_role,
                "nextRole": payload.role,
            },
        )
    return row_to_user(row)


@app.get("/api/admin/system/export")
def export_system_backup(admin: UserOut = Depends(require_admin)) -> StreamingResponse:
    archive_bytes = build_server_backup_archive()
    write_audit_log(admin, "system.export", "system_backup", details={"bytes": len(archive_bytes)})
    filename = f"gpt-image-playground-backup-{time.strftime('%Y%m%d-%H%M%S')}.zip"
    return StreamingResponse(
        io.BytesIO(archive_bytes),
        media_type="application/zip",
        headers={"Content-Disposition": f'attachment; filename="{filename}"'},
    )


@app.post("/api/admin/system/import-preview", response_model=SystemBackupPreviewOut)
async def preview_system_backup_import(
    file: UploadFile = File(...),
    admin: UserOut = Depends(require_admin),
) -> SystemBackupPreviewOut:
    del admin
    archive_bytes = await file.read()
    return build_server_backup_preview(archive_bytes)


@app.post("/api/admin/system/import", response_model=SystemBackupImportOut)
async def import_system_backup(
    response: Response,
    file: UploadFile = File(...),
    admin: UserOut = Depends(require_admin),
) -> SystemBackupImportOut:
    archive_bytes = await file.read()
    restore_point_name = create_restore_point()
    restore_server_backup_archive(archive_bytes, response, admin)
    write_audit_log(
        None,
        "system.import",
        "system_backup",
        details={"bytes": len(archive_bytes), "restorePointName": restore_point_name},
    )
    return SystemBackupImportOut(ok=True, restorePointName=restore_point_name)


@app.get("/api/projects", response_model=list[ProjectBoardOut])
def list_projects(user: UserOut = Depends(require_user)) -> list[ProjectBoardOut]:
    with get_conn() as conn:
        rows = conn.execute(
            """
            SELECT
              projects.*,
              (
                SELECT COUNT(*) FROM generation_tasks
                WHERE generation_tasks.project_id = projects.id AND generation_tasks.user_id = projects.user_id
              ) AS task_count,
              (
                SELECT COUNT(*) FROM prompt_templates
                WHERE prompt_templates.project_id = projects.id AND prompt_templates.user_id = projects.user_id
              ) AS template_count
            FROM projects
            WHERE projects.user_id = ?
            ORDER BY projects.is_archived ASC, projects.updated_at DESC
            """,
            (user.id,),
        ).fetchall()
    return [row_to_project(row) for row in rows]


@app.post("/api/projects", response_model=ProjectBoardOut)
def create_project(payload: ProjectBoardIn, user: UserOut = Depends(require_user)) -> ProjectBoardOut:
    project_id = new_id()
    ts = now_ms()
    with get_conn() as conn:
        conn.execute(
            """
            INSERT INTO projects (id, user_id, name, description, color, is_archived, created_at, updated_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?)
            """,
            (
                project_id,
                user.id,
                payload.name.strip(),
                payload.description.strip(),
                payload.color.strip() or "#3b82f6",
                int(payload.isArchived),
                ts,
                ts,
            ),
        )
        row = conn.execute(
            """
            SELECT projects.*, 0 AS task_count, 0 AS template_count
            FROM projects
            WHERE id = ? AND user_id = ?
            """,
            (project_id, user.id),
        ).fetchone()
    return row_to_project(row)


@app.patch("/api/projects/{project_id}", response_model=ProjectBoardOut)
def patch_project(project_id: str, payload: ProjectBoardPatch, user: UserOut = Depends(require_user)) -> ProjectBoardOut:
    data = payload.model_dump(exclude_unset=True)
    with get_conn() as conn:
        row = get_project_row_or_404(conn, project_id, user)
        if not data:
            return row_to_project(
                conn.execute(
                    """
                    SELECT projects.*,
                      (
                        SELECT COUNT(*) FROM generation_tasks
                        WHERE generation_tasks.project_id = projects.id AND generation_tasks.user_id = projects.user_id
                      ) AS task_count,
                      (
                        SELECT COUNT(*) FROM prompt_templates
                        WHERE prompt_templates.project_id = projects.id AND prompt_templates.user_id = projects.user_id
                      ) AS template_count
                    FROM projects WHERE id = ? AND user_id = ?
                    """,
                    (project_id, user.id),
                ).fetchone()
            )
        next_name = payload.name.strip() if payload.name is not None else row["name"]
        next_description = payload.description.strip() if payload.description is not None else row["description"]
        next_color = payload.color.strip() if payload.color is not None else row["color"]
        next_archived = int(payload.isArchived if payload.isArchived is not None else bool(row["is_archived"]))
        ts = now_ms()
        conn.execute(
            """
            UPDATE projects
            SET name = ?, description = ?, color = ?, is_archived = ?, updated_at = ?
            WHERE id = ? AND user_id = ?
            """,
            (next_name, next_description, next_color or "#3b82f6", next_archived, ts, project_id, user.id),
        )
        updated = conn.execute(
            """
            SELECT
              projects.*,
              (
                SELECT COUNT(*) FROM generation_tasks
                WHERE generation_tasks.project_id = projects.id AND generation_tasks.user_id = projects.user_id
              ) AS task_count,
              (
                SELECT COUNT(*) FROM prompt_templates
                WHERE prompt_templates.project_id = projects.id AND prompt_templates.user_id = projects.user_id
              ) AS template_count
            FROM projects
            WHERE projects.id = ? AND projects.user_id = ?
            """,
            (project_id, user.id),
        ).fetchone()
    return row_to_project(updated)


@app.delete("/api/projects/{project_id}")
def delete_project(project_id: str, user: UserOut = Depends(require_user)) -> dict[str, bool]:
    with get_conn() as conn:
        get_project_row_or_404(conn, project_id, user)
        cur = conn.execute("DELETE FROM projects WHERE id = ? AND user_id = ?", (project_id, user.id))
    if cur.rowcount == 0:
        raise HTTPException(status_code=404, detail="Project not found")
    return {"ok": True}


def local_optimize_prompt(prompt: str, negative_prompt: str | None = None) -> str:
    text = re.sub(r"\s+", " ", prompt).strip()
    if not text:
        return ""
    if len(text) > 220 and any(marker in text.lower() for marker in ["composition", "lighting", "style", "背景", "构图", "光线"]):
        return text
    parts = [
        text,
        "明确主体、材质、环境、构图、光线、色彩、镜头和输出用途。",
        "保持画面元素清晰，避免多余文字、水印、畸形手部、低清晰度和过度锐化。",
    ]
    if negative_prompt:
        parts.append(f"避免: {negative_prompt.strip()}")
    return "\n".join(part for part in parts if part)


def extract_responses_text(data: Any) -> str:
    if isinstance(data, dict):
        output_text = data.get("output_text")
        if isinstance(output_text, str) and output_text.strip():
            return output_text.strip()
        output = data.get("output")
        if isinstance(output, list):
            texts: list[str] = []
            for item in output:
                if not isinstance(item, dict):
                    continue
                content = item.get("content")
                if not isinstance(content, list):
                    continue
                for part in content:
                    if isinstance(part, dict):
                        if isinstance(part.get("text"), str):
                            texts.append(part["text"])
                        elif isinstance(part.get("output_text"), str):
                            texts.append(part["output_text"])
            if texts:
                return "\n".join(texts).strip()
    return ""


@app.post("/api/prompts/optimize", response_model=PromptOptimizeOut)
async def optimize_prompt(payload: PromptOptimizeIn, user: UserOut = Depends(require_user)) -> PromptOptimizeOut:
    raw_prompt = payload.prompt.strip()
    if not raw_prompt:
        raise HTTPException(status_code=400, detail="Prompt is required")

    channel_id = payload.channelId or ""
    model_id = payload.model or ""
    if channel_id and model_id:
        try:
            channel_row, selected_model = get_enabled_channel_model(channel_id, model_id)
            if selected_model.apiMode == "responses":
                api_key = (channel_row["api_key"] or "").strip()
                base_url = normalize_base_url(channel_row["base_url"])
                timeout = min(float(channel_row["timeout_seconds"] or settings.request_timeout_seconds), 45.0)
                request_body = {
                    "model": selected_model.id,
                    "input": (
                        "Rewrite the following as a strong image-generation prompt. "
                        "Preserve the user's intent, concrete subject, language, and constraints. "
                        "Return only the improved prompt, no markdown.\n\n"
                        f"Prompt:\n{raw_prompt}\n\n"
                        f"Negative prompt:\n{payload.negativePrompt or ''}"
                    ),
                }
                async with httpx.AsyncClient(timeout=timeout) as client:
                    response = await client.post(
                        endpoint_url(base_url, "responses"),
                        headers={"Authorization": f"Bearer {api_key}", "Content-Type": "application/json"},
                        json=request_body,
                    )
                    response.raise_for_status()
                optimized = extract_responses_text(response.json())
                if optimized:
                    return PromptOptimizeOut(prompt=optimized[:8000], method="responses", changed=optimized.strip() != raw_prompt)
        except Exception:
            pass

    optimized = local_optimize_prompt(raw_prompt, payload.negativePrompt)
    return PromptOptimizeOut(prompt=optimized, method="local", changed=optimized != raw_prompt)


@app.get("/api/templates", response_model=list[PromptTemplateOut])
def list_templates(scope: str = Query("all"), user: UserOut = Depends(require_user)) -> list[PromptTemplateOut]:
    with get_conn() as conn:
        if scope == "mine":
            rows = conn.execute(
                "SELECT * FROM prompt_templates WHERE user_id = ? ORDER BY updated_at DESC",
                (user.id,),
            ).fetchall()
        elif scope == "public":
            rows = conn.execute(
                """
                SELECT * FROM prompt_templates
                WHERE visibility = 'public' AND submission_status = 'approved'
                ORDER BY updated_at DESC
                """,
            ).fetchall()
        elif scope == "submissions":
            if user.role != "admin":
                raise HTTPException(status_code=403, detail="Admin privileges required")
            rows = conn.execute(
                "SELECT * FROM prompt_templates WHERE submission_status = 'submitted' ORDER BY submitted_at DESC, updated_at DESC",
            ).fetchall()
        else:
            rows = conn.execute(
                """
                SELECT * FROM prompt_templates
                WHERE user_id = ? OR (visibility = 'public' AND submission_status = 'approved')
                ORDER BY updated_at DESC
                """,
                (user.id,),
            ).fetchall()
    return [row_to_template(row) for row in rows]


def pick_default_template_target() -> tuple[str, ChannelModel]:
    with get_conn() as conn:
        rows = conn.execute(
            "SELECT * FROM api_channels WHERE is_enabled = 1 ORDER BY updated_at DESC",
        ).fetchall()
    for row in rows:
        channel = row_to_channel(row)
        for model in channel.models:
            if model.enabled:
                return channel.id, model
    raise HTTPException(status_code=400, detail="No enabled channel/model is available for imported templates")


def github_raw_url(source: OpenPromptSource, src: str) -> str:
    value = src.strip()
    if value.startswith("http://") or value.startswith("https://"):
        return value
    return urljoin(source.raw_base_url, value.removeprefix("./").lstrip("/"))


def iter_markdown_h3_sections(markdown: str) -> list[tuple[str, str]]:
    headings = list(re.finditer(r"^###\s+(?P<title>.+?)\s*$", markdown, re.MULTILINE))
    sections: list[tuple[str, str]] = []
    for index, match in enumerate(headings):
        start = match.end()
        end = headings[index + 1].start() if index + 1 < len(headings) else len(markdown)
        sections.append((match.group("title").strip(), markdown[start:end]))
    return sections


def markdown_links(text: str) -> list[tuple[str, str]]:
    return [(label.strip(), url.strip()) for label, url in re.findall(r"\[([^\]]+)\]\(([^)]+)\)", text)]


def extract_prompt_image(source: OpenPromptSource, body: str) -> str:
    images: list[tuple[str, str]] = []
    for match in re.finditer(r"<img\b(?P<attrs>[^>]*)>", body, re.IGNORECASE):
        attrs = match.group("attrs")
        src_match = re.search(r'\bsrc="(?P<src>[^"]+)"', attrs, re.IGNORECASE)
        if not src_match:
            continue
        alt_match = re.search(r'\balt="(?P<alt>[^"]*)"', attrs, re.IGNORECASE)
        images.append((alt_match.group("alt") if alt_match else attrs, src_match.group("src")))
    images.extend((alt, src) for alt, src in re.findall(r"!\[([^\]]*)\]\(([^)]+)\)", body))
    if not images:
        return ""
    preferred = next((src for label, src in images if "gpt" in label.lower()), None)
    if not preferred and "nano banana" in body.lower() and "gpt-image" in body.lower() and len(images) > 1:
        preferred = images[-1][1]
    return github_raw_url(source, preferred or images[0][1])


def source_author_from_links(links: list[tuple[str, str]]) -> str:
    if not links:
        return ""
    label = next((label for label, _ in links if label.strip().startswith("@")), links[-1][0])
    return re.sub(r"\s+", " ", label).strip()


def normalize_example_images(values: list[str] | None) -> list[str]:
    seen: set[str] = set()
    images: list[str] = []
    for raw in values or []:
        value = str(raw or "").strip()
        if not value or value in seen:
            continue
        seen.add(value)
        images.append(value)
    return images[:12]


def template_variable_count(prompt: str, negative_prompt: str | None = None) -> int:
    text = f"{prompt}\n{negative_prompt or ''}"
    names = set(match.strip() for match in re.findall(r"\{\{\s*([^{}]+?)\s*\}\}", text) if match.strip())
    for attrs_text in re.findall(r"\{argument\s+([^{}]+)\}", text):
        name = ""
        for parts in re.findall(r"([a-zA-Z_][\w-]*)\s*=\s*(?:\"([^\"]*)\"|'([^']*)'|([^\s}]+))", attrs_text):
            if parts[0] in {"name", "label"}:
                name = next((part for part in parts[1:] if part), "")
                break
        if name.strip():
            names.add(name.strip())
    for raw in re.findall(r"\[([^\]\n]{2,48})\]", text):
        value = raw.strip()
        if value and not re.match(r"^\d+$", value):
            names.add(value)
    return len(names)


def calculate_template_quality(
    title: str,
    prompt: str,
    tags: list[str],
    category: str,
    cover_image_id: str | None,
    external_cover_url: str | None,
    example_images: list[str],
    source_name: str,
    negative_prompt: str | None = None,
    usage_count: int = 0,
    favorite_count: int = 0,
    success_count: int = 0,
    failure_count: int = 0,
    rating_total: int = 0,
    rating_count: int = 0,
) -> float:
    score = 20.0
    prompt_len = len(prompt.strip())
    if prompt_len >= 120:
        score += 16
    elif prompt_len >= 60:
        score += 9
    if prompt_len <= 4000:
        score += 7
    if title.strip() and len(title.strip()) <= 80:
        score += 6
    if category.strip():
        score += 6
    score += min(len(tags), 6) * 2
    if cover_image_id or external_cover_url:
        score += 8
    if example_images:
        score += min(len(example_images), 6) * 2
    if source_name.strip():
        score += 4
    if negative_prompt:
        score += 2
    score += min(template_variable_count(prompt, negative_prompt), 6) * 1.5

    total_generations = max(0, success_count) + max(0, failure_count)
    if total_generations:
        score += (max(0, success_count) / total_generations) * 14
        score += min(max(0, success_count), 12) * 0.45
    score += min(max(0, usage_count), 40) / 40 * 7
    score += min(max(0, favorite_count), 20) / 20 * 5
    if rating_count > 0:
        score += (max(0, rating_total) / rating_count) / 5 * 12
        score += min(rating_count, 10) / 10 * 2
    return round(max(0.0, min(score, 100.0)), 1)


def quality_for_payload(payload: PromptTemplateIn | PromptTemplateOut) -> float:
    return calculate_template_quality(
        payload.title,
        payload.prompt,
        payload.tags,
        payload.category,
        payload.coverImageId,
        payload.externalCoverUrl,
        normalize_example_images(payload.exampleImages),
        payload.sourceName,
        payload.negativePrompt,
        payload.usageCount if isinstance(payload, PromptTemplateOut) else 0,
        payload.favoriteCount if isinstance(payload, PromptTemplateOut) else 0,
        payload.successCount if isinstance(payload, PromptTemplateOut) else 0,
        payload.failureCount if isinstance(payload, PromptTemplateOut) else 0,
        int((payload.averageRating if isinstance(payload, PromptTemplateOut) else 0) * (payload.ratingCount if isinstance(payload, PromptTemplateOut) else 0)),
        payload.ratingCount if isinstance(payload, PromptTemplateOut) else 0,
    )


def recalculate_template_quality(conn: Any, template_id: str) -> None:
    row = conn.execute("SELECT * FROM prompt_templates WHERE id = ?", (template_id,)).fetchone()
    if not row:
        return
    score = calculate_template_quality(
        row["title"],
        row["prompt"],
        json_loads(row["tags_json"], []),
        row["category"],
        row["cover_image_id"],
        row["external_cover_url"] if "external_cover_url" in row.keys() else None,
        normalize_example_images(json_loads(row["example_images_json"] if "example_images_json" in row.keys() else None, [])),
        row["source_name"] if "source_name" in row.keys() else "",
        row["negative_prompt"],
        int(row["usage_count"] or 0),
        int(row["favorite_count"] or 0),
        int(row["success_count"] if "success_count" in row.keys() and row["success_count"] is not None else 0),
        int(row["failure_count"] if "failure_count" in row.keys() and row["failure_count"] is not None else 0),
        int(row["rating_total"] if "rating_total" in row.keys() and row["rating_total"] is not None else 0),
        int(row["rating_count"] if "rating_count" in row.keys() and row["rating_count"] is not None else 0),
    )
    conn.execute("UPDATE prompt_templates SET quality_score = ? WHERE id = ?", (score, template_id))


def snapshot_template_version(conn: Any, template_id: str, actor: UserOut | None = None) -> None:
    row = conn.execute("SELECT * FROM prompt_templates WHERE id = ?", (template_id,)).fetchone()
    if not row:
        return
    snapshot = row_to_template(row).model_dump()
    conn.execute(
        """
        INSERT OR REPLACE INTO prompt_template_versions (id, template_id, version, snapshot_json, created_by, created_at)
        VALUES (
          COALESCE((SELECT id FROM prompt_template_versions WHERE template_id = ? AND version = ?), ?),
          ?, ?, ?, ?, ?
        )
        """,
        (
            template_id,
            row["version"],
            new_id(),
            template_id,
            row["version"],
            json_dumps(snapshot),
            actor.id if actor else row["user_id"],
            now_ms(),
        ),
    )


def open_prompt_item_key(source: OpenPromptSource, item: dict[str, str | list[str]]) -> str:
    raw = "\0".join(
        [
            source.id,
            str(item.get("title") or ""),
            str(item.get("sourceAuthor") or ""),
            str(item.get("sourceUrl") or ""),
        ]
    )
    return hashlib.sha1(raw.encode("utf-8")).hexdigest()[:18]


def normalize_open_prompt_item(source: OpenPromptSource, item: dict[str, str | list[str]]) -> dict[str, Any]:
    image = str(item.get("image") or "")
    tags = [str(tag) for tag in item.get("tags", [])]
    example_images = normalize_example_images([image] if image else [])
    quality_score = calculate_template_quality(
        str(item.get("title") or ""),
        str(item.get("prompt") or ""),
        tags,
        str(item.get("category") or ""),
        None,
        image or None,
        example_images,
        source.source_name,
    )
    return {
        "key": open_prompt_item_key(source, item),
        "title": str(item.get("title") or "").strip(),
        "prompt": str(item.get("prompt") or "").strip(),
        "image": image,
        "exampleImages": example_images,
        "sourceUrl": str(item.get("sourceUrl") or "").strip(),
        "sourceAuthor": str(item.get("sourceAuthor") or "").strip(),
        "sourceName": source.source_name,
        "licenseName": source.license_name,
        "category": str(item.get("category") or "").strip(),
        "tags": tags,
        "qualityScore": quality_score,
    }


async def fetch_open_prompt_items(source: OpenPromptSource, limit: int) -> list[dict[str, Any]]:
    try:
        async with httpx.AsyncClient(timeout=30) as client:
            response = await client.get(source.readme_url)
            response.raise_for_status()
    except httpx.HTTPError as exc:
        raise HTTPException(status_code=502, detail=f"Failed to fetch open prompt source: {compact_message(exc)}") from exc
    parsed = [normalize_open_prompt_item(source, item) for item in source.parser(source, response.text)]
    return parsed if limit <= 0 else parsed[:limit]


def open_prompt_duplicate_marker(item: dict[str, Any]) -> tuple[str, str]:
    return (
        str(item.get("sourceUrl") or "").strip(),
        f"{str(item.get('title') or '')}\0{str(item.get('sourceAuthor') or '')}",
    )


def open_prompt_exists(conn: Any, prompt_source: OpenPromptSource, item: dict[str, Any]) -> Any:
    source_url, _ = open_prompt_duplicate_marker(item)
    if source_url:
        exists = conn.execute(
            """
            SELECT id FROM prompt_templates
            WHERE source_name = ? AND source_url = ?
            """,
            (prompt_source.source_name, source_url),
        ).fetchone()
        if exists:
            return exists
    return conn.execute(
        """
        SELECT id FROM prompt_templates
        WHERE source_name = ? AND title = ? AND source_author = ?
        """,
        (prompt_source.source_name, item["title"], item["sourceAuthor"]),
    ).fetchone()


def infer_template_category(section: str, title: str) -> str:
    text = f"{section} {title}".lower()
    if "e-commerce" in text or "product" in text:
        return "product"
    if "portrait" in text:
        return "portrait"
    if "character" in text:
        return "character"
    if "logo" in text or "brand" in text:
        return "brand"
    if "ui" in text:
        return "ui"
    if "ad" in text or "poster" in text:
        return "poster"
    if "anime" in text:
        return "anime"
    if "food" in text:
        return "food"
    if "landscape" in text:
        return "landscape"
    return "inspiration"


def infer_template_tags(section: str, title: str, prompt: str) -> list[str]:
    text = f"{section} {title} {prompt}".lower()
    rules = {
        "product": ["product", "e-commerce", "skincare", "perfume", "bottle", "shoes", "watch"],
        "poster": ["poster", "ad ", "advertising", "flyer", "banner", "campaign"],
        "ui": ["ui", "interface", "dashboard", "mockup", "app"],
        "photo": ["photo", "photography", "photorealistic", "studio", "cinematic"],
        "3d": ["3d", "cgi", "render", "diorama", "unreal"],
        "portrait": ["portrait", "headshot", "face"],
        "character": ["character", "mascot", "sheet"],
        "anime": ["anime", "manga"],
        "logo": ["logo", "brand identity", "branding"],
        "illustration": ["illustration", "illustrated", "drawing"],
        "food": ["food", "burger", "drink", "soda"],
        "infographic": ["infographic", "feature list", "icons"],
        "fashion": ["fashion", "streetwear", "sneaker", "loafers"],
    }
    tags = [tag for tag, needles in rules.items() if any(needle in text for needle in needles)]
    return tags[:6] or ["inspiration"]


def parse_evolink_prompt_readme(source: OpenPromptSource, markdown: str) -> list[dict[str, str | list[str]]]:
    items: list[dict[str, str | list[str]]] = []
    section_pattern = re.compile(r"^##\s+(?P<section>.+?)\s*$", re.MULTILINE)
    sections = list(section_pattern.finditer(markdown))

    for index, section_match in enumerate(sections):
        section = section_match.group("section").strip()
        if section.lower() in {"introduction", "news", "📑 menu"}:
            continue
        start = section_match.end()
        end = sections[index + 1].start() if index + 1 < len(sections) else len(markdown)
        body = markdown[start:end]
        case_pattern = re.compile(
            r"^###\s+Case\s+(?P<case>\d+):\s+\[(?P<title>[^\]]+)\]\((?P<source_url>[^)]+)\)\s+\(by\s+\[@(?P<author>[^\]]+)\]\([^)]+\)\)",
            re.MULTILINE,
        )
        case_matches = list(case_pattern.finditer(body))
        for case_index, case_match in enumerate(case_matches):
            case_start = case_match.end()
            case_end = case_matches[case_index + 1].start() if case_index + 1 < len(case_matches) else len(body)
            case_body = body[case_start:case_end]
            prompt_match = re.search(r"\*\*Prompt:\*\*\s*```[^\n]*\n(?P<prompt>[\s\S]*?)```", case_body)
            image_match = re.search(r'<img\s+src="(?P<src>[^"]+)"', case_body)
            if not prompt_match:
                continue
            prompt = prompt_match.group("prompt").strip()
            title = case_match.group("title").strip()
            items.append(
                {
                    "title": title,
                    "prompt": prompt[:4000],
                    "image": github_raw_url(source, image_match.group("src")) if image_match else "",
                    "sourceUrl": case_match.group("source_url").strip(),
                    "sourceAuthor": f"@{case_match.group('author').strip()}",
                    "category": infer_template_category(section, title),
                    "tags": infer_template_tags(section, title, prompt),
                }
            )
    return items


def parse_zerolu_prompt_readme(source: OpenPromptSource, markdown: str) -> list[dict[str, str | list[str]]]:
    items: list[dict[str, str | list[str]]] = []
    for title, body in iter_markdown_h3_sections(markdown):
        prompt_match = re.search(r"\*\*Prompt:\*\*\s*```[^\n]*\n(?P<prompt>[\s\S]*?)```", body)
        if not prompt_match:
            continue
        source_line = re.search(r"(?:\*\*Source:\*\*|\*Source:)\s*(?P<source>.+?)(?:\n|$)", body)
        links = markdown_links(source_line.group("source").strip().strip("*")) if source_line else []
        source_url = links[0][1] if links else source.repo_url
        source_author = source_author_from_links(links)
        prompt = prompt_match.group("prompt").strip()
        items.append(
            {
                "title": title,
                "prompt": prompt[:4000],
                "image": extract_prompt_image(source, body),
                "sourceUrl": source_url,
                "sourceAuthor": source_author,
                "category": infer_template_category("gpt image", title),
                "tags": infer_template_tags("gpt image", title, prompt),
            }
        )
    return items


def parse_imgedify_prompt_readme(source: OpenPromptSource, markdown: str) -> list[dict[str, str | list[str]]]:
    items: list[dict[str, str | list[str]]] = []
    for title, body in iter_markdown_h3_sections(markdown):
        if title.lower() == "table of contents":
            continue
        prompt_match = re.search(
            r"-\s+\*\*Prompt Text:\*\*\s*`(?P<inline>[\s\S]*?)`\s*\n-\s+\*\*Example Image:\*\*",
            body,
        )
        if not prompt_match:
            prompt_match = re.search(r"-\s+\*\*Prompt Text:\*\*\s*```[^\n]*\n(?P<fenced>[\s\S]*?)```", body)
        if not prompt_match:
            continue
        prompt = (prompt_match.groupdict().get("inline") or prompt_match.groupdict().get("fenced") or "").strip()
        author_line = re.search(r"-\s+\*\*Author:\*\*\s*(?P<author>.+?)(?:\n|$)", body)
        links = markdown_links(author_line.group("author")) if author_line else []
        source_url = links[0][1] if links else source.repo_url
        source_author = source_author_from_links(links)
        tags = infer_template_tags("gpt4o image", title, prompt)
        if "gpt4o" not in tags:
            tags = [*tags, "gpt4o"][:6]
        items.append(
            {
                "title": title,
                "prompt": prompt[:4000],
                "image": extract_prompt_image(source, body),
                "sourceUrl": source_url,
                "sourceAuthor": source_author,
                "category": infer_template_category("gpt4o image", title),
                "tags": tags,
            }
        )
    return items


def clean_markdown_title(value: str) -> str:
    title = re.sub(r"<[^>]+>", "", value)
    title = re.sub(r"[*_`#\[\]]+", "", title)
    title = re.sub(r"\s+", " ", title).strip(" -:|")
    return title[:120]


def iter_markdown_heading_sections(markdown: str) -> list[tuple[str, str]]:
    headings = list(re.finditer(r"^(?P<level>#{2,4})\s+(?P<title>.+?)\s*$", markdown, re.MULTILINE))
    sections: list[tuple[str, str]] = []
    for index, match in enumerate(headings):
        start = match.end()
        end = headings[index + 1].start() if index + 1 < len(headings) else len(markdown)
        sections.append((clean_markdown_title(match.group("title")), markdown[start:end]))
    return sections


def extract_generic_prompt_text(body: str) -> str:
    patterns = [
        r"(?:\*\*)?\s*Prompt(?:\s+Text)?\s*(?:\*\*)?\s*[:：]\s*```[^\n]*\n(?P<prompt>[\s\S]*?)```",
        r"(?:\*\*)?\s*提示词\s*(?:\*\*)?\s*[:：]\s*```[^\n]*\n(?P<prompt>[\s\S]*?)```",
        r"(?:\*\*)?\s*Prompt(?:\s+Text)?\s*(?:\*\*)?\s*[:：]\s*`(?P<inline>[^`]{40,})`",
        r"(?:\*\*)?\s*提示词\s*(?:\*\*)?\s*[:：]\s*`(?P<inline_zh>[^`]{20,})`",
    ]
    for pattern in patterns:
        match = re.search(pattern, body, re.IGNORECASE)
        if match:
            prompt = next((value for value in match.groupdict().values() if value), "")
            if prompt.strip():
                return prompt.strip()

    code_blocks = re.findall(r"```(?:text|prompt|markdown|md)?\s*\n([\s\S]*?)```", body, re.IGNORECASE)
    for block in code_blocks:
        prompt = block.strip()
        if len(prompt) >= 50 and not re.search(r"\b(npm|pip|git clone|import |function |const )\b", prompt[:300], re.IGNORECASE):
            return prompt

    quote_lines = [line[1:].strip() for line in body.splitlines() if line.strip().startswith(">")]
    quote = "\n".join(line for line in quote_lines if line)
    if len(quote) >= 80 and re.search(r"\b(image|photo|render|style|scene|composition|lighting)\b", quote, re.IGNORECASE):
        return quote

    return ""


def parse_generic_prompt_readme(source: OpenPromptSource, markdown: str) -> list[dict[str, str | list[str]]]:
    items: list[dict[str, str | list[str]]] = []
    skip_titles = {"table of contents", "license", "installation", "usage", "intro", "introduction", "contributing"}
    for title, body in iter_markdown_heading_sections(markdown):
        if not title or title.lower() in skip_titles:
            continue
        prompt = extract_generic_prompt_text(body)
        if not prompt:
            continue
        links = markdown_links(body)
        source_url = next((url for _, url in links if url.startswith("http")), source.repo_url)
        source_author = source_author_from_links(links)
        items.append(
            {
                "title": title,
                "prompt": prompt[:4000],
                "image": extract_prompt_image(source, body),
                "sourceUrl": source_url,
                "sourceAuthor": source_author,
                "category": infer_template_category("gpt image", title),
                "tags": infer_template_tags("gpt image", title, prompt),
            }
        )
        if len(items) >= 300:
            break
    return items


OPEN_PROMPT_SOURCES: dict[str, OpenPromptSource] = {
    "evolink": OpenPromptSource(
        id="evolink",
        label="EvoLinkAI",
        readme_url="https://raw.githubusercontent.com/EvoLinkAI/awesome-gpt-image-2-prompts/main/README.md",
        repo_url="https://github.com/EvoLinkAI/awesome-gpt-image-2-prompts",
        raw_base_url="https://raw.githubusercontent.com/EvoLinkAI/awesome-gpt-image-2-prompts/main/",
        source_name="EvoLinkAI awesome-gpt-image-2-prompts",
        license_name="README: CC BY 4.0; repository LICENSE: Apache-2.0",
        parser=parse_evolink_prompt_readme,
    ),
    "zerolu": OpenPromptSource(
        id="zerolu",
        label="ZeroLu GPT Image",
        readme_url="https://raw.githubusercontent.com/ZeroLu/awesome-gpt-image/main/README.md",
        repo_url="https://github.com/ZeroLu/awesome-gpt-image",
        raw_base_url="https://raw.githubusercontent.com/ZeroLu/awesome-gpt-image/main/",
        source_name="ZeroLu awesome-gpt-image",
        license_name="MIT",
        parser=parse_zerolu_prompt_readme,
    ),
    "imgedify": OpenPromptSource(
        id="imgedify",
        label="ImgEdify GPT4o Prompts",
        readme_url="https://raw.githubusercontent.com/ImgEdify/Awesome-GPT4o-Image-Prompts/main/README.md",
        repo_url="https://github.com/ImgEdify/Awesome-GPT4o-Image-Prompts",
        raw_base_url="https://raw.githubusercontent.com/ImgEdify/Awesome-GPT4o-Image-Prompts/main/",
        source_name="ImgEdify Awesome-GPT4o-Image-Prompts",
        license_name="MIT",
        parser=parse_imgedify_prompt_readme,
    ),
}


def upsert_open_prompt_items(
    prompt_source: OpenPromptSource,
    parsed: list[dict[str, Any]],
    actor: UserOut,
    *,
    visibility: str,
    submission_status: str,
    description_prefix: str,
) -> dict[str, int]:
    channel_id, model = pick_default_template_target()
    ts = now_ms()
    created = 0
    skipped = 0
    updated = 0
    submitted = 0
    approved = 0
    submitted_at = ts if submission_status == "submitted" else None
    reviewed_at = ts if submission_status == "approved" else None
    reviewed_by = actor.id if submission_status == "approved" else None

    with get_conn() as conn:
        for item in parsed:
            image = str(item["image"])
            example_images = normalize_example_images(item["exampleImages"])
            tags = [str(tag) for tag in item["tags"]]
            quality_score = float(item["qualityScore"])
            exists = open_prompt_exists(conn, prompt_source, item)
            if exists:
                cur = conn.execute(
                    """
                    UPDATE prompt_templates SET
                      external_cover_url = ?,
                      example_images_json = ?,
                      recommended_channel_id = ?,
                      recommended_api_mode = ?,
                      recommended_model = ?,
                      source_url = ?,
                      license_name = ?,
                      quality_score = ?,
                      updated_at = ?
                    WHERE id = ?
                      AND (
                        COALESCE(external_cover_url, '') != ?
                        OR COALESCE(example_images_json, '[]') != ?
                        OR COALESCE(recommended_channel_id, '') != ?
                        OR COALESCE(recommended_api_mode, '') != ?
                        OR COALESCE(recommended_model, '') != ?
                        OR COALESCE(source_url, '') != ?
                        OR COALESCE(license_name, '') != ?
                        OR COALESCE(quality_score, 0) != ?
                      )
                    """,
                    (
                        image,
                        json_dumps(example_images),
                        channel_id,
                        model.apiMode,
                        model.id,
                        item["sourceUrl"],
                        prompt_source.license_name,
                        quality_score,
                        ts,
                        exists["id"],
                        image,
                        json_dumps(example_images),
                        channel_id,
                        model.apiMode,
                        model.id,
                        item["sourceUrl"],
                        prompt_source.license_name,
                        quality_score,
                    ),
                )
                if cur.rowcount:
                    recalculate_template_quality(conn, exists["id"])
                    snapshot_template_version(conn, exists["id"], actor)
                    updated += 1
                else:
                    skipped += 1
                continue

            template_id = new_id()
            conn.execute(
                """
                INSERT INTO prompt_templates (
                  id, user_id, title, description, prompt, negative_prompt, tags_json, category,
                  params_json, channel_id, api_mode, model, cover_image_id, external_cover_url,
                  linked_task_ids_json, is_favorite, source_name, source_url, source_author, license_name,
                  visibility, submission_status, submitted_at, reviewed_at, reviewed_by, version, created_at, updated_at
                ) VALUES (?, ?, ?, ?, ?, NULL, ?, ?, ?, ?, ?, ?, NULL, ?, '[]', 0, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?)
                """,
                (
                    template_id,
                    actor.id,
                    item["title"],
                    f"{description_prefix} {prompt_source.label}.",
                    item["prompt"],
                    json_dumps(tags),
                    item["category"],
                    TaskParams().model_dump_json(),
                    channel_id,
                    model.apiMode,
                    model.id,
                    image,
                    prompt_source.source_name,
                    item["sourceUrl"],
                    item["sourceAuthor"],
                    prompt_source.license_name,
                    visibility,
                    submission_status,
                    submitted_at,
                    reviewed_at,
                    reviewed_by,
                    ts,
                    ts,
                ),
            )
            conn.execute(
                """
                UPDATE prompt_templates SET
                  example_images_json = ?,
                  recommended_channel_id = ?,
                  recommended_api_mode = ?,
                  recommended_model = ?,
                  quality_score = ?
                WHERE id = ?
                """,
                (json_dumps(example_images), channel_id, model.apiMode, model.id, quality_score, template_id),
            )
            recalculate_template_quality(conn, template_id)
            snapshot_template_version(conn, template_id, actor)
            created += 1
            if submission_status == "submitted":
                submitted += 1
            if submission_status == "approved":
                approved += 1

    return {
        "created": created,
        "updated": updated,
        "skipped": skipped,
        "submitted": submitted,
        "approved": approved,
    }


def repository_source_id(repo_name: str) -> str:
    value = re.sub(r"[^a-z0-9]+", "-", repo_name.lower()).strip("-")
    return f"github-{value[:80]}" if value else f"github-{new_id()}"


def repository_hot_score(stars: int, forks: int, prompt_count: int, license_name: str, updated_at: str = "") -> float:
    recency_bonus = 0.0
    if updated_at:
        try:
            updated = time.mktime(time.strptime(updated_at[:19], "%Y-%m-%dT%H:%M:%S"))
            age_days = max(0.0, (time.time() - updated) / 86400)
            if age_days <= 30:
                recency_bonus = 40
            elif age_days <= 180:
                recency_bonus = 20
            elif age_days <= 365:
                recency_bonus = 8
        except ValueError:
            recency_bonus = 0.0
    license_bonus = 8 if license_name else 0
    return round(max(0.0, stars + forks * 2 + prompt_count * 2.5 + recency_bonus + license_bonus), 1)


def github_headers(github_token: str) -> dict[str, str]:
    headers = {"Accept": "application/vnd.github+json", "User-Agent": "gpt-image-playground"}
    if github_token.strip():
        headers["Authorization"] = f"Bearer {github_token.strip()}"
    return headers


async def fetch_github_readme(
    client: httpx.AsyncClient,
    full_name: str,
    default_branch: str,
) -> tuple[str, str, str] | None:
    branch = default_branch or "main"
    raw_base_url = f"https://raw.githubusercontent.com/{full_name}/{branch}/"
    for filename in ("README.md", "readme.md", "README.MD"):
        readme_url = urljoin(raw_base_url, filename)
        try:
            response = await client.get(readme_url)
            if response.status_code == 200 and response.text.strip():
                return readme_url, raw_base_url, response.text
        except httpx.HTTPError:
            continue
    return None


def upsert_open_prompt_discovery(candidate: dict[str, Any], status: str, message: str, imported_at: int | None = None) -> None:
    ts = now_ms()
    with get_conn() as conn:
        existing = conn.execute(
            "SELECT id FROM open_prompt_discoveries WHERE repo_url = ?",
            (candidate["repoUrl"],),
        ).fetchone()
        discovery_id = existing["id"] if existing else new_id()
        if existing:
            conn.execute(
                """
                UPDATE open_prompt_discoveries SET
                  source_id = ?, label = ?, description = ?, stars = ?, forks = ?, hot_score = ?,
                  prompt_count = ?, license_name = ?, last_seen_at = ?,
                  last_imported_at = COALESCE(?, last_imported_at), last_status = ?, last_message = ?
                WHERE id = ?
                """,
                (
                    candidate["source"].id,
                    candidate["label"],
                    candidate.get("description", ""),
                    int(candidate.get("stars", 0)),
                    int(candidate.get("forks", 0)),
                    float(candidate.get("hotScore", 0)),
                    int(candidate.get("promptCount", 0)),
                    candidate.get("licenseName", ""),
                    ts,
                    imported_at,
                    status,
                    compact_message(message),
                    discovery_id,
                ),
            )
        else:
            conn.execute(
                """
                INSERT INTO open_prompt_discoveries (
                  id, source_id, label, repo_url, description, stars, forks, hot_score,
                  prompt_count, license_name, last_seen_at, last_imported_at, last_status, last_message
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                """,
                (
                    discovery_id,
                    candidate["source"].id,
                    candidate["label"],
                    candidate["repoUrl"],
                    candidate.get("description", ""),
                    int(candidate.get("stars", 0)),
                    int(candidate.get("forks", 0)),
                    float(candidate.get("hotScore", 0)),
                    int(candidate.get("promptCount", 0)),
                    candidate.get("licenseName", ""),
                    ts,
                    imported_at,
                    status,
                    compact_message(message),
                ),
            )


async def discover_known_open_prompt_sources(settings_data: dict[str, Any]) -> list[dict[str, Any]]:
    if not settings_data.get("includeKnownSources"):
        return []
    candidates: list[dict[str, Any]] = []
    per_source_limit = max(1, int(settings_data.get("maxTemplatesPerRun") or 80))
    for source in OPEN_PROMPT_SOURCES.values():
        try:
            items = await fetch_open_prompt_items(source, per_source_limit)
        except HTTPException as exc:
            candidate = {
                "source": source,
                "label": source.label,
                "repoUrl": source.repo_url,
                "description": "内置开源提示词库",
                "stars": 0,
                "forks": 0,
                "hotScore": 0,
                "promptCount": 0,
                "licenseName": source.license_name,
                "items": [],
            }
            upsert_open_prompt_discovery(candidate, "error", str(exc.detail))
            continue
        candidate = {
            "source": source,
            "label": source.label,
            "repoUrl": source.repo_url,
            "description": "内置开源提示词库",
            "stars": 0,
            "forks": 0,
            "hotScore": round(250 + len(items) * 2.5, 1),
            "promptCount": len(items),
            "licenseName": source.license_name,
            "items": items,
        }
        upsert_open_prompt_discovery(candidate, "discovered", f"发现 {len(items)} 个模板")
        candidates.append(candidate)
    return candidates


async def discover_github_open_prompt_sources(settings_data: dict[str, Any], github_token: str) -> list[dict[str, Any]]:
    queries = settings_data.get("searchQueries") or DEFAULT_AUTO_IMPORT_SETTINGS["searchQueries"]
    max_repositories = int(settings_data.get("maxRepositories") or 12)
    headers = github_headers(github_token)
    candidates: list[dict[str, Any]] = []
    seen_repos: set[str] = set()
    per_query = max(5, min(20, max_repositories * 2))

    async with httpx.AsyncClient(timeout=30) as client:
        for query in queries:
            search_url = (
                "https://api.github.com/search/repositories"
                f"?q={quote_plus(f'{query} in:name,description,readme')}&sort=stars&order=desc&per_page={per_query}"
            )
            try:
                response = await client.get(search_url, headers=headers)
                response.raise_for_status()
                repos = response.json().get("items", [])
            except (httpx.HTTPError, ValueError):
                continue

            for repo in repos:
                full_name = str(repo.get("full_name") or "").strip()
                repo_url = str(repo.get("html_url") or "").strip()
                if not full_name or not repo_url:
                    continue
                repo_key = full_name.lower()
                if repo_key in seen_repos:
                    continue
                seen_repos.add(repo_key)
                readme = await fetch_github_readme(client, full_name, str(repo.get("default_branch") or "main"))
                if not readme:
                    continue
                readme_url, raw_base_url, markdown = readme
                license_info = repo.get("license") if isinstance(repo.get("license"), dict) else {}
                license_name = str(license_info.get("spdx_id") or license_info.get("name") or "").strip()
                source = OpenPromptSource(
                    id=repository_source_id(full_name),
                    label=full_name,
                    readme_url=readme_url,
                    repo_url=repo_url,
                    raw_base_url=raw_base_url,
                    source_name=f"GitHub {full_name}",
                    license_name=license_name,
                    parser=parse_generic_prompt_readme,
                )
                parsed = [normalize_open_prompt_item(source, item) for item in source.parser(source, markdown)]
                if not parsed:
                    continue
                stars = int(repo.get("stargazers_count") or 0)
                forks = int(repo.get("forks_count") or 0)
                hot_score = repository_hot_score(stars, forks, len(parsed), license_name, str(repo.get("pushed_at") or repo.get("updated_at") or ""))
                candidate = {
                    "source": source,
                    "label": full_name,
                    "repoUrl": repo_url,
                    "description": str(repo.get("description") or ""),
                    "stars": stars,
                    "forks": forks,
                    "hotScore": hot_score,
                    "promptCount": len(parsed),
                    "licenseName": license_name,
                    "items": parsed,
                }
                upsert_open_prompt_discovery(candidate, "discovered", f"发现 {len(parsed)} 个模板")
                candidates.append(candidate)
                if len(candidates) >= max_repositories * 3:
                    return candidates
    return candidates


async def discover_auto_import_candidates(settings_data: dict[str, Any], github_token: str) -> list[dict[str, Any]]:
    known, github = await asyncio.gather(
        discover_known_open_prompt_sources(settings_data),
        discover_github_open_prompt_sources(settings_data, github_token),
    )
    deduped: dict[str, dict[str, Any]] = {}
    for candidate in [*known, *github]:
        repo_key = normalize_repo_from_url(candidate["repoUrl"]) or candidate["repoUrl"].lower()
        current = deduped.get(repo_key)
        if not current or float(candidate.get("hotScore", 0)) > float(current.get("hotScore", 0)):
            deduped[repo_key] = candidate
    return sorted(deduped.values(), key=lambda item: float(item.get("hotScore", 0)), reverse=True)


def source_is_trusted(candidate: dict[str, Any], trusted_repos: list[str]) -> bool:
    trusted = {normalize_trusted_repo_value(value) for value in trusted_repos if normalize_trusted_repo_value(value)}
    source: OpenPromptSource = candidate["source"]
    keys = {
        source.id.lower(),
        source.source_name.lower(),
        normalize_repo_from_url(source.repo_url),
        normalize_repo_from_url(candidate["repoUrl"]),
    }
    return bool(trusted & {key for key in keys if key})


def first_admin_user() -> UserOut | None:
    with get_conn() as conn:
        row = conn.execute("SELECT * FROM users WHERE role = 'admin' ORDER BY created_at ASC LIMIT 1").fetchone()
    return row_to_user(row) if row else None


def create_auto_import_run(trigger: str) -> str:
    run_id = new_id()
    with get_conn() as conn:
        conn.execute(
            """
            INSERT INTO auto_import_runs (id, status, trigger, started_at)
            VALUES (?, 'running', ?, ?)
            """,
            (run_id, trigger, now_ms()),
        )
    return run_id


def finish_auto_import_run(
    run_id: str,
    *,
    status: str,
    message: str,
    metrics: dict[str, int],
    details: dict[str, Any],
) -> AutoImportRunOut:
    ts = now_ms()
    with get_conn() as conn:
        conn.execute(
            """
            UPDATE auto_import_runs SET
              status = ?, finished_at = ?, discovered_repositories = ?, selected_repositories = ?,
              created = ?, updated = ?, skipped = ?, submitted = ?, approved = ?,
              message = ?, details_json = ?
            WHERE id = ?
            """,
            (
                status,
                ts,
                int(metrics.get("discoveredRepositories", 0)),
                int(metrics.get("selectedRepositories", 0)),
                int(metrics.get("created", 0)),
                int(metrics.get("updated", 0)),
                int(metrics.get("skipped", 0)),
                int(metrics.get("submitted", 0)),
                int(metrics.get("approved", 0)),
                compact_message(message),
                json_dumps(details),
                run_id,
            ),
        )
        conn.execute(
            """
            INSERT INTO auto_import_settings (id, settings_json, github_token, last_run_at, updated_at)
            VALUES ('default', ?, '', ?, ?)
            ON CONFLICT(id) DO UPDATE SET last_run_at = excluded.last_run_at
            """,
            (json_dumps(sanitize_auto_import_settings({})), ts, ts),
        )
        row = conn.execute("SELECT * FROM auto_import_runs WHERE id = ?", (run_id,)).fetchone()
    return row_to_auto_import_run(row)


async def perform_auto_import(trigger: str, actor: UserOut) -> AutoImportRunOut:
    if AUTO_IMPORT_LOCK.locked():
        raise HTTPException(status_code=409, detail="Auto import is already running")

    async with AUTO_IMPORT_LOCK:
        run_id = create_auto_import_run(trigger)
        settings_data, github_token = read_auto_import_settings()
        metrics = {
            "discoveredRepositories": 0,
            "selectedRepositories": 0,
            "created": 0,
            "updated": 0,
            "skipped": 0,
            "submitted": 0,
            "approved": 0,
        }
        details: dict[str, Any] = {"repositories": []}
        try:
            candidates = await discover_auto_import_candidates(settings_data, github_token)
            metrics["discoveredRepositories"] = len(candidates)
            min_hot_score = float(settings_data.get("minHotScore") or 0)
            max_repositories = int(settings_data.get("maxRepositories") or 12)
            max_templates = int(settings_data.get("maxTemplatesPerRun") or 80)
            selected = [candidate for candidate in candidates if float(candidate.get("hotScore", 0)) >= min_hot_score][:max_repositories]
            metrics["selectedRepositories"] = len(selected)

            remaining = max_templates
            for candidate in selected:
                if remaining <= 0:
                    break
                source: OpenPromptSource = candidate["source"]
                trusted = source_is_trusted(candidate, settings_data.get("trustedRepos") or [])
                approve = bool(settings_data.get("autoApproveTrusted")) and trusted
                visibility = "public" if approve else "private"
                submission_status = "approved" if approve else "submitted"
                items = list(candidate.get("items") or [])[:remaining]
                if not items:
                    upsert_open_prompt_discovery(candidate, "skipped", "没有可导入模板")
                    continue

                result = upsert_open_prompt_items(
                    source,
                    items,
                    actor,
                    visibility=visibility,
                    submission_status=submission_status,
                    description_prefix="Auto imported from",
                )
                remaining -= len(items)
                for key in ("created", "updated", "skipped", "submitted", "approved"):
                    metrics[key] += int(result.get(key, 0))
                upsert_open_prompt_discovery(
                    candidate,
                    "imported",
                    f"新增 {result['created']}，更新 {result['updated']}，跳过 {result['skipped']}",
                    imported_at=now_ms(),
                )
                details["repositories"].append(
                    {
                        "repoUrl": candidate["repoUrl"],
                        "label": candidate["label"],
                        "hotScore": candidate["hotScore"],
                        "promptCount": candidate["promptCount"],
                        "trusted": trusted,
                        **result,
                    }
                )

            message = f"发现 {metrics['discoveredRepositories']} 个仓库，选择 {metrics['selectedRepositories']} 个，新增 {metrics['created']} 个模板"
            status = "done"
        except Exception as exc:
            message = str(exc)
            status = "error"
            details["error"] = compact_message(exc)

        with get_conn() as conn:
            insert_audit_log(
                conn,
                actor,
                "template.auto_import",
                "prompt_template",
                None,
                {
                    "trigger": trigger,
                    "status": status,
                    "created": metrics["created"],
                    "submitted": metrics["submitted"],
                    "approved": metrics["approved"],
                    "message": message,
                },
            )
        return finish_auto_import_run(run_id, status=status, message=message, metrics=metrics, details=details)


@app.get("/api/admin/auto-import/settings", response_model=AutoImportSettingsOut)
def get_auto_import_settings(admin: UserOut = Depends(require_admin)) -> AutoImportSettingsOut:
    del admin
    settings_data, github_token = read_auto_import_settings()
    return auto_import_settings_out(settings_data, github_token)


@app.patch("/api/admin/auto-import/settings", response_model=AutoImportSettingsOut)
def patch_auto_import_settings(
    payload: AutoImportSettingsPatch,
    admin: UserOut = Depends(require_admin),
) -> AutoImportSettingsOut:
    current, current_token = read_auto_import_settings()
    data = payload.model_dump(exclude_unset=True)
    next_data = {**current}
    for key in (
        "enabled",
        "runHour",
        "searchQueries",
        "trustedRepos",
        "includeKnownSources",
        "autoApproveTrusted",
        "maxRepositories",
        "maxTemplatesPerRun",
        "minHotScore",
    ):
        if key in data:
            next_data[key] = data[key]
    next_data = sanitize_auto_import_settings(next_data)
    next_token = current_token if "githubToken" not in data else str(data.get("githubToken") or "").strip()
    ts = now_ms()
    with get_conn() as conn:
        conn.execute(
            """
            INSERT INTO auto_import_settings (id, settings_json, github_token, last_run_at, updated_at)
            VALUES ('default', ?, ?, ?, ?)
            ON CONFLICT(id) DO UPDATE SET
              settings_json = excluded.settings_json,
              github_token = excluded.github_token,
              updated_at = excluded.updated_at
            """,
            (json_dumps(next_data), next_token, current.get("lastRunAt"), ts),
        )
        insert_audit_log(
            conn,
            admin,
            "template.auto_import_settings",
            "auto_import_settings",
            "default",
            {
                "enabled": next_data["enabled"],
                "runHour": next_data["runHour"],
                "includeKnownSources": next_data["includeKnownSources"],
                "autoApproveTrusted": next_data["autoApproveTrusted"],
                "maxRepositories": next_data["maxRepositories"],
                "maxTemplatesPerRun": next_data["maxTemplatesPerRun"],
            },
        )
    next_data["lastRunAt"] = current.get("lastRunAt")
    next_data["updatedAt"] = ts
    return auto_import_settings_out(next_data, next_token)


@app.post("/api/admin/auto-import/run", response_model=AutoImportRunOut)
async def run_auto_import_now(admin: UserOut = Depends(require_admin)) -> AutoImportRunOut:
    return await perform_auto_import("manual", admin)


@app.get("/api/admin/auto-import/runs", response_model=list[AutoImportRunOut])
def list_auto_import_runs(
    limit: int = Query(20, ge=1, le=100),
    admin: UserOut = Depends(require_admin),
) -> list[AutoImportRunOut]:
    del admin
    with get_conn() as conn:
        rows = conn.execute("SELECT * FROM auto_import_runs ORDER BY started_at DESC LIMIT ?", (limit,)).fetchall()
    return [row_to_auto_import_run(row) for row in rows]


@app.get("/api/admin/open-prompt-discoveries", response_model=list[OpenPromptDiscoveryOut])
def list_open_prompt_discoveries(
    limit: int = Query(50, ge=1, le=200),
    admin: UserOut = Depends(require_admin),
) -> list[OpenPromptDiscoveryOut]:
    del admin
    with get_conn() as conn:
        rows = conn.execute(
            """
            SELECT * FROM open_prompt_discoveries
            ORDER BY hot_score DESC, last_seen_at DESC
            LIMIT ?
            """,
            (limit,),
        ).fetchall()
    return [row_to_open_prompt_discovery(row) for row in rows]


@app.get("/api/admin/open-prompt-sources", response_model=list[OpenPromptSourceOut])
def list_open_prompt_sources(admin: UserOut = Depends(require_template_operator)) -> list[OpenPromptSourceOut]:
    del admin
    with get_conn() as conn:
        rows = conn.execute("SELECT source_name, COUNT(*) AS count FROM prompt_templates GROUP BY source_name").fetchall()
        imported_counts = {row["source_name"]: int(row["count"]) for row in rows}
        audit_rows = conn.execute(
            """
            SELECT details_json, created_at FROM audit_logs
            WHERE action = 'template.import_open_library'
            ORDER BY created_at DESC
            LIMIT 200
            """
        ).fetchall()
    latest: dict[str, tuple[dict[str, Any], int]] = {}
    for row in audit_rows:
        details = json_loads(row["details_json"], {})
        source_id = str(details.get("sourceId") or "")
        if source_id and source_id not in latest:
            latest[source_id] = (details, row["created_at"])
    return [
        OpenPromptSourceOut(
            id=source.id,
            label=source.label,
            repoUrl=source.repo_url,
            licenseName=source.license_name,
            importedCount=imported_counts.get(source.source_name, 0),
            lastSyncedAt=latest.get(source.id, ({}, None))[1],
            lastCreated=int(latest.get(source.id, ({}, None))[0].get("created", 0)),
            lastUpdated=int(latest.get(source.id, ({}, None))[0].get("updated", 0)),
            lastSkipped=int(latest.get(source.id, ({}, None))[0].get("skipped", 0)),
        )
        for source in OPEN_PROMPT_SOURCES.values()
    ]


@app.get("/api/admin/templates/import-open-library/preview", response_model=OpenPromptPreviewOut)
async def preview_open_library_templates(
    source: str = Query("evolink"),
    limit: int = Query(0, ge=0, le=5000),
    admin: UserOut = Depends(require_template_operator),
) -> OpenPromptPreviewOut:
    del admin
    prompt_source = OPEN_PROMPT_SOURCES.get(source)
    if not prompt_source:
        raise HTTPException(status_code=404, detail="Open prompt source not found")
    all_items = await fetch_open_prompt_items(prompt_source, 0)
    items = all_items if limit <= 0 else all_items[:limit]
    with get_conn() as conn:
        existing_rows = conn.execute(
            "SELECT title, source_author, source_url FROM prompt_templates WHERE source_name = ?",
            (prompt_source.source_name,),
        ).fetchall()
        existing_title_authors = {
            f"{row['title']}\0{row['source_author']}"
            for row in existing_rows
        }
        existing_urls = {
            str(row["source_url"]).strip()
            for row in existing_rows
            if str(row["source_url"] or "").strip()
        }
        loaded = len(items)
        total = len(all_items)
        duplicate_count = sum(
            1
            for item in items
            if (
                open_prompt_duplicate_marker(item)[0] in existing_urls
                or open_prompt_duplicate_marker(item)[1] in existing_title_authors
            )
        )
        new_count = max(0, loaded - duplicate_count)
        high_quality_count = sum(1 for item in items if float(item["qualityScore"]) >= 70)
        high_quality_new_count = sum(
            1
            for item in items
            if float(item["qualityScore"]) >= 70
            and not (
                open_prompt_duplicate_marker(item)[0] in existing_urls
                or open_prompt_duplicate_marker(item)[1] in existing_title_authors
            )
        )
    return OpenPromptPreviewOut(
        source=prompt_source.id,
        label=prompt_source.label,
        licenseName=prompt_source.license_name,
        repoUrl=prompt_source.repo_url,
        total=total,
        loaded=loaded,
        truncated=loaded < total,
        newCount=new_count,
        duplicateCount=duplicate_count,
        highQualityCount=high_quality_count,
        highQualityNewCount=high_quality_new_count,
        items=[
            OpenPromptPreviewItemOut(
                key=item["key"],
                title=item["title"],
                prompt=item["prompt"],
                image=item["image"],
                sourceUrl=item["sourceUrl"],
                sourceAuthor=item["sourceAuthor"],
                sourceName=item["sourceName"],
                licenseName=item["licenseName"],
                category=item["category"],
                tags=item["tags"],
                qualityScore=item["qualityScore"],
                isDuplicate=(
                    open_prompt_duplicate_marker(item)[0] in existing_urls
                    or open_prompt_duplicate_marker(item)[1] in existing_title_authors
                ),
            )
            for item in items
        ],
    )


async def import_open_prompt_source(
    source_id: str,
    limit: int,
    admin: UserOut,
    selected_keys: list[str] | None = None,
) -> dict[str, int | bool | str]:
    prompt_source = OPEN_PROMPT_SOURCES.get(source_id)
    if not prompt_source:
        raise HTTPException(status_code=404, detail="Open prompt source not found")
    parsed = await fetch_open_prompt_items(prompt_source, 0 if selected_keys else limit)
    selected = set(selected_keys or [])
    if selected:
        parsed = [item for item in parsed if item["key"] in selected]
    result = upsert_open_prompt_items(
        prompt_source,
        parsed,
        admin,
        visibility="public",
        submission_status="approved",
        description_prefix="Imported from",
    )
    with get_conn() as conn:
        insert_audit_log(
            conn,
            admin,
            "template.import_open_library",
            "prompt_template",
            None,
            {
                "created": result["created"],
                "updated": result["updated"],
                "skipped": result["skipped"],
                "sourceId": prompt_source.id,
                "source": prompt_source.repo_url,
                "license": prompt_source.license_name,
            },
        )
    return {
        "ok": True,
        "source": prompt_source.id,
        "created": result["created"],
        "updated": result["updated"],
        "skipped": result["skipped"],
    }


@app.post("/api/admin/templates/import-open-library")
async def import_open_library_templates(
    payload: OpenPromptImportIn | None = Body(None),
    source: str = Query("evolink"),
    limit: int = Query(0, ge=0, le=5000),
    admin: UserOut = Depends(require_template_operator),
) -> dict[str, int | bool | str]:
    source_id = payload.source if payload else source
    import_limit = max(0, min(payload.limit, 5000)) if payload else limit
    return await import_open_prompt_source(source_id, import_limit, admin, payload.selectedKeys if payload else None)


@app.post("/api/admin/templates/import-evolink")
async def import_evolink_templates(
    limit: int = Query(0, ge=0, le=5000),
    admin: UserOut = Depends(require_template_operator),
) -> dict[str, int | bool | str]:
    return await import_open_prompt_source("evolink", limit, admin)


@app.post("/api/templates", response_model=PromptTemplateOut)
def create_template(payload: PromptTemplateIn, user: UserOut = Depends(require_user)) -> PromptTemplateOut:
    template_id = new_id()
    ts = now_ms()
    validate_template_channel_selection(payload.channelId, payload.apiMode, payload.model)
    project_id = resolve_owned_project_id(payload.projectId, user)
    example_images = normalize_example_images(payload.exampleImages)
    quality_score = quality_for_payload(
        PromptTemplateIn.model_validate({**payload.model_dump(), "exampleImages": example_images})
    )
    visibility = "public" if user.role == "admin" else "private"
    submission_status = "approved" if user.role == "admin" else "draft"
    is_featured = bool(payload.isFeatured) if user.role == "admin" else False
    with get_conn() as conn:
        conn.execute(
            """
            INSERT INTO prompt_templates (
              id, user_id, project_id, title, description, prompt, negative_prompt, tags_json, category,
              params_json, channel_id, api_mode, model, cover_image_id, external_cover_url, linked_task_ids_json,
              is_favorite, source_name, source_url, source_author, license_name, form_fields_json, collections_json, is_featured,
              visibility, submission_status, reviewed_at, reviewed_by, version, created_at, updated_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            """,
            (
                template_id,
                user.id,
                project_id,
                payload.title,
                payload.description,
                payload.prompt,
                payload.negativePrompt,
                json_dumps(payload.tags),
                payload.category,
                payload.params.model_dump_json(),
                payload.channelId,
                payload.apiMode,
                payload.model,
                payload.coverImageId,
                payload.externalCoverUrl,
                json_dumps(payload.linkedTaskIds),
                int(payload.isFavorite),
                payload.sourceName.strip(),
                payload.sourceUrl.strip(),
                payload.sourceAuthor.strip(),
                payload.licenseName.strip(),
                json_dumps([field.model_dump() for field in payload.formFields]),
                json_dumps([value.strip() for value in payload.collections if value.strip()][:16]),
                int(is_featured),
                visibility,
                submission_status,
                ts if user.role == "admin" else None,
                user.id if user.role == "admin" else None,
                1,
                ts,
                ts,
            ),
        )
        conn.execute(
            """
            UPDATE prompt_templates SET
              example_images_json = ?,
              recommended_channel_id = ?,
              recommended_api_mode = ?,
              recommended_model = ?,
              quality_score = ?
            WHERE id = ?
            """,
            (
                json_dumps(example_images),
                payload.recommendedChannelId,
                payload.recommendedApiMode,
                payload.recommendedModel.strip(),
                quality_score,
                template_id,
            ),
        )
        recalculate_template_quality(conn, template_id)
        snapshot_template_version(conn, template_id, user)
        row = conn.execute("SELECT * FROM prompt_templates WHERE id = ? AND user_id = ?", (template_id, user.id)).fetchone()
    return row_to_template(row)


def get_template_or_404(template_id: str, user: UserOut) -> PromptTemplateOut:
    with get_conn() as conn:
        row = conn.execute(
            "SELECT * FROM prompt_templates WHERE id = ?",
            (template_id,),
        ).fetchone()
    if not row:
        raise HTTPException(status_code=404, detail="Template not found")
    template = row_to_template(row)
    can_read = (
        template.userId == user.id
        or user.role == "admin"
        or (template.visibility == "public" and template.submissionStatus == "approved")
    )
    if not can_read:
        raise HTTPException(status_code=404, detail="Template not found")
    return template


def assert_can_manage_template(template: PromptTemplateOut, user: UserOut) -> None:
    if user.role == "admin":
        return
    if template.userId != user.id:
        raise HTTPException(status_code=404, detail="Template not found")
    if template.submissionStatus == "submitted":
        raise HTTPException(status_code=409, detail="Submitted templates cannot be edited before review")
    if template.visibility == "public" or template.submissionStatus == "approved":
        raise HTTPException(status_code=403, detail="Public templates are managed by admins")


def visible_template_rows(conn: Any, user: UserOut) -> list[Any]:
    if user.role == "admin":
        return conn.execute("SELECT * FROM prompt_templates ORDER BY updated_at DESC").fetchall()
    return conn.execute(
        """
        SELECT * FROM prompt_templates
        WHERE user_id = ? OR (visibility = 'public' AND submission_status = 'approved')
        ORDER BY updated_at DESC
        """,
        (user.id,),
    ).fetchall()


def tokenize_similarity_text(value: str) -> set[str]:
    normalized = re.sub(r"[^0-9a-zA-Z\u4e00-\u9fff+#.-]+", " ", value.lower())
    tokens = {token for token in normalized.split() if len(token) >= 2}
    for match in re.findall(r"[\u4e00-\u9fff]{2,}", normalized):
        tokens.add(match)
    return tokens


def template_similarity_text(template: PromptTemplateOut) -> str:
    return " ".join(
        [
            template.title,
            template.description,
            template.prompt,
            template.negativePrompt or "",
            template.category,
            " ".join(template.tags),
            " ".join(template.collections),
            template.sourceName or "",
        ]
    )


def hamming_distance_hex(left: str, right: str) -> int:
    if len(left) != len(right):
        return 64
    return bin(int(left, 16) ^ int(right, 16)).count("1")


def score_template_similarity(
    target: str,
    candidate: PromptTemplateOut,
    target_visual_hash: str | None = None,
    candidate_visual_hash: str | None = None,
) -> float:
    target_tokens = tokenize_similarity_text(target)
    candidate_tokens = tokenize_similarity_text(template_similarity_text(candidate))
    if not target_tokens or not candidate_tokens:
        score = 0.0
    else:
        overlap = target_tokens & candidate_tokens
        score = float(len(overlap) * 8)
        if candidate.category and candidate.category.lower() in target.lower():
            score += 10
    score += min(candidate.qualityScore, 100) / 20
    score += min(candidate.usageCount, 30) / 10
    if candidate.isFeatured:
        score += 4

    if target_visual_hash and candidate_visual_hash:
        distance = hamming_distance_hex(target_visual_hash, candidate_visual_hash)
        score += max(0.0, 24.0 - distance / 2)
    return score


def resolve_similarity_target(
    conn: Any,
    user: UserOut,
    template_id: str | None,
    asset_id: str | None,
    query: str,
) -> tuple[str, str | None, str | None]:
    if template_id:
        template = get_template_or_404(template_id, user)
        visual_hash: str | None = None
        if template.coverImageId:
            asset = conn.execute("SELECT visual_hash FROM assets WHERE id = ?", (template.coverImageId,)).fetchone()
            visual_hash = asset["visual_hash"] if asset and asset["visual_hash"] else None
        return template_similarity_text(template), template.id, visual_hash
    if asset_id:
        asset = conn.execute("SELECT * FROM assets WHERE id = ?", (asset_id,)).fetchone()
        if not asset:
            raise HTTPException(status_code=404, detail="Asset not found")
        if asset["user_id"] != user.id and not asset_is_publicly_visible(conn, asset):
            raise HTTPException(status_code=404, detail="Asset not found")
        if asset["template_id"]:
            template = get_template_or_404(asset["template_id"], user)
            return template_similarity_text(template), template.id, asset["visual_hash"]
        if asset["task_id"]:
            task = conn.execute("SELECT prompt FROM generation_tasks WHERE id = ?", (asset["task_id"],)).fetchone()
            if task:
                return task["prompt"], None, asset["visual_hash"]
    return query.strip(), None, None


def pack_item_to_template_payload(item: dict[str, Any], fallback_channel_id: str, fallback_model: ChannelModel) -> PromptTemplateIn:
    params = item.get("params") if isinstance(item.get("params"), dict) else {}
    channel_id = item.get("recommendedChannelId") or item.get("channelId") or fallback_channel_id
    api_mode = item.get("recommendedApiMode") or item.get("apiMode") or fallback_model.apiMode
    model_id = item.get("recommendedModel") or item.get("model") or fallback_model.id
    try:
        validate_template_channel_selection(str(channel_id), str(api_mode), str(model_id))
    except HTTPException:
        channel_id = fallback_channel_id
        api_mode = fallback_model.apiMode
        model_id = fallback_model.id
    return PromptTemplateIn(
        title=str(item.get("title") or "导入模板").strip()[:120],
        description=str(item.get("description") or "").strip()[:1000],
        prompt=str(item.get("prompt") or "").strip()[:8000],
        negativePrompt=(str(item.get("negativePrompt")).strip() if item.get("negativePrompt") else None),
        tags=[str(tag).strip() for tag in item.get("tags", []) if str(tag).strip()][:12],
        category=str(item.get("category") or "").strip()[:80],
        params=TaskParams.model_validate(params),
        channelId=str(channel_id),
        apiMode=api_mode,
        model=str(model_id),
        coverImageId=None,
        externalCoverUrl=(str(item.get("externalCoverUrl")).strip() if item.get("externalCoverUrl") else None),
        exampleImages=normalize_example_images([str(url) for url in item.get("exampleImages", [])]),
        recommendedChannelId=str(channel_id),
        recommendedApiMode=api_mode,
        recommendedModel=str(model_id),
        linkedTaskIds=[],
        isFavorite=False,
        sourceName=str(item.get("sourceName") or "Template Pack").strip()[:160],
        sourceUrl=str(item.get("sourceUrl") or "").strip()[:500],
        sourceAuthor=str(item.get("sourceAuthor") or "").strip()[:160],
        licenseName=str(item.get("licenseName") or "").strip()[:160],
        formFields=[
            item if isinstance(item, dict) else {}
            for item in item.get("formFields", [])[:24]
            if isinstance(item, dict)
        ],
        collections=[
            str(value).strip()
            for value in item.get("collections", [])[:16]
            if str(value).strip()
        ],
        isFeatured=bool(item.get("isFeatured")),
    )


@app.get("/api/templates/similar", response_model=list[PromptTemplateOut])
def list_similar_templates(
    templateId: str | None = Query(None),
    assetId: str | None = Query(None),
    query: str = Query(""),
    limit: int = Query(8, ge=1, le=40),
    user: UserOut = Depends(require_user),
) -> list[PromptTemplateOut]:
    with get_conn() as conn:
        target_text, exclude_id, target_visual_hash = resolve_similarity_target(conn, user, templateId, assetId, query)
        if not target_text:
            return []
        candidates = [row_to_template(row) for row in visible_template_rows(conn, user)]
        candidate_hashes = {
            row["id"]: row["visual_hash"]
            for row in conn.execute("SELECT id, visual_hash FROM assets WHERE visual_hash IS NOT NULL").fetchall()
        }
    scored = [
        (
            score_template_similarity(
                target_text,
                template,
                target_visual_hash,
                candidate_hashes.get(template.coverImageId or ""),
            ),
            template,
        )
        for template in candidates
        if template.id != exclude_id
    ]
    return [template for score, template in sorted(scored, key=lambda item: item[0], reverse=True) if score > 0][:limit]


@app.post("/api/templates/import-pack", response_model=TemplatePackImportOut)
def import_template_pack(payload: TemplatePackImportIn, user: UserOut = Depends(require_user)) -> TemplatePackImportOut:
    channel_id, model = pick_default_template_target()
    created = 0
    skipped = 0
    for item in payload.templates[:200]:
        template_payload = pack_item_to_template_payload(item, channel_id, model)
        if not template_payload.prompt:
            skipped += 1
            continue
        with get_conn() as conn:
            exists = conn.execute(
                """
                SELECT id FROM prompt_templates
                WHERE user_id = ? AND title = ? AND prompt = ?
                """,
                (user.id, template_payload.title, template_payload.prompt),
            ).fetchone()
        if exists:
            skipped += 1
            continue
        create_template(template_payload, user)
        created += 1
    return TemplatePackImportOut(created=created, skipped=skipped)


@app.get("/api/templates/{template_id}", response_model=PromptTemplateOut)
def get_template(template_id: str, user: UserOut = Depends(require_user)) -> PromptTemplateOut:
    return get_template_or_404(template_id, user)


@app.post("/api/templates/{template_id}/use", response_model=PromptTemplateOut)
def mark_template_used(template_id: str, user: UserOut = Depends(require_user)) -> PromptTemplateOut:
    get_template_or_404(template_id, user)
    ts = now_ms()
    with get_conn() as conn:
        conn.execute(
            """
            UPDATE prompt_templates SET
              usage_count = COALESCE(usage_count, 0) + 1,
              last_used_at = ?,
              updated_at = CASE WHEN visibility = 'private' THEN ? ELSE updated_at END
            WHERE id = ?
            """,
            (ts, ts, template_id),
        )
        recalculate_template_quality(conn, template_id)
        row = conn.execute("SELECT * FROM prompt_templates WHERE id = ?", (template_id,)).fetchone()
    return row_to_template(row)


@app.patch("/api/templates/{template_id}", response_model=PromptTemplateOut)
def patch_template(template_id: str, payload: PromptTemplatePatch, user: UserOut = Depends(require_user)) -> PromptTemplateOut:
    existing = get_template_or_404(template_id, user)
    assert_can_manage_template(existing, user)
    data = payload.model_dump(exclude_unset=True)
    if not data:
        return existing

    ts = now_ms()
    next_template = PromptTemplateOut.model_validate({**existing.model_dump(), **data})
    project_id = resolve_owned_project_id(next_template.projectId, user)
    if {"channelId", "apiMode", "model"} & set(data):
        validate_template_channel_selection(next_template.channelId, next_template.apiMode, next_template.model)
    example_images = normalize_example_images(next_template.exampleImages)
    quality_score = calculate_template_quality(
        next_template.title,
        next_template.prompt,
        next_template.tags,
        next_template.category,
        next_template.coverImageId,
        next_template.externalCoverUrl,
        example_images,
        next_template.sourceName,
        next_template.negativePrompt,
    )
    visibility = existing.visibility
    submission_status = existing.submissionStatus
    reviewed_at = existing.reviewedAt
    reviewed_by = existing.reviewedBy
    rejection_reason = existing.rejectionReason
    if user.role != "admin":
        visibility = "private"
        submission_status = "draft"
        reviewed_at = None
        reviewed_by = None
        rejection_reason = None
    next_is_featured = bool(next_template.isFeatured) if user.role == "admin" else False
    with get_conn() as conn:
        conn.execute(
            """
            UPDATE prompt_templates SET
              project_id = ?, title = ?, description = ?, prompt = ?, negative_prompt = ?, tags_json = ?,
              category = ?, params_json = ?, channel_id = ?, api_mode = ?, model = ?, cover_image_id = ?, external_cover_url = ?,
              example_images_json = ?, recommended_channel_id = ?, recommended_api_mode = ?, recommended_model = ?,
              linked_task_ids_json = ?, is_favorite = ?, favorite_count = ?, source_name = ?, source_url = ?, source_author = ?, license_name = ?,
              form_fields_json = ?, collections_json = ?, is_featured = ?, quality_score = ?,
              visibility = ?, submission_status = ?, reviewed_at = ?, reviewed_by = ?, rejection_reason = ?, version = version + 1, updated_at = ?
            WHERE id = ?
            """,
            (
                project_id,
                next_template.title,
                next_template.description,
                next_template.prompt,
                next_template.negativePrompt,
                json_dumps(next_template.tags),
                next_template.category,
                next_template.params.model_dump_json(),
                next_template.channelId,
                next_template.apiMode,
                next_template.model,
                next_template.coverImageId,
                next_template.externalCoverUrl,
                json_dumps(example_images),
                next_template.recommendedChannelId,
                next_template.recommendedApiMode,
                next_template.recommendedModel.strip(),
                json_dumps(next_template.linkedTaskIds),
                int(next_template.isFavorite),
                max(0, existing.favoriteCount + (1 if next_template.isFavorite and not existing.isFavorite else -1 if existing.isFavorite and not next_template.isFavorite else 0)),
                next_template.sourceName.strip(),
                next_template.sourceUrl.strip(),
                next_template.sourceAuthor.strip(),
                next_template.licenseName.strip(),
                json_dumps([field.model_dump() for field in next_template.formFields]),
                json_dumps([value.strip() for value in next_template.collections if value.strip()][:16]),
                int(next_is_featured),
                quality_score,
                visibility,
                submission_status,
                reviewed_at,
                reviewed_by,
                rejection_reason,
                ts,
                template_id,
            ),
        )
        recalculate_template_quality(conn, template_id)
        snapshot_template_version(conn, template_id, user)
        row = conn.execute("SELECT * FROM prompt_templates WHERE id = ?", (template_id,)).fetchone()
    return row_to_template(row)


@app.delete("/api/templates/{template_id}")
def delete_template(template_id: str, user: UserOut = Depends(require_user)) -> dict[str, bool]:
    template = get_template_or_404(template_id, user)
    assert_can_manage_template(template, user)
    with get_conn() as conn:
        cur = conn.execute("DELETE FROM prompt_templates WHERE id = ?", (template_id,))
    if cur.rowcount == 0:
        raise HTTPException(status_code=404, detail="Template not found")
    return {"ok": True}


@app.post("/api/templates/{template_id}/duplicate", response_model=PromptTemplateOut)
def duplicate_template(template_id: str, user: UserOut = Depends(require_user)) -> PromptTemplateOut:
    source = get_template_or_404(template_id, user)
    payload = PromptTemplateIn(
        projectId=source.projectId,
        title=f"{source.title} 副本",
        description=source.description,
        prompt=source.prompt,
        negativePrompt=source.negativePrompt,
        tags=source.tags,
        category=source.category,
        params=source.params,
        channelId=source.channelId,
        apiMode=source.apiMode,
        model=source.model,
        coverImageId=source.coverImageId,
        externalCoverUrl=source.externalCoverUrl,
        exampleImages=source.exampleImages,
        recommendedChannelId=source.recommendedChannelId,
        recommendedApiMode=source.recommendedApiMode,
        recommendedModel=source.recommendedModel,
        linkedTaskIds=[],
        isFavorite=False,
        sourceName=source.sourceName,
        sourceUrl=source.sourceUrl,
        sourceAuthor=source.sourceAuthor,
        licenseName=source.licenseName,
        formFields=source.formFields,
        collections=source.collections,
        isFeatured=source.isFeatured if user.role == "admin" else False,
    )
    return create_template(payload, user)


@app.post("/api/templates/{template_id}/set-cover", response_model=PromptTemplateOut)
def set_template_cover(template_id: str, payload: SetCoverIn, user: UserOut = Depends(require_user)) -> PromptTemplateOut:
    template = get_template_or_404(template_id, user)
    assert_can_manage_template(template, user)
    with get_conn() as conn:
        if user.role == "admin":
            asset = conn.execute("SELECT id FROM assets WHERE id = ?", (payload.imageId,)).fetchone()
        else:
            asset = conn.execute(
                "SELECT id FROM assets WHERE id = ? AND user_id = ?",
                (payload.imageId, user.id),
            ).fetchone()
        if not asset:
            raise HTTPException(status_code=404, detail="Asset not found")
    return patch_template(template_id, PromptTemplatePatch(coverImageId=payload.imageId), user)


@app.post("/api/templates/{template_id}/rate", response_model=PromptTemplateOut)
def rate_template(template_id: str, payload: RateTemplateIn, user: UserOut = Depends(require_user)) -> PromptTemplateOut:
    get_template_or_404(template_id, user)
    ts = now_ms()
    with get_conn() as conn:
        existing = conn.execute(
            "SELECT score FROM template_ratings WHERE template_id = ? AND user_id = ?",
            (template_id, user.id),
        ).fetchone()
        if existing:
            conn.execute(
                """
                UPDATE template_ratings SET score = ?, updated_at = ?
                WHERE template_id = ? AND user_id = ?
                """,
                (payload.score, ts, template_id, user.id),
            )
            conn.execute(
                """
                UPDATE prompt_templates
                SET rating_total = COALESCE(rating_total, 0) + ?, updated_at = ?
                WHERE id = ?
                """,
                (payload.score - int(existing["score"]), ts, template_id),
            )
        else:
            conn.execute(
                """
                INSERT INTO template_ratings (template_id, user_id, score, updated_at)
                VALUES (?, ?, ?, ?)
                """,
                (template_id, user.id, payload.score, ts),
            )
            conn.execute(
                """
                UPDATE prompt_templates
                SET rating_total = COALESCE(rating_total, 0) + ?,
                    rating_count = COALESCE(rating_count, 0) + 1,
                    updated_at = ?
                WHERE id = ?
                """,
                (payload.score, ts, template_id),
            )
        recalculate_template_quality(conn, template_id)
        row = conn.execute("SELECT * FROM prompt_templates WHERE id = ?", (template_id,)).fetchone()
    return row_to_template(row)


@app.get("/api/templates/{template_id}/samples", response_model=list[TemplateSampleOut])
def list_template_samples(
    template_id: str,
    limit: int = Query(24, ge=1, le=80),
    user: UserOut = Depends(require_user),
) -> list[TemplateSampleOut]:
    template = get_template_or_404(template_id, user)
    with get_conn() as conn:
        rows = conn.execute(
            """
            SELECT * FROM assets
            WHERE template_id = ? AND type = 'generated'
            ORDER BY created_at DESC
            LIMIT ?
            """,
            (template_id, limit),
        ).fetchall()
        samples: list[TemplateSampleOut] = []
        for asset in rows:
            if asset["user_id"] != user.id and user.role != "admin" and not asset_is_publicly_visible(conn, asset):
                continue
            task = conn.execute("SELECT * FROM generation_tasks WHERE id = ?", (asset["task_id"],)).fetchone() if asset["task_id"] else None
            prompt = ""
            params = template.params
            template_version_id = None
            channel_id = None
            api_mode = None
            model = None
            elapsed = None
            if task:
                params = TaskParams.model_validate(json_loads(task["params_json"], {}))
                template_version_id = task["template_version_id"]
                channel_id = task["channel_id"]
                api_mode = task["api_mode"]
                model = task["model"]
                elapsed = task["elapsed"]
                if task["user_id"] == user.id or user.role == "admin":
                    prompt = task["prompt"]
            samples.append(
                TemplateSampleOut(
                    imageId=asset["id"],
                    taskId=asset["task_id"],
                    templateId=template_id,
                    templateVersionId=template_version_id,
                    prompt=prompt,
                    params=params,
                    channelId=channel_id,
                    apiMode=api_mode,
                    model=model,
                    width=asset["width"],
                    height=asset["height"],
                    elapsed=elapsed,
                    createdAt=asset["created_at"],
                )
            )
    return samples


@app.get("/api/templates/{template_id}/versions", response_model=list[TemplateVersionOut])
def list_template_versions(template_id: str, user: UserOut = Depends(require_user)) -> list[TemplateVersionOut]:
    get_template_or_404(template_id, user)
    with get_conn() as conn:
        existing_count = conn.execute(
            "SELECT COUNT(*) AS count FROM prompt_template_versions WHERE template_id = ?",
            (template_id,),
        ).fetchone()["count"]
        if not existing_count:
            snapshot_template_version(conn, template_id, user)
        rows = conn.execute(
            """
            SELECT * FROM prompt_template_versions
            WHERE template_id = ?
            ORDER BY version DESC
            """,
            (template_id,),
        ).fetchall()
    return [row_to_template_version(row) for row in rows]


@app.post("/api/templates/{template_id}/versions/{version_id}/restore", response_model=PromptTemplateOut)
def restore_template_version(
    template_id: str,
    version_id: str,
    user: UserOut = Depends(require_user),
) -> PromptTemplateOut:
    existing = get_template_or_404(template_id, user)
    assert_can_manage_template(existing, user)
    with get_conn() as conn:
        version = conn.execute(
            """
            SELECT * FROM prompt_template_versions
            WHERE template_id = ? AND id = ?
            """,
            (template_id, version_id),
        ).fetchone()
        if not version:
            raise HTTPException(status_code=404, detail="Template version not found")
        snapshot = json_loads(version["snapshot_json"], {})
        restored = PromptTemplateOut.model_validate({**existing.model_dump(), **snapshot})
        next_version = existing.version + 1
        ts = now_ms()
        conn.execute(
            """
            UPDATE prompt_templates SET
              project_id = ?, title = ?, description = ?, prompt = ?, negative_prompt = ?, tags_json = ?,
              category = ?, params_json = ?, channel_id = ?, api_mode = ?, model = ?, cover_image_id = ?, external_cover_url = ?,
              example_images_json = ?, recommended_channel_id = ?, recommended_api_mode = ?, recommended_model = ?,
              linked_task_ids_json = ?, source_name = ?, source_url = ?, source_author = ?, license_name = ?,
              form_fields_json = ?, collections_json = ?, is_featured = ?,
              visibility = CASE WHEN ? = 'admin' THEN visibility ELSE 'private' END,
              submission_status = CASE WHEN ? = 'admin' THEN submission_status ELSE 'draft' END,
              reviewed_at = CASE WHEN ? = 'admin' THEN reviewed_at ELSE NULL END,
              reviewed_by = CASE WHEN ? = 'admin' THEN reviewed_by ELSE NULL END,
              rejection_reason = CASE WHEN ? = 'admin' THEN rejection_reason ELSE NULL END,
              version = ?, updated_at = ?
            WHERE id = ?
            """,
            (
                resolve_owned_project_id(restored.projectId, user),
                restored.title,
                restored.description,
                restored.prompt,
                restored.negativePrompt,
                json_dumps(restored.tags),
                restored.category,
                restored.params.model_dump_json(),
                restored.channelId,
                restored.apiMode,
                restored.model,
                restored.coverImageId,
                restored.externalCoverUrl,
                json_dumps(normalize_example_images(restored.exampleImages)),
                restored.recommendedChannelId,
                restored.recommendedApiMode,
                restored.recommendedModel,
                json_dumps(restored.linkedTaskIds),
                restored.sourceName or "",
                restored.sourceUrl or "",
                restored.sourceAuthor or "",
                restored.licenseName or "",
                json_dumps([field.model_dump() for field in restored.formFields]),
                json_dumps([value.strip() for value in restored.collections if value.strip()][:16]),
                int(bool(restored.isFeatured) if user.role == "admin" else False),
                user.role,
                user.role,
                user.role,
                user.role,
                user.role,
                next_version,
                ts,
                template_id,
            ),
        )
        recalculate_template_quality(conn, template_id)
        snapshot_template_version(conn, template_id, user)
        row = conn.execute("SELECT * FROM prompt_templates WHERE id = ?", (template_id,)).fetchone()
    return row_to_template(row)


@app.post("/api/templates/{template_id}/submit", response_model=PromptTemplateOut)
def submit_template(template_id: str, user: UserOut = Depends(require_user)) -> PromptTemplateOut:
    template = get_template_or_404(template_id, user)
    if template.userId != user.id:
        raise HTTPException(status_code=404, detail="Template not found")
    if template.submissionStatus == "submitted":
        return template
    if template.visibility == "public" or template.submissionStatus == "approved":
        raise HTTPException(status_code=409, detail="Template is already public")
    ts = now_ms()
    with get_conn() as conn:
        conn.execute(
            """
            UPDATE prompt_templates SET
              visibility = 'private', submission_status = 'submitted',
              submitted_at = ?, reviewed_at = NULL, reviewed_by = NULL, rejection_reason = NULL, updated_at = ?
            WHERE id = ? AND user_id = ?
            """,
            (ts, ts, template_id, user.id),
        )
        insert_audit_log(
            conn,
            user,
            "template.submit",
            "prompt_template",
            template_id,
            {"title": template.title},
        )
        row = conn.execute("SELECT * FROM prompt_templates WHERE id = ?", (template_id,)).fetchone()
    return row_to_template(row)


@app.get("/api/admin/template-submissions", response_model=list[PromptTemplateOut])
def list_template_submissions(admin: UserOut = Depends(require_template_operator)) -> list[PromptTemplateOut]:
    with get_conn() as conn:
        rows = conn.execute(
            "SELECT * FROM prompt_templates WHERE submission_status = 'submitted' ORDER BY submitted_at DESC, updated_at DESC",
        ).fetchall()
    return [row_to_template(row) for row in rows]


@app.post("/api/admin/template-submissions/{template_id}/approve", response_model=PromptTemplateOut)
def approve_template_submission(template_id: str, admin: UserOut = Depends(require_template_operator)) -> PromptTemplateOut:
    ts = now_ms()
    with get_conn() as conn:
        cur = conn.execute(
            """
            UPDATE prompt_templates SET
              visibility = 'public', submission_status = 'approved',
              reviewed_at = ?, reviewed_by = ?, rejection_reason = NULL, updated_at = ?
            WHERE id = ? AND submission_status = 'submitted'
            """,
            (ts, admin.id, ts, template_id),
        )
        if cur.rowcount == 0:
            raise HTTPException(status_code=404, detail="Submitted template not found")
        row = conn.execute("SELECT * FROM prompt_templates WHERE id = ?", (template_id,)).fetchone()
        insert_audit_log(
            conn,
            admin,
            "template.approve",
            "prompt_template",
            template_id,
            {"title": row["title"], "ownerUserId": row["user_id"]},
        )
    return row_to_template(row)


@app.post("/api/admin/template-submissions/{template_id}/reject", response_model=PromptTemplateOut)
def reject_template_submission(
    template_id: str,
    payload: RejectTemplateIn,
    admin: UserOut = Depends(require_template_operator),
) -> PromptTemplateOut:
    ts = now_ms()
    with get_conn() as conn:
        cur = conn.execute(
            """
            UPDATE prompt_templates SET
              visibility = 'private', submission_status = 'rejected',
              reviewed_at = ?, reviewed_by = ?, rejection_reason = ?, updated_at = ?
            WHERE id = ? AND submission_status = 'submitted'
            """,
            (ts, admin.id, payload.reason.strip() or None, ts, template_id),
        )
        if cur.rowcount == 0:
            raise HTTPException(status_code=404, detail="Submitted template not found")
        row = conn.execute("SELECT * FROM prompt_templates WHERE id = ?", (template_id,)).fetchone()
        insert_audit_log(
            conn,
            admin,
            "template.reject",
            "prompt_template",
            template_id,
            {"title": row["title"], "ownerUserId": row["user_id"], "reason": payload.reason.strip()},
        )
    return row_to_template(row)


@app.post("/api/generations/preflight", response_model=GenerationPreflightOut)
def generation_preflight(payload: GenerationPreflightIn, user: UserOut = Depends(require_user)) -> GenerationPreflightOut:
    probe = GenerateIn(
        channelId=payload.channelId,
        model=payload.model,
        prompt=payload.prompt,
        params=payload.params,
    )
    channel_row, selected_model, _, _, codex_cli, _, _ = resolve_generation_target(probe)
    normalized_params = normalize_generation_params(payload.params, api_mode=selected_model.apiMode, codex_cli=codex_cli)
    diagnostics = build_preflight_diagnostics(
        payload=payload,
        channel_row=channel_row,
        selected_model=selected_model,
        codex_cli=codex_cli,
        normalized_params=normalized_params,
    )
    return GenerationPreflightOut(
        ok=not any(item.level == "error" for item in diagnostics),
        predictedApiMode=selected_model.apiMode,
        codexCli=codex_cli,
        normalizedParams=normalized_params,
        diagnostics=diagnostics,
    )


@app.get("/api/generations", response_model=list[GenerationTaskOut])
def list_generations(user: UserOut = Depends(require_user)) -> list[GenerationTaskOut]:
    with get_conn() as conn:
        rows = conn.execute(
            "SELECT * FROM generation_tasks WHERE user_id = ? ORDER BY created_at DESC",
            (user.id,),
        ).fetchall()
    return [row_to_task(row) for row in rows]


@app.get("/api/generations/queue-stats", response_model=GenerationQueueStatsOut)
def get_generation_queue_stats(user: UserOut = Depends(require_user)) -> GenerationQueueStatsOut:
    with get_conn() as conn:
        overall_rows = conn.execute(
            """
            SELECT status, COUNT(*) AS count
            FROM generation_tasks
            WHERE status IN ('queued', 'running')
            GROUP BY status
            """
        ).fetchall()
        your_rows = conn.execute(
            """
            SELECT status, COUNT(*) AS count
            FROM generation_tasks
            WHERE user_id = ? AND status IN ('queued', 'running')
            GROUP BY status
            """,
            (user.id,),
        ).fetchall()

    overall_counts = {row["status"]: int(row["count"]) for row in overall_rows}
    your_counts = {row["status"]: int(row["count"]) for row in your_rows}
    runtime_counts = GENERATION_RUNTIME.snapshot()
    return GenerationQueueStatsOut(
        workerCount=runtime_counts["worker_count"],
        queuedCount=overall_counts.get("queued", 0),
        runningCount=overall_counts.get("running", 0),
        yourQueuedCount=your_counts.get("queued", 0),
        yourRunningCount=your_counts.get("running", 0),
    )


def insert_generation(payload: GenerationTaskIn, user_id: str) -> GenerationTaskOut:
    task_id = payload.id or new_id()
    created_at = payload.createdAt or now_ms()
    with get_conn() as conn:
        conn.execute(
            """
            INSERT OR REPLACE INTO generation_tasks (
              id, user_id, template_id, template_version_id, project_id, parent_task_id, experiment_id, variation_label, prompt, params_json,
              input_image_ids_json, mask_target_image_id, mask_image_id, output_image_ids_json, actual_params_json,
              actual_params_by_image_json, revised_prompt_by_image_json, status, error, created_at,
              finished_at, elapsed, is_favorite, diagnostics_json, channel_id, api_mode, model
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            """,
            (
                task_id,
                user_id,
                payload.templateId,
                payload.templateVersionId,
                payload.projectId,
                payload.parentTaskId,
                payload.experimentId,
                payload.variationLabel,
                payload.prompt,
                payload.params.model_dump_json(),
                json_dumps(payload.inputImageIds),
                payload.maskTargetImageId,
                payload.maskImageId,
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
                json_dumps([item.model_dump() for item in payload.diagnostics]),
                payload.channelId,
                payload.apiMode,
                payload.model,
            ),
        )
        row = conn.execute("SELECT * FROM generation_tasks WHERE id = ? AND user_id = ?", (task_id, user_id)).fetchone()
    return row_to_task(row)


@app.post("/api/generations", response_model=GenerationTaskOut)
def create_generation(payload: GenerationTaskIn, user: UserOut = Depends(require_user)) -> GenerationTaskOut:
    next_payload = payload.model_copy(update={"projectId": resolve_owned_project_id(payload.projectId, user)})
    return insert_generation(next_payload, user.id)


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
    project_id = resolve_owned_project_id(next_task.projectId, user)
    with get_conn() as conn:
        conn.execute(
            """
            UPDATE generation_tasks SET
              template_id = ?, template_version_id = ?, project_id = ?, parent_task_id = ?, experiment_id = ?, variation_label = ?, prompt = ?, params_json = ?,
              input_image_ids_json = ?, mask_target_image_id = ?, mask_image_id = ?, output_image_ids_json = ?,
              actual_params_json = ?, actual_params_by_image_json = ?, revised_prompt_by_image_json = ?,
              status = ?, error = ?, finished_at = ?, elapsed = ?, is_favorite = ?, diagnostics_json = ?,
              channel_id = ?, api_mode = ?, model = ?
            WHERE id = ? AND user_id = ?
            """,
            (
                next_task.templateId,
                next_task.templateVersionId,
                project_id,
                next_task.parentTaskId,
                next_task.experimentId,
                next_task.variationLabel,
                next_task.prompt,
                next_task.params.model_dump_json(),
                json_dumps(next_task.inputImageIds),
                next_task.maskTargetImageId,
                next_task.maskImageId,
                json_dumps(next_task.outputImages),
                json_dumps(next_task.actualParams) if next_task.actualParams is not None else None,
                json_dumps(next_task.actualParamsByImage) if next_task.actualParamsByImage is not None else None,
                json_dumps(next_task.revisedPromptByImage) if next_task.revisedPromptByImage is not None else None,
                next_task.status,
                next_task.error,
                next_task.finishedAt,
                next_task.elapsed,
                int(next_task.isFavorite),
                json_dumps([item.model_dump() for item in next_task.diagnostics]),
                next_task.channelId,
                next_task.apiMode,
                next_task.model,
                task_id,
                user.id,
            ),
        )
        row = conn.execute("SELECT * FROM generation_tasks WHERE id = ? AND user_id = ?", (task_id, user.id)).fetchone()
    return row_to_task(row)


@app.delete("/api/generations/{task_id}")
def delete_generation(task_id: str, user: UserOut = Depends(require_user)) -> dict[str, bool]:
    with get_conn() as conn:
        task_row = conn.execute(
            "SELECT * FROM generation_tasks WHERE id = ? AND user_id = ?",
            (task_id, user.id),
        ).fetchone()
        if not task_row:
            raise HTTPException(status_code=404, detail="Generation not found")

        asset_rows = conn.execute(
            "SELECT * FROM assets WHERE task_id = ? AND user_id = ?",
            (task_id, user.id),
        ).fetchall()
        cur = conn.execute("DELETE FROM generation_tasks WHERE id = ? AND user_id = ?", (task_id, user.id))

        for asset_row in asset_rows:
            asset_id = asset_row["id"]
            token = f'"{asset_id}"'
            still_used = conn.execute(
                """
                SELECT 1
                FROM generation_tasks
                WHERE user_id = ?
                  AND id != ?
                  AND (
                    mask_image_id = ?
                    OR instr(input_image_ids_json, ?) > 0
                    OR instr(output_image_ids_json, ?) > 0
                  )
                LIMIT 1
                """,
                (user.id, task_id, asset_id, token, token),
            ).fetchone()
            template_cover = conn.execute(
                "SELECT 1 FROM prompt_templates WHERE cover_image_id = ? LIMIT 1",
                (asset_id,),
            ).fetchone()
            if still_used or template_cover:
                conn.execute("UPDATE assets SET task_id = NULL WHERE id = ? AND user_id = ?", (asset_id, user.id))
                continue
            conn.execute("DELETE FROM assets WHERE id = ? AND user_id = ?", (asset_id, user.id))
            delete_asset_files(asset_row)
    if cur.rowcount == 0:
        raise HTTPException(status_code=404, detail="Generation not found")
    return {"ok": True}


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
        row = conn.execute("SELECT * FROM assets WHERE id = ?", (asset_id,)).fetchone()
        if not row:
            raise HTTPException(status_code=404, detail="Asset not found")
        if row["user_id"] != user.id and not asset_is_publicly_visible(conn, row):
            raise HTTPException(status_code=404, detail="Asset not found")
    if not row:
        raise HTTPException(status_code=404, detail="Asset not found")
    return FileResponse(row["path"], media_type=row["mime"])


@app.get("/api/assets/{asset_id}/thumbnail")
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


@app.post("/api/assets/{asset_id}/copy-to-clipboard")
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


@app.delete("/api/assets/{asset_id}")
def delete_asset(asset_id: str, user: UserOut = Depends(require_user)) -> dict[str, bool]:
    with get_conn() as conn:
        row = conn.execute("SELECT * FROM assets WHERE id = ? AND user_id = ?", (asset_id, user.id)).fetchone()
        if not row:
            raise HTTPException(status_code=404, detail="Asset not found")
        conn.execute("DELETE FROM assets WHERE id = ? AND user_id = ?", (asset_id, user.id))

    delete_asset_files(row)
    return {"ok": True}


def resolve_generation_target(payload: GenerateIn) -> tuple[Any, ChannelModel, str, str, bool, float, CodexCliMode]:
    channel_row, selected_model = get_enabled_channel_model(payload.channelId, payload.model)
    api_key = (channel_row["api_key"] or "").strip()
    if not api_key:
        raise HTTPException(status_code=400, detail="The selected channel does not have an API key configured")
    base_url = normalize_base_url(channel_row["base_url"])
    timeout = float(channel_row["timeout_seconds"] or settings.request_timeout_seconds)
    mode = normalize_codex_cli_mode(channel_row["codex_cli_mode"] if "codex_cli_mode" in channel_row.keys() else None)
    return channel_row, selected_model, api_key, base_url, effective_codex_cli(channel_row), timeout, mode


def generation_diagnostic(
    code: str,
    level: str,
    title: str,
    detail: str,
    hint: str | None = None,
) -> GenerationDiagnosticOut:
    return GenerationDiagnosticOut(code=code, level=level, title=title, detail=detail, hint=hint)


def normalize_generation_params(params: TaskParams, *, api_mode: str, codex_cli: bool) -> TaskParams:
    updates: dict[str, Any] = {}
    if params.n < 1:
        updates["n"] = 1
    if params.output_format == "png" and params.output_compression is not None:
        updates["output_compression"] = None
    if api_mode == "responses" and params.moderation != "auto":
        updates["moderation"] = "auto"
    if codex_cli and params.quality != "auto":
        updates["quality"] = "auto"
    return params.model_copy(update=updates) if updates else params


POLICY_MARKERS = (
    "content_policy",
    "content policy",
    "policy",
    "safety",
    "sensitive",
    "moderation",
    "violat",
    "not allowed",
    "disallowed",
    "拒绝",
    "违规",
    "不允许",
    "审核",
    "拦截",
)


def looks_like_policy_rejection(text: str) -> bool:
    value = text.lower()
    return any(marker in value for marker in POLICY_MARKERS)


def build_preflight_diagnostics(
    *,
    payload: GenerationPreflightIn,
    channel_row: Any,
    selected_model: ChannelModel,
    codex_cli: bool,
    normalized_params: TaskParams,
) -> list[GenerationDiagnosticOut]:
    diagnostics: list[GenerationDiagnosticOut] = []
    prompt_text = payload.prompt.strip()
    if not prompt_text:
        diagnostics.append(
            generation_diagnostic("empty_prompt", "error", "提示词为空", "提交前需要先填写提示词。")
        )
    elif len(prompt_text) < 12:
        diagnostics.append(
            generation_diagnostic(
                "short_prompt",
                "warning",
                "提示词偏短",
                "当前提示词信息量较少，结果稳定性可能较低。",
                "建议补充主体、场景、风格、光线或镜头信息。",
            )
        )

    if payload.hasMask and payload.inputImageCount == 0:
        diagnostics.append(
            generation_diagnostic(
                "mask_without_input",
                "error",
                "缺少被编辑图片",
                "使用遮罩编辑时，至少需要上传一张目标图片。",
            )
        )

    if payload.inputImageCount >= 8:
        diagnostics.append(
            generation_diagnostic(
                "many_inputs",
                "info",
                "参考图较多",
                f"当前挂载了 {payload.inputImageCount} 张参考图，上游耗时和失败概率可能上升。",
            )
        )

    if normalized_params.quality != payload.params.quality:
        diagnostics.append(
            generation_diagnostic(
                "quality_normalized",
                "info",
                "质量参数已归一化",
                f"当前渠道按 {selected_model.apiMode} / {'Codex CLI' if codex_cli else '标准'} 路径运行，quality 将按 {normalized_params.quality} 提交。",
            )
        )

    if normalized_params.moderation != payload.params.moderation:
        diagnostics.append(
            generation_diagnostic(
                "moderation_normalized",
                "info",
                "审核参数已归一化",
                f"{selected_model.apiMode} 模式下 moderation 将按 {normalized_params.moderation} 提交。",
            )
        )

    if normalized_params.output_compression != payload.params.output_compression:
        diagnostics.append(
            generation_diagnostic(
                "compression_ignored",
                "info",
                "压缩参数未生效",
                "PNG 输出不会使用 output_compression。",
            )
        )

    health_status = normalize_channel_health_status(channel_row["health_status"] if "health_status" in channel_row.keys() else None)
    compatibility_status = normalize_channel_compatibility_status(
        channel_row["compatibility_status"] if "compatibility_status" in channel_row.keys() else None
    )
    if health_status in {"degraded", "error"}:
        diagnostics.append(
            generation_diagnostic(
                "channel_unhealthy",
                "warning",
                "渠道健康度异常",
                channel_row["health_message"] or "最近一次渠道检测不理想，可能影响成功率。",
                "可以先在渠道面板里复检健康度。",
            )
        )
    elif health_status == "unknown":
        diagnostics.append(
            generation_diagnostic(
                "channel_unchecked",
                "info",
                "渠道尚未体检",
                "这个渠道还没有最近的健康检测结果。",
            )
        )

    if compatibility_status == "unknown" and normalize_codex_cli_mode(channel_row["codex_cli_mode"]) == "auto":
        diagnostics.append(
            generation_diagnostic(
                "compatibility_unknown",
                "info",
                "接口类型待确认",
                "当前仍按自动模式推断上游接口类型，首次生成后会进一步记忆。",
                "管理员也可以在渠道面板手动执行一次“识别接口”。",
            )
        )

    if looks_like_policy_rejection(prompt_text):
        diagnostics.append(
            generation_diagnostic(
                "policy_risk",
                "warning",
                "可能触发上游审核",
                "提示词里包含容易触发安全策略的描述，可能导致接口直接拒绝生成或返回空结果。",
                "建议先弱化敏感、成人、暴力、侵权或名人肖像相关表达。",
            )
        )

    return diagnostics


def diagnostics_from_generation_exception(exc: Exception) -> list[GenerationDiagnosticOut]:
    if isinstance(exc, httpx.TimeoutException):
        return [
            generation_diagnostic(
                "upstream_timeout",
                "error",
                "上游响应超时",
                "生成请求超过渠道配置的超时时间，任务被中断。",
                "可以降低参考图数量、简化提示词，或由管理员提高该渠道超时时间。",
            )
        ]

    if isinstance(exc, httpx.HTTPStatusError):
        text = exc.response.text or ""
        status_code = exc.response.status_code
        if looks_like_policy_rejection(text):
            return [
                generation_diagnostic(
                    "policy_rejected",
                    "error",
                    "上游拒绝生成",
                    compact_message(text or f"HTTP {status_code}", 220),
                    "通常是提示词或参考图触发了上游内容策略。",
                )
            ]
        if is_unsupported_quality_error(exc):
            return [
                generation_diagnostic(
                    "unsupported_quality",
                    "warning",
                    "质量参数不受支持",
                    compact_message(text or f"HTTP {status_code}", 220),
                    "这个接口更像 Codex CLI 风格，建议改成自动识别或直接切到 Codex CLI。",
                )
            ]
        if status_code == 429:
            return [
                generation_diagnostic(
                    "rate_limited",
                    "error",
                    "上游限流",
                    compact_message(text or "请求过于频繁", 220),
                    "稍后重试，或切换到别的渠道 / 模型。",
                )
            ]
        return [
            generation_diagnostic(
                "upstream_http_error",
                "error",
                f"上游返回 HTTP {status_code}",
                compact_message(text or f"HTTP {status_code}", 220),
            )
        ]

    if isinstance(exc, HTTPException):
        detail = exc.detail if isinstance(exc.detail, str) else json_dumps(exc.detail)
        return [
            generation_diagnostic(
                "request_rejected",
                "error",
                "请求未通过本地校验",
                compact_message(detail, 220),
            )
        ]

    if isinstance(exc, ValidationError):
        return [
            generation_diagnostic(
                "response_parse_error",
                "error",
                "响应解析失败",
                compact_message(str(exc), 220),
            )
        ]

    message = str(exc)
    if looks_like_policy_rejection(message):
        return [
            generation_diagnostic(
                "policy_rejected",
                "error",
                "上游拒绝生成",
                compact_message(message, 220),
                "这类情况常见于违规、敏感或成人导向内容。",
            )
        ]
    if "接口未返回可用图片数据" in message:
        return [
            generation_diagnostic(
                "no_image_data",
                "error",
                "接口未返回图片",
                compact_message(message, 220),
                "如果不是网络问题，常见原因是上游审核拦截、参数不兼容，或接口只返回了文本错误。",
            )
        ]
    return [
        generation_diagnostic(
            "unknown_error",
            "error",
            "生成失败",
            compact_message(message, 220),
        )
    ]


def pick_actual_params(source: dict[str, Any]) -> dict[str, Any]:
    keys = ["size", "quality", "output_format", "output_compression", "moderation", "n"]
    return {key: source[key] for key in keys if key in source and source[key] is not None}


def normalize_base64_image(value: str, fallback_mime: str) -> str:
    return value if value.startswith("data:") else f"data:{fallback_mime};base64,{value}"


def compact_response_text(value: Any, limit: int = 420) -> str:
    if value is None:
        return ""
    if isinstance(value, (dict, list)):
        text = json_dumps(value)
    else:
        text = str(value)
    return compact_message(text, limit)


def upstream_no_image_reason(data: Any, endpoint: str) -> str:
    if not isinstance(data, dict):
        return f"{endpoint} 返回非对象 JSON：{compact_response_text(data)}"

    error = data.get("error")
    if isinstance(error, dict):
        message = error.get("message") or error.get("detail") or error.get("code") or error
        return f"{endpoint} 返回错误但 HTTP 状态为成功：{compact_response_text(message)}"
    if isinstance(error, str) and error.strip():
        return f"{endpoint} 返回错误但 HTTP 状态为成功：{compact_response_text(error)}"

    if endpoint == "responses":
        output = data.get("output")
        if not isinstance(output, list):
            return f"responses 响应缺少 output 数组；顶层字段：{', '.join(data.keys()) or '空'}"
        if not output:
            return "responses 响应 output 为空"
        details: list[str] = []
        for item in output[:4]:
            if not isinstance(item, dict):
                details.append(compact_response_text(item, 120))
                continue
            item_type = str(item.get("type") or "unknown")
            status = str(item.get("status") or "").strip()
            parts = [item_type]
            if status:
                parts.append(f"status={status}")
            if item.get("result") in ("", None):
                parts.append("result为空")
            for key in ("refusal", "reason", "message"):
                if item.get(key):
                    parts.append(f"{key}={compact_response_text(item.get(key), 160)}")
                    break
            content = item.get("content")
            if isinstance(content, list):
                text = next(
                    (
                        part.get("text")
                        for part in content
                        if isinstance(part, dict) and isinstance(part.get("text"), str) and part.get("text", "").strip()
                    ),
                    "",
                )
                if text:
                    parts.append(f"text={compact_response_text(text, 160)}")
            details.append(" ".join(parts))
        return f"responses 未返回 image_generation_call.result；output 摘要：{'; '.join(details)}"

    items = data.get("data")
    if not isinstance(items, list):
        return f"images 响应缺少 data 数组；顶层字段：{', '.join(data.keys()) or '空'}"
    if not items:
        return "images 响应 data 为空"
    item_summaries: list[str] = []
    for item in items[:4]:
        if not isinstance(item, dict):
            item_summaries.append(compact_response_text(item, 120))
            continue
        keys = sorted(item.keys())
        reason = item.get("revised_prompt") or item.get("message") or item.get("reason")
        item_summaries.append(
            f"字段={','.join(keys) or '空'}"
            + (f"；说明={compact_response_text(reason, 160)}" if reason else "")
        )
    return f"images data 中没有 b64_json/url；条目摘要：{'; '.join(item_summaries)}"


async def fetch_image_as_data_url(client: httpx.AsyncClient, url: str, fallback_mime: str) -> str:
    response = await client.get(url)
    response.raise_for_status()
    mime = response.headers.get("content-type", fallback_mime).split(";")[0]
    return bytes_to_data_url(mime, response.content)


def is_unsupported_quality_error(exc: httpx.HTTPStatusError) -> bool:
    if exc.response.status_code < 400 or exc.response.status_code >= 500:
        return False
    text = exc.response.text.lower()
    if "quality" not in text:
        return False
    markers = [
        "unsupported",
        "not supported",
        "does not support",
        "unknown",
        "unrecognized",
        "unexpected",
        "extra",
        "not permitted",
        "not allowed",
        "invalid parameter",
        "不支持",
        "未知",
    ]
    return any(marker in text for marker in markers)


def remember_auto_codex_detection(channel_id: str, codex_cli: bool) -> None:
    status: ChannelCompatibilityStatus = "codex" if codex_cli else "standard"
    message = "生成请求自动检测为 Codex CLI 风格" if codex_cli else "生成请求自动检测为标准 OpenAI 风格"
    with get_conn() as conn:
        conn.execute(
            """
            UPDATE api_channels
            SET codex_cli = ?, compatibility_status = ?, compatibility_message = ?, compatibility_checked_at = ?, updated_at = ?
            WHERE id = ? AND codex_cli_mode = 'auto'
            """,
            (int(codex_cli), status, message, now_ms(), now_ms(), channel_id),
        )


async def call_upstream_once(
    client: httpx.AsyncClient,
    payload: GenerateIn,
    selected_model: ChannelModel,
    api_key: str,
    base_url: str,
    fallback_mime: str,
    codex_cli: bool,
) -> tuple[list[str], dict[str, Any] | None, list[dict[str, Any] | None], list[str | None]]:
    headers = {
        "Authorization": f"Bearer {api_key}",
        "Cache-Control": "no-store, no-cache, max-age=0",
        "Pragma": "no-cache",
    }

    if selected_model.apiMode == "responses":
        body: dict[str, Any] = {
            "model": selected_model.id,
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
                    **({} if codex_cli else {"quality": payload.params.quality}),
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
            raise ValueError(f"接口未返回可用图片数据：{upstream_no_image_reason(data, 'responses')}")
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
            "model": selected_model.id,
            "prompt": payload.prompt if not codex_cli else f"Use the following text as the complete prompt. Do not rewrite it:\n{payload.prompt}",
            "size": payload.params.size,
            "output_format": payload.params.output_format,
            "moderation": payload.params.moderation,
        }
        if not codex_cli:
            form["quality"] = payload.params.quality
        if payload.params.output_format != "png" and payload.params.output_compression is not None:
            form["output_compression"] = str(payload.params.output_compression)
        if payload.params.n > 1:
            form["n"] = str(payload.params.n)
        response = await client.post(endpoint_url(base_url, "images/edits"), headers=headers, data=form, files=files)
    else:
        body = {
            "model": selected_model.id,
            "prompt": payload.prompt if not codex_cli else f"Use the following text as the complete prompt. Do not rewrite it:\n{payload.prompt}",
            "size": payload.params.size,
            "output_format": payload.params.output_format,
            "moderation": payload.params.moderation,
        }
        if not codex_cli:
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
        raise ValueError(f"接口未返回可用图片数据：{upstream_no_image_reason(data, 'images')}")
    actual_params = pick_actual_params(data) or None
    return images, actual_params, [actual_params for _ in images], revised_prompts


async def call_upstream(payload: GenerateIn) -> tuple[list[str], dict[str, Any] | None, list[dict[str, Any] | None], list[str | None]]:
    channel_row, selected_model, api_key, base_url, codex_cli, timeout, codex_cli_mode = resolve_generation_target(payload)
    fallback_mime = {
        "png": "image/png",
        "jpeg": "image/jpeg",
        "webp": "image/webp",
    }.get(payload.params.output_format, "image/png")

    async with httpx.AsyncClient(timeout=timeout) as client:
        try:
            result = await call_upstream_once(client, payload, selected_model, api_key, base_url, fallback_mime, codex_cli)
            record_channel_health(channel_row["id"], "healthy", "最近一次生成请求成功")
            if codex_cli_mode == "auto":
                remember_auto_codex_detection(channel_row["id"], codex_cli)
            return result
        except httpx.HTTPStatusError as exc:
            if codex_cli_mode == "auto" and not codex_cli and is_unsupported_quality_error(exc):
                remember_auto_codex_detection(channel_row["id"], True)
                result = await call_upstream_once(client, payload, selected_model, api_key, base_url, fallback_mime, True)
                record_channel_health(channel_row["id"], "healthy", "最近一次生成请求成功")
                return result
            status: ChannelHealthStatus = "error" if exc.response.status_code not in {404, 429} else "degraded"
            record_channel_health(channel_row["id"], status, f"最近一次生成请求失败，HTTP {exc.response.status_code}")
            raise
        except httpx.TimeoutException:
            record_channel_health(channel_row["id"], "error", "最近一次生成请求超时")
            raise
        except httpx.HTTPError:
            record_channel_health(channel_row["id"], "error", "最近一次生成请求失败")
            raise
        except ValueError:
            record_channel_health(channel_row["id"], "degraded", "最近一次生成请求未返回可用图片")
            raise


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


def record_template_generation_result(template_id: str | None, success: bool) -> None:
    if not template_id:
        return
    with get_conn() as conn:
        conn.execute(
            f"""
            UPDATE prompt_templates
            SET {'success_count' if success else 'failure_count'} = COALESCE({'success_count' if success else 'failure_count'}, 0) + 1,
                updated_at = CASE WHEN visibility = 'private' THEN ? ELSE updated_at END
            WHERE id = ?
            """,
            (now_ms(), template_id),
        )
        recalculate_template_quality(conn, template_id)


def get_generation_status(task_id: str, user_id: str) -> str | None:
    with get_conn() as conn:
        row = conn.execute(
            "SELECT status FROM generation_tasks WHERE id = ? AND user_id = ?",
            (task_id, user_id),
        ).fetchone()
    return row["status"] if row else None


def ensure_generation_not_canceled(task_id: str, user_id: str) -> None:
    if get_generation_status(task_id, user_id) == "canceled":
        raise asyncio.CancelledError()


def mark_generation_running(task_id: str, user_id: str) -> GenerationTaskOut | None:
    with get_conn() as conn:
        row = conn.execute(
            "SELECT * FROM generation_tasks WHERE id = ? AND user_id = ?",
            (task_id, user_id),
        ).fetchone()
        if not row:
            return None
        if row["status"] == "canceled":
            return row_to_task(row)
        if row["status"] == "queued":
            conn.execute(
                """
                UPDATE generation_tasks
                SET status = 'running', error = NULL, finished_at = NULL, elapsed = NULL, diagnostics_json = '[]'
                WHERE id = ? AND user_id = ?
                """,
                (task_id, user_id),
            )
            row = conn.execute(
                "SELECT * FROM generation_tasks WHERE id = ? AND user_id = ?",
                (task_id, user_id),
            ).fetchone()
    return row_to_task(row)


def mark_generation_canceled(
    task_id: str,
    user_id: str,
    started_at: int | None = None,
    actor: UserOut | None = None,
) -> GenerationTaskOut:
    finished_at = now_ms()
    with get_conn() as conn:
        row = conn.execute(
            "SELECT * FROM generation_tasks WHERE id = ? AND user_id = ?",
            (task_id, user_id),
        ).fetchone()
        if not row:
            raise HTTPException(status_code=404, detail="Generation not found")
        if row["status"] not in FINAL_TASK_STATUSES:
            elapsed = finished_at - (started_at or row["created_at"] or finished_at)
            conn.execute(
                """
                UPDATE generation_tasks
                SET status = 'canceled', error = ?, finished_at = ?, elapsed = ?
                WHERE id = ? AND user_id = ?
                """,
                ("已取消", finished_at, max(0, elapsed), task_id, user_id),
            )
            insert_audit_log(
                conn,
                actor,
                "generation.cancel",
                "generation_task",
                task_id,
                {"prompt": compact_message(row["prompt"], 120), "previousStatus": row["status"]},
            )
        updated = conn.execute(
            "SELECT * FROM generation_tasks WHERE id = ? AND user_id = ?",
            (task_id, user_id),
        ).fetchone()
    return row_to_task(updated)


def recover_pending_generation_tasks() -> None:
    with get_conn() as conn:
        conn.execute(
            """
            UPDATE generation_tasks
            SET status = 'queued',
                error = CASE WHEN status = 'running' THEN ? ELSE error END,
                finished_at = NULL,
                elapsed = NULL
            WHERE status IN ('queued', 'running')
            """,
            ("后端重启后已自动重试",),
        )


def load_generation_context(task_id: str) -> tuple[Any, UserOut] | None:
    with get_conn() as conn:
        row = conn.execute("SELECT * FROM generation_tasks WHERE id = ?", (task_id,)).fetchone()
        if not row:
            return None
        user_row = conn.execute("SELECT * FROM users WHERE id = ?", (row["user_id"],)).fetchone()
    if not user_row:
        return None
    return row, row_to_user(user_row)


def prepare_generation_execution(task_id: str) -> GenerationExecution | None:
    context = load_generation_context(task_id)
    if not context:
        return None
    row, user = context
    current = mark_generation_running(task_id, user.id)
    if not current or current.status == "canceled":
        return None
    payload = generation_payload_from_row(row, user)
    return GenerationExecution(
        task_id=task_id,
        user_id=user.id,
        started_at=row["created_at"],
        payload=payload,
        user=user,
    )


async def enqueue_pending_generation_tasks() -> None:
    with get_conn() as conn:
        rows = conn.execute(
            "SELECT id FROM generation_tasks WHERE status = 'queued' ORDER BY created_at ASC",
        ).fetchall()
    for row in rows:
        task_id = row["id"]
        if task_id in GENERATION_RUNTIME.queued_task_ids or task_id in GENERATION_RUNTIME.active_tasks:
            continue
        await GENERATION_RUNTIME.queue_task(task_id)


async def complete_generation_task(payload: GenerateIn, user: UserOut, started_at: int) -> GenerateOut:
    task_id = payload.taskId or new_id()
    try:
        ensure_generation_not_canceled(task_id, user.id)
        ensure_generation_not_canceled(task_id, user.id)
        images, actual_params, actual_params_list, revised_prompts = await call_upstream(payload)
        ensure_generation_not_canceled(task_id, user.id)
        output_assets: list[AssetOut] = []
        for data_url in images:
            ensure_generation_not_canceled(task_id, user.id)
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
        ensure_generation_not_canceled(task_id, user.id)
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
        record_template_generation_result(payload.templateId, True)
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
        diagnostics = diagnostics_from_generation_exception(exc)
        patch_generation(
            task_id,
            GenerationTaskPatch(
                status="error",
                error=str(exc),
                finishedAt=finished_at,
                elapsed=finished_at - started_at,
                diagnostics=diagnostics,
            ),
            user,
        )
        record_template_generation_result(payload.templateId, False)
        raise


async def complete_generation_task_safely(payload: GenerateIn, user: UserOut, started_at: int) -> None:
    try:
        await complete_generation_task(payload, user, started_at)
    except Exception as exc:
        if payload.taskId:
            finished_at = now_ms()
            diagnostics = diagnostics_from_generation_exception(exc)
            patch_generation(
                payload.taskId,
                GenerationTaskPatch(
                    status="error",
                    error=str(exc),
                    finishedAt=finished_at,
                    elapsed=finished_at - started_at,
                    diagnostics=diagnostics,
                ),
                user,
            )
        return


GENERATION_RUNTIME = GenerationRuntime(
    prepare_execution=prepare_generation_execution,
    run_execution=complete_generation_task_safely,
    mark_canceled=lambda task_id, user_id, started_at: mark_generation_canceled(task_id, user_id, started_at),
    worker_count=settings.generation_worker_count,
)


def ensure_generation_workers() -> None:
    GENERATION_RUNTIME.ensure_workers()


async def auto_import_scheduler() -> None:
    while True:
        try:
            settings_data, _ = read_auto_import_settings()
            if should_run_auto_import_now(settings_data):
                actor = first_admin_user()
                if actor:
                    try:
                        await perform_auto_import("scheduled", actor)
                    except HTTPException as exc:
                        if exc.status_code != 409:
                            raise
        except asyncio.CancelledError:
            raise
        except Exception:
            pass
        await asyncio.sleep(60)


def ensure_auto_import_worker() -> None:
    try:
        current_loop = asyncio.get_running_loop()
    except RuntimeError:
        return

    live_tasks: set[asyncio.Task[None]] = set()
    for task in AUTO_IMPORT_WORKER_TASKS:
        try:
            task_loop = task.get_loop()
        except RuntimeError:
            continue
        if not task.done() and task_loop is current_loop and not task_loop.is_closed():
            live_tasks.add(task)

    AUTO_IMPORT_WORKER_TASKS.clear()
    AUTO_IMPORT_WORKER_TASKS.update(live_tasks)
    if AUTO_IMPORT_WORKER_TASKS:
        return

    worker = asyncio.create_task(auto_import_scheduler(), name="auto-import-scheduler")
    AUTO_IMPORT_WORKER_TASKS.add(worker)
    worker.add_done_callback(lambda task: AUTO_IMPORT_WORKER_TASKS.discard(task))


@app.post("/api/generations/run", response_model=GenerateRunOut)
async def run_generation(payload: GenerateIn, user: UserOut = Depends(require_user)) -> GenerateRunOut:
    _, selected_model, _, _, codex_cli, _, _ = resolve_generation_target(payload)
    task_id = payload.taskId or new_id()
    payload = payload.model_copy(
        update={
            "taskId": task_id,
            "params": normalize_generation_params(payload.params, api_mode=selected_model.apiMode, codex_cli=codex_cli),
        }
    )
    started_at = now_ms()
    input_image_ids, mask_target_image_id, mask_image_id = persist_generation_inputs(
        payload.model_copy(update={"taskId": None}),
        user,
    )
    task = insert_generation(
        GenerationTaskIn(
            id=task_id,
            templateId=payload.templateId,
            templateVersionId=payload.templateVersionId,
            projectId=resolve_owned_project_id(payload.projectId, user),
            parentTaskId=payload.parentTaskId,
            experimentId=payload.experimentId,
            variationLabel=payload.variationLabel,
            prompt=payload.prompt,
            params=payload.params,
            inputImageIds=input_image_ids,
            maskTargetImageId=mask_target_image_id,
            maskImageId=mask_image_id,
            outputImages=[],
            status="queued",
            createdAt=started_at,
            channelId=payload.channelId,
            apiMode=selected_model.apiMode,
            model=selected_model.id,
        ),
        user.id,
    )
    generation_asset_ids = [*input_image_ids, *([mask_image_id] if mask_image_id else [])]
    attach_assets_to_task(user_id=user.id, task_id=task_id, asset_ids=generation_asset_ids)
    ensure_generation_workers()
    await GENERATION_RUNTIME.queue_task(task_id)
    return GenerateRunOut(task=task)


@app.post("/api/generations/{task_id}/cancel", response_model=GenerationTaskOut)
async def cancel_generation(task_id: str, user: UserOut = Depends(require_user)) -> GenerationTaskOut:
    existing = get_generation(task_id, user)
    if existing.status in FINAL_TASK_STATUSES:
        return existing

    GENERATION_RUNTIME.discard_queued(task_id)
    GENERATION_RUNTIME.cancel_active(task_id)
    return mark_generation_canceled(task_id, user.id, actor=user)


@app.post("/api/generate", response_model=GenerateOut)
async def generate(payload: GenerateIn, user: UserOut = Depends(require_user)) -> GenerateOut:
    _, selected_model, _, _, codex_cli, _, _ = resolve_generation_target(payload)
    task_id = payload.taskId or new_id()
    payload = payload.model_copy(
        update={
            "taskId": task_id,
            "params": normalize_generation_params(payload.params, api_mode=selected_model.apiMode, codex_cli=codex_cli),
        }
    )
    started_at = now_ms()
    input_image_ids, mask_target_image_id, mask_image_id = persist_generation_inputs(
        payload.model_copy(update={"taskId": None}),
        user,
    )
    insert_generation(
        GenerationTaskIn(
            id=task_id,
            templateId=payload.templateId,
            templateVersionId=payload.templateVersionId,
            projectId=resolve_owned_project_id(payload.projectId, user),
            parentTaskId=payload.parentTaskId,
            experimentId=payload.experimentId,
            variationLabel=payload.variationLabel,
            prompt=payload.prompt,
            params=payload.params,
            inputImageIds=input_image_ids,
            maskTargetImageId=mask_target_image_id,
            maskImageId=mask_image_id,
            outputImages=[],
            status="running",
            createdAt=started_at,
            channelId=payload.channelId,
            apiMode=selected_model.apiMode,
            model=selected_model.id,
        ),
        user.id,
    )
    generation_asset_ids = [*input_image_ids, *([mask_image_id] if mask_image_id else [])]
    attach_assets_to_task(user_id=user.id, task_id=task_id, asset_ids=generation_asset_ids)
    try:
        return await complete_generation_task(payload, user, started_at)
    except (httpx.HTTPError, ValueError, ValidationError, HTTPException) as exc:
        raise HTTPException(status_code=502, detail=str(exc)) from exc


@app.get("/", include_in_schema=False)
def serve_frontend_index() -> FileResponse:
    index_path = get_frontend_index_path()
    if index_path is None:
        raise HTTPException(status_code=503, detail="Frontend bundle is not available")
    return FileResponse(index_path)


@app.get("/{frontend_path:path}", include_in_schema=False)
def serve_frontend(frontend_path: str) -> FileResponse:
    if frontend_path.startswith("api/"):
        raise HTTPException(status_code=404, detail="Not found")
    file_path = resolve_frontend_file(frontend_path)
    if file_path is not None:
        return FileResponse(file_path)
    index_path = get_frontend_index_path()
    if index_path is None:
        raise HTTPException(status_code=503, detail="Frontend bundle is not available")
    return FileResponse(index_path)
