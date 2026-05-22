from __future__ import annotations

import io
import json
import re
import shutil
import tempfile
import time
import zipfile
from pathlib import Path
from typing import Any

from fastapi import APIRouter, Depends, File, HTTPException, Query, Response, UploadFile
from fastapi.responses import StreamingResponse

from ..config import settings
from ..db import get_conn
from ..schemas import (
    AuthSettingsOut,
    AuthSettingsPatch,
    AuditLogOut,
    InviteCodeBatchIn,
    InviteCodeIn,
    InviteCodeOut,
    InviteCodePatch,
    InviteCodeUseOut,
    SystemBackupImportOut,
    SystemBackupPreviewOut,
    UserOut,
    UserRolePatchIn,
)
from ..security import create_session_token, hash_password, new_id, now_ms
from ..helpers import (
    auth_settings_to_out,
    get_auth_settings,
    get_invite_code_row_or_404,
    insert_audit_log,
    row_to_audit_log,
    row_to_invite_code,
    row_to_invite_code_use,
    row_to_plain_dict,
    row_to_user,
    write_audit_log,
)
from ..state import DEFAULT_AUTH_SETTINGS
from ..dependencies import require_admin, set_session_cookie

router = APIRouter(prefix="/api/admin", tags=["admin"])

# ---------------------------------------------------------------------------
# Constants & helpers used only by admin routes
# ---------------------------------------------------------------------------

