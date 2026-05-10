from __future__ import annotations

import time
from typing import Any

import httpx
from fastapi import APIRouter, Depends, HTTPException
from pydantic import ValidationError

from ..config import settings
from ..db import get_conn
from ..schemas import (
    AdminApiChannelOut,
    ApiChannelIn,
    ApiChannelOut,
    ApiChannelPatch,
    ChannelCompatibilityStatus,
    ChannelHealthStatus,
    ChannelLeaderboardOut,
    ChannelModel,
    GenerateIn,
    TaskParams,
    UserOut,
)
from ..security import new_id, now_ms
from ..helpers import (
    compact_message,
    endpoint_url,
    get_channel_row_or_404,
    insert_audit_log,
    json_dumps,
    normalize_base_url,
    normalize_channel_compatibility_status,
    normalize_channel_health_status,
    normalize_codex_cli_mode,
    record_channel_health,
    row_to_admin_channel,
    row_to_channel,
)
from ..dependencies import require_admin, require_user

router = APIRouter(tags=["channels"])


# ---------------------------------------------------------------------------
# Helpers used only by channel routes
# ---------------------------------------------------------------------------

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

    # Late import to avoid circular dependency with main module
    from .generations import call_upstream_once, is_unsupported_quality_error

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


# ---------------------------------------------------------------------------
# Routes
# ---------------------------------------------------------------------------

@router.get("/api/channels", response_model=list[ApiChannelOut])
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


@router.get("/api/channels/leaderboard", response_model=list[ChannelLeaderboardOut])
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


@router.get("/api/admin/channels", response_model=list[AdminApiChannelOut])
def list_admin_channels(admin: UserOut = Depends(require_admin)) -> list[AdminApiChannelOut]:
    with get_conn() as conn:
        rows = conn.execute("SELECT * FROM api_channels ORDER BY updated_at DESC").fetchall()
    return [row_to_admin_channel(row) for row in rows]


@router.post("/api/admin/channels", response_model=AdminApiChannelOut)
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


@router.patch("/api/admin/channels/{channel_id}", response_model=AdminApiChannelOut)
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


@router.delete("/api/admin/channels/{channel_id}")
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


@router.post("/api/admin/channels/{channel_id}/health-check", response_model=AdminApiChannelOut)
async def check_channel_health(channel_id: str, admin: UserOut = Depends(require_admin)) -> AdminApiChannelOut:
    return await perform_channel_health_check(channel_id, admin)


@router.post("/api/admin/channels/{channel_id}/compatibility-check", response_model=AdminApiChannelOut)
async def check_channel_compatibility(channel_id: str, admin: UserOut = Depends(require_admin)) -> AdminApiChannelOut:
    return await perform_channel_compatibility_check(channel_id, admin)
