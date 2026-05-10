from __future__ import annotations

import json
import re
from typing import Any
from urllib.parse import urljoin

from fastapi import HTTPException

from .config import settings
from .db import get_conn
from .schemas import (
    AdminApiChannelOut,
    ApiChannelOut,
    AuditLogOut,
    AuthSettingsOut,
    ChannelCompatibilityStatus,
    ChannelHealthStatus,
    ChannelModel,
    CodexCliMode,
    GenerationTaskOut,
    InviteCodeOut,
    InviteCodeUseOut,
    ProjectBoardOut,
    PromptTemplateOut,
    TaskParams,
    TemplateVersionOut,
    UserOut,
)
from .state import DEFAULT_AUTH_SETTINGS
from .security import new_id, now_ms


def json_dumps(value: Any) -> str:
    return json.dumps(value, ensure_ascii=False, separators=(",", ":"))


def json_loads(value: str | None, fallback: Any) -> Any:
    if not value:
        return fallback
    try:
        return json.loads(value)
    except json.JSONDecodeError:
        return fallback


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


def api_key_preview(api_key: str | None) -> str:
    if not api_key:
        return ""
    if len(api_key) <= 8:
        return "••••"
    return f"{api_key[:3]}••••{api_key[-4:]}"


def row_to_plain_dict(row: Any) -> dict[str, Any]:
    return {key: row[key] for key in row.keys()}


def row_to_user(row: Any) -> UserOut:
    return UserOut(
        id=row["id"],
        username=row["username"],
        role=row["role"],
        createdAt=row["created_at"],
        updatedAt=row["updated_at"],
    )


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


def row_to_invite_code_use(row: Any) -> InviteCodeUseOut:
    return InviteCodeUseOut(
        id=row["id"],
        userId=row["user_id"],
        username=row["username"] or "",
        usedAt=row["used_at"],
    )


def row_to_invite_code(row: Any, recent_uses: list[InviteCodeUseOut] | None = None) -> InviteCodeOut:
    max_uses = row["max_uses"]
    used_count = int(row["used_count"] or 0)
    remaining_uses = None if max_uses is None else max(0, int(max_uses) - used_count)
    return InviteCodeOut(
        id=row["id"],
        code=row["code"],
        note=row["note"] or "",
        maxUses=max_uses,
        usedCount=used_count,
        remainingUses=remaining_uses,
        isEnabled=bool(row["is_enabled"]),
        expiresAt=row["expires_at"],
        recentUses=recent_uses or [],
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


# ---------------------------------------------------------------------------
# Auth settings helpers (shared by auth routes and admin routes)
# ---------------------------------------------------------------------------


def get_auth_settings_row(conn: Any) -> Any | None:
    return conn.execute("SELECT * FROM auth_settings WHERE id = 'default'").fetchone()


def get_auth_settings(conn: Any) -> dict[str, Any]:
    row = get_auth_settings_row(conn)
    if not row:
        return {**DEFAULT_AUTH_SETTINGS, "updatedAt": None}
    return {
        "registrationMode": row["registration_mode"] or DEFAULT_AUTH_SETTINGS["registrationMode"],
        "updatedAt": row["updated_at"],
    }


def auth_settings_to_out(data: dict[str, Any], has_users: bool) -> AuthSettingsOut:
    registration_mode = str(data.get("registrationMode") or DEFAULT_AUTH_SETTINGS["registrationMode"])
    allow_registration = (not has_users) or registration_mode != "disabled"
    invite_required = has_users and registration_mode == "invite_only"
    return AuthSettingsOut(
        registrationMode=registration_mode,
        allowRegistration=allow_registration,
        inviteCodeRequired=invite_required,
        hasUsers=has_users,
        updatedAt=data.get("updatedAt"),
    )


def get_invite_code_row_or_404(conn: Any, invite_id: str) -> Any:
    row = conn.execute(
        "SELECT * FROM registration_invite_codes WHERE id = ?",
        (invite_id,),
    ).fetchone()
    if not row:
        raise HTTPException(status_code=404, detail="邀请码不存在")
    return row


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


def get_enabled_channel_model(channel_id: str, model_id: str) -> tuple[Any, "ChannelModel"]:
    row = get_channel_row_or_404(channel_id)
    for model in row_to_channel(row).models:
        if model.id == model_id and model.enabled:
            return row, model
    raise HTTPException(status_code=400, detail="Selected model is not available for this channel")


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