SERVER_BACKUP_TABLES = [
    "users",
    "auth_settings",
    "registration_invite_codes",
    "registration_invite_code_uses",
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

SERVER_BACKUP_DELETE_ORDER = [
    "sessions",
    "template_ratings",
    "prompt_template_versions",
    "assets",
    "generation_tasks",
    "prompt_templates",
    "projects",
    "registration_invite_code_uses",
    "registration_invite_codes",
    "api_channels",
    "audit_logs",
    "open_prompt_discoveries",
    "auto_import_runs",
    "auto_import_settings",
    "auth_settings",
    "users",
]


def save_auth_settings(conn: Any, registration_mode: str) -> dict[str, Any]:
    ts = now_ms()
    conn.execute(
        """
        INSERT INTO auth_settings (id, registration_mode, updated_at)
        VALUES ('default', ?, ?)
        ON CONFLICT(id) DO UPDATE SET
          registration_mode = excluded.registration_mode,
          updated_at = excluded.updated_at
        """,
        (registration_mode, ts),
    )
    return {
        "registrationMode": registration_mode,
        "updatedAt": ts,
    }


def generate_registration_invite_code() -> str:
    seed = re.sub(r"[^A-Z0-9]", "", new_id().upper())
    if len(seed) < 12:
        seed = f"{seed}{'X' * (12 - len(seed))}"
    return f"INV-{seed[:4]}-{seed[4:8]}-{seed[8:12]}"


def create_invite_code_record(
    conn: Any,
    *,
    note: str,
    max_uses: int | None,
    expires_at: int | None,
) -> Any:
    ts = now_ms()
    for _ in range(16):
        invite_id = new_id()
        code = generate_registration_invite_code()
        try:
            conn.execute(
                """
                INSERT INTO registration_invite_codes (
                  id, code, note, max_uses, used_count, is_enabled, expires_at, created_at, updated_at
                ) VALUES (?, ?, ?, ?, 0, 1, ?, ?, ?)
                """,
                (invite_id, code, note, max_uses, expires_at, ts, ts),
            )
            return conn.execute("SELECT * FROM registration_invite_codes WHERE id = ?", (invite_id,)).fetchone()
        except Exception as exc:
            if "UNIQUE" not in str(exc).upper():
                raise
    raise HTTPException(status_code=500, detail="邀请码生成失败，请重试")


def list_recent_invite_code_uses(conn: Any, invite_code_id: str, limit: int = 5) -> list[InviteCodeUseOut]:
    rows = conn.execute(
        """
        SELECT * FROM registration_invite_code_uses
        WHERE invite_code_id = ?
        ORDER BY used_at DESC, id DESC
        LIMIT ?
        """,
        (invite_code_id, limit),
    ).fetchall()
    return [row_to_invite_code_use(row) for row in rows]

# --- Backup helpers ---


def _backup_asset_archive_path(user_id: str, asset_id: str, path: Path, *, thumbnail: bool = False) -> str:
    if thumbnail:
        thumbnail_stem = f"{asset_id}.thumb"
        if path.name.startswith(thumbnail_stem):
            suffix = path.name[len(thumbnail_stem):]
            return f"assets/{user_id}/{thumbnail_stem}{suffix}"

    if path.name.startswith(asset_id):
        suffix = path.name[len(asset_id):]
    else:
        suffix = "".join(path.suffixes)

    stem = f"{asset_id}.thumb" if thumbnail else asset_id
    return f"assets/{user_id}/{stem}{suffix}"


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
            asset_rel_path = _backup_asset_archive_path(str(asset["user_id"]), asset_id, asset_path)
            archive.write(asset_path, asset_rel_path)
            thumbnail_rel_path: str | None = None
            thumbnail_path = Path(str(asset["thumbnail_path"])) if asset.get("thumbnail_path") else None
            if thumbnail_path and thumbnail_path.exists():
                thumbnail_rel_path = _backup_asset_archive_path(
                    str(asset["user_id"]),
                    asset_id,
                    thumbnail_path,
                    thumbnail=True,
                )
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


def read_server_backup_manifest(archive: zipfile.ZipFile) -> dict[str, Any]:
    try:
        return json.loads(archive.read("server-backup.json").decode("utf-8"))
    except KeyError as exc:
        raise HTTPException(status_code=400, detail="备份文件缺少 server-backup.json") from exc
    except json.JSONDecodeError as exc:
        raise HTTPException(status_code=400, detail="备份清单格式无效") from exc


def validate_server_backup_tables(manifest: dict[str, Any]) -> tuple[dict[str, list[dict[str, Any]]], dict[str, Any]]:
    tables = manifest.get("tables")
    if not isinstance(tables, dict):
        raise HTTPException(status_code=400, detail="备份清单缺少 tables")
    image_files = manifest.get("imageFiles") or {}
    if not isinstance(image_files, dict):
        raise HTTPException(status_code=400, detail="备份清单中的 imageFiles 无效")
    return tables, image_files


def ensure_restored_admin_user(tables: dict[str, list[dict[str, Any]]]) -> dict[str, list[dict[str, Any]]]:
    users = [dict(item) for item in tables.get("users") or [] if isinstance(item, dict)]
    if not users:
        raise HTTPException(status_code=400, detail="备份中没有用户数据，无法恢复")
    if not any(str(item.get("role")) == "admin" for item in users):
        users[0]["role"] = "admin"
        users[0]["updated_at"] = now_ms()
    tables["users"] = users
    return tables


def parse_server_backup_manifest(archive_bytes: bytes) -> tuple[dict[str, Any], dict[str, list[dict[str, Any]]], dict[str, Any]]:
    with zipfile.ZipFile(io.BytesIO(archive_bytes), mode="r") as archive:
        manifest = read_server_backup_manifest(archive)
    tables, image_files = validate_server_backup_tables(manifest)
    tables = ensure_restored_admin_user(tables)
    return manifest, tables, image_files


def build_server_backup_preview_data(
    manifest: dict[str, Any],
    tables: dict[str, list[dict[str, Any]]],
    image_files: dict[str, Any],
) -> SystemBackupPreviewOut:
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


def build_server_backup_preview(archive_bytes: bytes) -> SystemBackupPreviewOut:
    manifest, tables, image_files = parse_server_backup_manifest(archive_bytes)
    return build_server_backup_preview_data(manifest, tables, image_files)


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

# --- PLACEHOLDER_RESTORE ---


def stage_backup_assets(
    archive: zipfile.ZipFile,
    tables: dict[str, list[dict[str, Any]]],
    image_files: dict[str, Any],
    temp_dir: Path,
) -> Path:
    staged_asset_dir = temp_dir / "assets"
    staged_asset_dir.mkdir(parents=True, exist_ok=True)
    staged_paths: set[Path] = set()

    for asset in tables.get("assets") or []:
        if not isinstance(asset, dict):
            continue
        asset_id = str(asset.get("id") or "")
        if not asset_id:
            continue
        user_id = str(asset["user_id"])
        restored_asset_dir = settings.asset_dir / user_id
        file_info = image_files.get(asset_id)
        if not isinstance(file_info, dict):
            raise HTTPException(status_code=400, detail=f"备份中缺少资源文件映射：{asset_id}")
        file_path = str(file_info.get("path") or "")
        if not file_path:
            raise HTTPException(status_code=400, detail=f"备份中缺少资源文件：{asset_id}")
        target_dir = staged_asset_dir / user_id
        target_dir.mkdir(parents=True, exist_ok=True)
        target_name = Path(file_path).name
        target_path = target_dir / target_name
        if target_path in staged_paths:
            raise HTTPException(status_code=400, detail=f"备份中资源文件名冲突：{target_name}")
        try:
            target_path.write_bytes(archive.read(file_path))
        except KeyError as exc:
            raise HTTPException(status_code=400, detail=f"备份中找不到资源文件：{file_path}") from exc
        staged_paths.add(target_path)
        asset["path"] = str(restored_asset_dir / target_name)

        thumbnail_path = file_info.get("thumbnailPath")
        if thumbnail_path:
            thumbnail_name = Path(str(thumbnail_path)).name
            target_thumbnail_path = target_dir / thumbnail_name
            if target_thumbnail_path in staged_paths:
                raise HTTPException(status_code=400, detail=f"备份中缩略图文件名冲突：{thumbnail_name}")
            try:
                target_thumbnail_path.write_bytes(archive.read(str(thumbnail_path)))
            except KeyError as exc:
                raise HTTPException(status_code=400, detail=f"备份中找不到缩略图文件：{thumbnail_path}") from exc
            staged_paths.add(target_thumbnail_path)
            asset["thumbnail_path"] = str(restored_asset_dir / thumbnail_name)
        else:
            asset["thumbnail_path"] = None

    return staged_asset_dir


def swap_asset_directories(staged_asset_dir: Path, temp_dir: Path) -> tuple[Path, Path, bool, bool]:
    current_asset_dir = settings.asset_dir
    backup_asset_dir = temp_dir / "previous-assets"
    moved_existing_assets = False
    installed_staged_assets = False
    if current_asset_dir.exists():
        shutil.move(str(current_asset_dir), str(backup_asset_dir))
        moved_existing_assets = True
    shutil.move(str(staged_asset_dir), str(current_asset_dir))
    installed_staged_assets = True
    return current_asset_dir, backup_asset_dir, moved_existing_assets, installed_staged_assets


def rollback_asset_directories(
    current_asset_dir: Path,
    backup_asset_dir: Path,
    *,
    moved_existing_assets: bool,
    installed_staged_assets: bool,
) -> None:
    if installed_staged_assets and current_asset_dir.exists():
        shutil.rmtree(current_asset_dir)
    if moved_existing_assets and backup_asset_dir.exists():
        shutil.move(str(backup_asset_dir), str(current_asset_dir))


def finalize_asset_swap(backup_asset_dir: Path) -> None:
    if backup_asset_dir.exists():
        shutil.rmtree(backup_asset_dir)


def create_restored_session(conn: Any, restored_users: list[dict[str, Any]], actor: UserOut) -> str:
    target_user = next((row for row in restored_users if row["username"] == actor.username), None) or next(
        (row for row in restored_users if row["role"] == "admin"),
        restored_users[0],
    )
    session_token = create_session_token()
    conn.execute(
        "INSERT INTO sessions (id, user_id, created_at, expires_at) VALUES (?, ?, ?, ?)",
        (session_token, target_user["id"], now_ms(), None),
    )
    return session_token


def restore_auth_tables(conn: Any, tables: dict[str, list[dict[str, Any]]], actor: UserOut) -> list[dict[str, Any]]:
    restored_users = tables.get("users") or []
    for row in restored_users:
        imported_role = row["role"] if row["id"] == actor.id else "user"
        conn.execute(
            """
            INSERT INTO users (id, username, password_hash, role, created_at, updated_at)
            VALUES (?, ?, ?, ?, ?, ?)
            """,
            (
                row["id"],
                row["username"],
                row["password_hash"],
                imported_role,
                row["created_at"],
                row["updated_at"],
            ),
        )

    for row in tables.get("auth_settings") or []:
        conn.execute(
            """
            INSERT INTO auth_settings (id, registration_mode, updated_at)
            VALUES (?, ?, ?)
            """,
            (
                row["id"],
                row.get("registration_mode", DEFAULT_AUTH_SETTINGS["registrationMode"]),
                row["updated_at"],
            ),
        )

    for row in tables.get("registration_invite_codes") or []:
        conn.execute(
            """
            INSERT INTO registration_invite_codes (
              id, code, note, max_uses, used_count, is_enabled, expires_at, created_at, updated_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
            """,
            (
                row["id"],
                row["code"],
                row.get("note", ""),
                row.get("max_uses"),
                row.get("used_count", 0),
                row.get("is_enabled", 1),
                row.get("expires_at"),
                row["created_at"],
                row["updated_at"],
            ),
        )

    for row in tables.get("registration_invite_code_uses") or []:
        conn.execute(
            """
            INSERT INTO registration_invite_code_uses (
              id, invite_code_id, invite_code, user_id, username, used_at
            ) VALUES (?, ?, ?, ?, ?, ?)
            """,
            (
                row["id"],
                row.get("invite_code_id"),
                row["invite_code"],
                row.get("user_id"),
                row.get("username", ""),
                row["used_at"],
            ),
        )

    return restored_users


def restore_project_and_channel_tables(conn: Any, tables: dict[str, list[dict[str, Any]]]) -> None:
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


def restore_template_tables(conn: Any, tables: dict[str, list[dict[str, Any]]]) -> None:
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


def restore_generation_tables(conn: Any, tables: dict[str, list[dict[str, Any]]]) -> None:
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


def restore_audit_and_discovery_tables(conn: Any, tables: dict[str, list[dict[str, Any]]]) -> None:
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


def restore_backup_tables(conn: Any, tables: dict[str, list[dict[str, Any]]], actor: UserOut) -> str:
    for table in SERVER_BACKUP_DELETE_ORDER:
        conn.execute(f"DELETE FROM {table}")

    restored_users = restore_auth_tables(conn, tables, actor)
    restore_project_and_channel_tables(conn, tables)
    restore_template_tables(conn, tables)
    restore_generation_tables(conn, tables)
    restore_audit_and_discovery_tables(conn, tables)
    return create_restored_session(conn, restored_users, actor)


def restore_server_backup_archive(archive_bytes: bytes, response: Response, actor: UserOut) -> None:
    with zipfile.ZipFile(io.BytesIO(archive_bytes), mode="r") as archive:
        _, tables, image_files = parse_server_backup_manifest(archive_bytes)
        with tempfile.TemporaryDirectory() as temp_dir_str:
            temp_dir = Path(temp_dir_str)
            staged_asset_dir = stage_backup_assets(archive, tables, image_files, temp_dir)
            current_asset_dir = settings.asset_dir
            backup_asset_dir = temp_dir / "previous-assets"
            moved_existing_assets = False
            installed_staged_assets = False
            try:
                current_asset_dir, backup_asset_dir, moved_existing_assets, installed_staged_assets = swap_asset_directories(
                    staged_asset_dir,
                    temp_dir,
                )

                with get_conn() as conn:
                    session_token = restore_backup_tables(conn, tables, actor)
            except Exception:
                rollback_asset_directories(
                    current_asset_dir,
                    backup_asset_dir,
                    moved_existing_assets=moved_existing_assets,
                    installed_staged_assets=installed_staged_assets,
                )
                raise
            else:
                finalize_asset_swap(backup_asset_dir)

    set_session_cookie(response, session_token)


# ---------------------------------------------------------------------------
# Route handlers
# ---------------------------------------------------------------------------

# --- PLACEHOLDER_ROUTES ---


@router.get("/audit-logs", response_model=list[AuditLogOut])
def list_audit_logs(limit: int = Query(100, ge=1, le=300), admin: UserOut = Depends(require_admin)) -> list[AuditLogOut]:
    with get_conn() as conn:
        rows = conn.execute(
            "SELECT * FROM audit_logs ORDER BY created_at DESC LIMIT ?",
            (limit,),
        ).fetchall()
    return [row_to_audit_log(row) for row in rows]


@router.get("/users", response_model=list[UserOut])
def list_admin_users(admin: UserOut = Depends(require_admin)) -> list[UserOut]:
    del admin
    with get_conn() as conn:
        rows = conn.execute("SELECT * FROM users ORDER BY created_at ASC, username ASC").fetchall()
    return [row_to_user(row) for row in rows]


@router.patch("/users/{user_id}/role", response_model=UserOut)
def update_admin_user_role(
    user_id: str,
    payload: UserRolePatchIn,
    admin: UserOut = Depends(require_admin),
) -> UserOut:
    if user_id == admin.id and payload.role != "admin":
        raise HTTPException(status_code=400, detail="不能移除当前登录管理员自己的管理员权限")

    with get_conn() as conn:
        conn.execute("BEGIN IMMEDIATE")
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


@router.post("/users/{user_id}/reset-password")
def reset_user_password(
    user_id: str,
    admin: UserOut = Depends(require_admin),
) -> dict[str, str]:
    import secrets
    temp_password = secrets.token_urlsafe(10)
    with get_conn() as conn:
        target = conn.execute("SELECT * FROM users WHERE id = ?", (user_id,)).fetchone()
        if not target:
            raise HTTPException(status_code=404, detail="User not found")
        ts = now_ms()
        conn.execute(
            "UPDATE users SET password_hash = ?, updated_at = ? WHERE id = ?",
            (hash_password(temp_password), ts, user_id),
        )
        conn.execute("DELETE FROM sessions WHERE user_id = ?", (user_id,))
        insert_audit_log(
            conn,
            admin,
            "user.reset_password",
            "user",
            user_id,
            {"username": target["username"]},
        )
    return {"tempPassword": temp_password}


# --- PLACEHOLDER_ROUTES_2 ---


@router.get("/auth/settings", response_model=AuthSettingsOut)
def get_admin_auth_settings(admin: UserOut = Depends(require_admin)) -> AuthSettingsOut:
    del admin
    with get_conn() as conn:
        user_count = int(conn.execute("SELECT COUNT(*) AS count FROM users").fetchone()["count"])
        auth_settings = get_auth_settings(conn)
    return auth_settings_to_out(auth_settings, user_count > 0)


@router.patch("/auth/settings", response_model=AuthSettingsOut)
def patch_admin_auth_settings(
    payload: AuthSettingsPatch,
    admin: UserOut = Depends(require_admin),
) -> AuthSettingsOut:
    with get_conn() as conn:
        current = get_auth_settings(conn)
        next_mode = payload.registrationMode or current["registrationMode"]
        saved = save_auth_settings(conn, next_mode)
        user_count = int(conn.execute("SELECT COUNT(*) AS count FROM users").fetchone()["count"])
        insert_audit_log(
            conn,
            admin,
            "auth.settings_update",
            "auth_settings",
            "default",
            {
                "previousRegistrationMode": current["registrationMode"],
                "nextRegistrationMode": next_mode,
            },
        )
    return auth_settings_to_out(saved, user_count > 0)


@router.get("/auth/invite-codes", response_model=list[InviteCodeOut])
def list_registration_invite_codes(admin: UserOut = Depends(require_admin)) -> list[InviteCodeOut]:
    del admin
    with get_conn() as conn:
        rows = conn.execute(
            "SELECT * FROM registration_invite_codes ORDER BY created_at DESC, id DESC"
        ).fetchall()
        return [row_to_invite_code(row, list_recent_invite_code_uses(conn, row["id"])) for row in rows]


@router.get("/auth/invite-codes/{invite_id}/uses", response_model=list[InviteCodeUseOut])
def list_registration_invite_code_uses(
    invite_id: str,
    limit: int = Query(100, ge=1, le=500),
    admin: UserOut = Depends(require_admin),
) -> list[InviteCodeUseOut]:
    del admin
    with get_conn() as conn:
        get_invite_code_row_or_404(conn, invite_id)
        return list_recent_invite_code_uses(conn, invite_id, limit)

# --- PLACEHOLDER_ROUTES_3 ---


@router.post("/auth/invite-codes", response_model=InviteCodeOut)
def create_registration_invite_code(
    payload: InviteCodeIn,
    admin: UserOut = Depends(require_admin),
) -> InviteCodeOut:
    note = payload.note.strip()
    with get_conn() as conn:
        row = create_invite_code_record(
            conn,
            note=note,
            max_uses=payload.maxUses,
            expires_at=payload.expiresAt,
        )
        insert_audit_log(
            conn,
            admin,
            "auth.invite_code_create",
            "registration_invite_code",
            row["id"],
            {
                "note": note,
                "maxUses": payload.maxUses,
                "expiresAt": payload.expiresAt,
            },
        )
        uses = list_recent_invite_code_uses(conn, row["id"])
    return row_to_invite_code(row, uses)


@router.post("/auth/invite-codes/batch", response_model=list[InviteCodeOut])
def batch_create_registration_invite_codes(
    payload: InviteCodeBatchIn,
    admin: UserOut = Depends(require_admin),
) -> list[InviteCodeOut]:
    note = payload.note.strip()
    effective_max_uses = 1 if payload.maxUses is None else payload.maxUses
    rows: list[Any] = []
    with get_conn() as conn:
        for _ in range(payload.count):
            rows.append(
                create_invite_code_record(
                    conn,
                    note=note,
                    max_uses=effective_max_uses,
                    expires_at=payload.expiresAt,
                )
            )
        insert_audit_log(
            conn,
            admin,
            "auth.invite_code_batch_create",
            "registration_invite_code",
            None,
            {
                "count": payload.count,
                "note": note,
                "maxUses": effective_max_uses,
                "expiresAt": payload.expiresAt,
            },
        )
        return [row_to_invite_code(row, list_recent_invite_code_uses(conn, row["id"])) for row in rows]

# --- PLACEHOLDER_ROUTES_4 ---


@router.patch("/auth/invite-codes/{invite_id}", response_model=InviteCodeOut)
def patch_registration_invite_code(
    invite_id: str,
    payload: InviteCodePatch,
    admin: UserOut = Depends(require_admin),
) -> InviteCodeOut:
    field_set = getattr(payload, "model_fields_set", set())
    with get_conn() as conn:
        current = get_invite_code_row_or_404(conn, invite_id)
        note = payload.note.strip() if "note" in field_set and payload.note is not None else (current["note"] or "")
        max_uses = payload.maxUses if "maxUses" in field_set else current["max_uses"]
        expires_at = payload.expiresAt if "expiresAt" in field_set else current["expires_at"]
        if "isEnabled" in field_set:
            if payload.isEnabled is None:
                raise HTTPException(status_code=400, detail="isEnabled 不能为空")
            is_enabled = int(payload.isEnabled)
        else:
            is_enabled = int(bool(current["is_enabled"]))
        if max_uses is not None and int(max_uses) < int(current["used_count"] or 0):
            raise HTTPException(status_code=400, detail="最大使用次数不能小于当前已使用次数")
        ts = now_ms()
        conn.execute(
            """
            UPDATE registration_invite_codes
            SET note = ?, max_uses = ?, expires_at = ?, is_enabled = ?, updated_at = ?
            WHERE id = ?
            """,
            (note, max_uses, expires_at, is_enabled, ts, invite_id),
        )
        row = conn.execute("SELECT * FROM registration_invite_codes WHERE id = ?", (invite_id,)).fetchone()
        insert_audit_log(
            conn,
            admin,
            "auth.invite_code_update",
            "registration_invite_code",
            invite_id,
            {
                "note": note,
                "maxUses": max_uses,
                "expiresAt": expires_at,
                "isEnabled": bool(is_enabled),
            },
        )
        uses = list_recent_invite_code_uses(conn, row["id"])
    return row_to_invite_code(row, uses)


@router.delete("/auth/invite-codes/{invite_id}")
def delete_registration_invite_code(
    invite_id: str,
    admin: UserOut = Depends(require_admin),
) -> dict[str, bool]:
    with get_conn() as conn:
        row = get_invite_code_row_or_404(conn, invite_id)
        conn.execute("DELETE FROM registration_invite_codes WHERE id = ?", (invite_id,))
        insert_audit_log(
            conn,
            admin,
            "auth.invite_code_delete",
            "registration_invite_code",
            invite_id,
            {"code": row["code"], "note": row["note"] or ""},
        )
    return {"ok": True}

# --- PLACEHOLDER_ROUTES_5 ---


@router.get("/system/export")
def export_system_backup(admin: UserOut = Depends(require_admin)) -> StreamingResponse:
    archive_bytes = build_server_backup_archive()
    write_audit_log(admin, "system.export", "system_backup", details={"bytes": len(archive_bytes)})
    filename = f"gpt-image-playground-backup-{time.strftime('%Y%m%d-%H%M%S')}.zip"
    return StreamingResponse(
        io.BytesIO(archive_bytes),
        media_type="application/zip",
        headers={"Content-Disposition": f'attachment; filename="{filename}"'},
    )


@router.post("/system/import-preview", response_model=SystemBackupPreviewOut)
async def preview_system_backup_import(
    file: UploadFile = File(...),
    admin: UserOut = Depends(require_admin),
) -> SystemBackupPreviewOut:
    del admin
    archive_bytes = await file.read()
    return build_server_backup_preview(archive_bytes)


@router.post("/system/import", response_model=SystemBackupImportOut)
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
