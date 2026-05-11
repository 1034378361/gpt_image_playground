from __future__ import annotations

import asyncio
from collections import defaultdict
from typing import Any

import httpx
from fastapi import APIRouter, Depends, HTTPException, Request
from fastapi.responses import StreamingResponse
from pydantic import ValidationError

from ..assets import (
    attach_assets_to_task,
    asset_ext,
    bytes_to_data_url,
    data_url_to_bytes,
    delete_asset_files,
    generation_payload_from_row,
    persist_generation_inputs,
    save_asset_bytes,
)
from ..config import settings
from ..db import get_conn
from ..dependencies import require_user
from ..generation_runtime import GenerationExecution
from ..helpers import (
    compact_message,
    effective_codex_cli,
    endpoint_url,
    get_enabled_channel_model,
    insert_audit_log,
    json_dumps,
    normalize_base_url,
    normalize_channel_compatibility_status,
    normalize_channel_health_status,
    normalize_codex_cli_mode,
    record_channel_health,
    resolve_owned_project_id,
    row_to_task,
    row_to_user,
)
from ..schemas import (
    AssetOut,
    ChannelCompatibilityStatus,
    ChannelHealthStatus,
    ChannelModel,
    CodexCliMode,
    GenerateIn,
    GenerateOut,
    GenerateRunOut,
    GenerationDiagnosticOut,
    GenerationPreflightIn,
    GenerationPreflightOut,
    GenerationQueueStatsOut,
    GenerationTaskIn,
    GenerationTaskOut,
    GenerationTaskPatch,
    TaskParams,
    UserOut,
)
from ..security import new_id, now_ms
from ..state import ACTIVE_TASK_STATUSES, FINAL_TASK_STATUSES
from .. import state as _state
from .templates import _recalculate_template_quality as recalculate_template_quality

router = APIRouter(tags=["generations"])

# --- Task event notification ---
_task_waiters: dict[str, list[asyncio.Event]] = defaultdict(list)


def notify_task_update(task_id: str) -> None:
    for event in _task_waiters.pop(task_id, []):
        event.set()


async def wait_for_task_update(task_id: str, timeout: float = 25.0) -> bool:
    event = asyncio.Event()
    _task_waiters[task_id].append(event)
    try:
        await asyncio.wait_for(event.wait(), timeout=timeout)
        return True
    except asyncio.TimeoutError:
        return False
    finally:
        waiters = _task_waiters.get(task_id, [])
        if event in waiters:
            waiters.remove(event)
        if not waiters:
            _task_waiters.pop(task_id, None)



# ---------------------------------------------------------------------------
# Helper utilities (generation-only)
# ---------------------------------------------------------------------------

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


def extract_upstream_error_text(response: httpx.Response, limit: int = 220) -> str:
    fallback = compact_message(response.text or f"HTTP {response.status_code}", limit)
    try:
        data = response.json()
    except ValueError:
        return fallback

    if isinstance(data, dict):
        error = data.get("error")
        if isinstance(error, dict):
            primary = (
                error.get("message")
                or error.get("detail")
                or error.get("code")
                or error.get("type")
                or ""
            )
            extras: list[str] = []
            for key in ("code", "type", "param"):
                value = error.get(key)
                if value and str(value) not in str(primary):
                    extras.append(f"{key}={value}")
            if primary or extras:
                return compact_message("；".join([str(primary).strip(), *extras]).strip("； "), limit)
            return compact_response_text(error, limit)
        if isinstance(error, str) and error.strip():
            return compact_message(error, limit)

        for key in ("detail", "message"):
            value = data.get(key)
            if isinstance(value, str) and value.strip():
                return compact_message(value, limit)
            if isinstance(value, (dict, list)):
                return compact_response_text(value, limit)

    return compact_response_text(data, limit) or fallback


def classify_transport_error(exc: Exception) -> GenerationDiagnosticOut | None:
    message = compact_message(str(exc), 220) or exc.__class__.__name__
    normalized = message.lower()

    if isinstance(exc, httpx.ConnectError):
        if any(marker in normalized for marker in ("certificate verify failed", "tls", "ssl", "wrong version number", "handshake")):
            return generation_diagnostic(
                "upstream_tls_error",
                "error",
                "上游 TLS 握手失败",
                message,
                "通常是证书、HTTPS 反向代理或网关配置有问题。",
            )
        if any(marker in normalized for marker in ("10054", "connection reset", "forcibly closed", "远程主机强迫关闭")):
            return generation_diagnostic(
                "upstream_connection_reset",
                "error",
                "上游连接被重置",
                message,
                "常见于上游网关不稳定、风控中断，或中途断开了 HTTPS 连接。",
            )
        return generation_diagnostic(
            "upstream_connect_error",
            "error",
            "无法连接到上游",
            message,
            "请检查渠道 base URL、网络连通性、代理和 HTTPS 配置。",
        )

    if isinstance(exc, httpx.RemoteProtocolError):
        return generation_diagnostic(
            "upstream_protocol_error",
            "error",
            "上游提前断开响应",
            message,
            "上游没有返回完整 HTTP 响应，可能是网关或反向代理异常。",
        )

    if isinstance(exc, httpx.ReadError):
        return generation_diagnostic(
            "upstream_read_error",
            "error",
            "读取上游响应失败",
            message,
            "连接已经建立，但上游响应过程中断开了。",
        )

    if isinstance(exc, httpx.NetworkError):
        if any(marker in normalized for marker in ("certificate verify failed", "tls", "ssl", "wrong version number", "handshake")):
            return generation_diagnostic(
                "upstream_tls_error",
                "error",
                "上游 TLS 握手失败",
                message,
                "通常是证书、HTTPS 反向代理或网关配置有问题。",
            )
        if any(marker in normalized for marker in ("10054", "connection reset", "forcibly closed", "远程主机强迫关闭")):
            return generation_diagnostic(
                "upstream_connection_reset",
                "error",
                "上游连接被重置",
                message,
                "常见于上游网关不稳定、风控中断，或中途断开了 HTTPS 连接。",
            )
        return generation_diagnostic(
            "upstream_network_error",
            "error",
            "上游网络异常",
            message,
            "请稍后重试，或切换到别的渠道 / 模型。",
        )

    if any(marker in normalized for marker in ("certificate verify failed", "tls", "ssl", "wrong version number", "handshake")):
        return generation_diagnostic(
            "upstream_tls_error",
            "error",
            "上游 TLS 握手失败",
            message,
            "通常是证书、HTTPS 反向代理或网关配置有问题。",
        )

    if any(marker in normalized for marker in ("10054", "connection reset", "forcibly closed", "远程主机强迫关闭")):
        return generation_diagnostic(
            "upstream_connection_reset",
            "error",
            "上游连接被重置",
            message,
            "常见于上游网关不稳定、风控中断，或中途断开了 HTTPS 连接。",
        )

    return None


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
        text = extract_upstream_error_text(exc.response)
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

    transport_diagnostic = classify_transport_error(exc)
    if transport_diagnostic is not None:
        return [transport_diagnostic]

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


def classify_generation_exception(exc: Exception) -> tuple[str, list[GenerationDiagnosticOut]]:
    diagnostics = diagnostics_from_generation_exception(exc)
    primary = diagnostics[0] if diagnostics else None
    if primary:
        detail = (primary.detail or "").strip()
        title = (primary.title or "").strip()
        if detail:
            return detail, diagnostics
        if title:
            return title, diagnostics
    return compact_message(str(exc), 220) or "生成失败", diagnostics


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
            error_message, diagnostics = classify_generation_exception(exc)
            primary = diagnostics[0] if diagnostics else None
            health_message = primary.title if primary and primary.title else f"最近一次生成请求失败，HTTP {exc.response.status_code}"
            if error_message and error_message != health_message:
                health_message = f"{health_message}：{error_message}"
            record_channel_health(channel_row["id"], status, health_message)
            raise
        except httpx.TimeoutException:
            record_channel_health(channel_row["id"], "error", "最近一次生成请求超时")
            raise
        except httpx.HTTPError as exc:
            error_message, diagnostics = classify_generation_exception(exc)
            primary = diagnostics[0] if diagnostics else None
            health_message = primary.title if primary and primary.title else "最近一次生成请求失败"
            if error_message and error_message != health_message:
                health_message = f"{health_message}：{error_message}"
            record_channel_health(channel_row["id"], "error", health_message)
            raise
        except ValueError as exc:
            error_message, diagnostics = classify_generation_exception(exc)
            primary = diagnostics[0] if diagnostics else None
            health_message = primary.title if primary and primary.title else "最近一次生成请求未返回可用图片"
            if error_message and error_message != health_message:
                health_message = f"{health_message}：{error_message}"
            record_channel_health(channel_row["id"], "degraded", health_message)
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
    notify_task_update(task_id)
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
    notify_task_update(task_id)
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
    runtime = _state.GENERATION_RUNTIME
    with get_conn() as conn:
        rows = conn.execute(
            "SELECT id FROM generation_tasks WHERE status = 'queued' ORDER BY created_at ASC",
        ).fetchall()
    for row in rows:
        task_id = row["id"]
        if task_id in runtime.queued_task_ids or task_id in runtime.active_tasks:
            continue
        await runtime.queue_task(task_id)


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


# ---------------------------------------------------------------------------
# Internal patch helper (used by complete_generation_task)
# The route handler `patch_generation` also calls this logic.
# ---------------------------------------------------------------------------

def _patch_generation(task_id: str, payload: GenerationTaskPatch, user: UserOut) -> GenerationTaskOut:
    """Apply a patch to a generation task (shared logic for route + internal use)."""
    with get_conn() as conn:
        row = conn.execute(
            "SELECT * FROM generation_tasks WHERE id = ? AND user_id = ?",
            (task_id, user.id),
        ).fetchone()
    if not row:
        raise HTTPException(status_code=404, detail="Generation not found")
    existing = row_to_task(row)
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
    notify_task_update(task_id)
    return row_to_task(row)
# PLACEHOLDER_COMPLETE_TASK


async def complete_generation_task(payload: GenerateIn, user: UserOut, started_at: int) -> GenerateOut:
    task_id = payload.taskId or new_id()
    try:
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
        task = _patch_generation(
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
        error_message, diagnostics = classify_generation_exception(exc)
        _patch_generation(
            task_id,
            GenerationTaskPatch(
                status="error",
                error=error_message,
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
            error_message, diagnostics = classify_generation_exception(exc)
            _patch_generation(
                payload.taskId,
                GenerationTaskPatch(
                    status="error",
                    error=error_message,
                    finishedAt=finished_at,
                    elapsed=finished_at - started_at,
                    diagnostics=diagnostics,
                ),
                user,
            )
        return


# ---------------------------------------------------------------------------
# Route handlers
# ---------------------------------------------------------------------------


@router.post("/api/generations/preflight", response_model=GenerationPreflightOut)
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


@router.get("/api/generations", response_model=list[GenerationTaskOut])
def list_generations(user: UserOut = Depends(require_user)) -> list[GenerationTaskOut]:
    with get_conn() as conn:
        rows = conn.execute(
            "SELECT * FROM generation_tasks WHERE user_id = ? ORDER BY created_at DESC LIMIT 500",
            (user.id,),
        ).fetchall()
    return [row_to_task(row) for row in rows]


@router.get("/api/generations/queue-stats", response_model=GenerationQueueStatsOut)
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
    runtime_counts = _state.GENERATION_RUNTIME.snapshot()
    return GenerationQueueStatsOut(
        workerCount=runtime_counts["worker_count"],
        queuedCount=overall_counts.get("queued", 0),
        runningCount=overall_counts.get("running", 0),
        yourQueuedCount=your_counts.get("queued", 0),
        yourRunningCount=your_counts.get("running", 0),
    )


@router.post("/api/generations", response_model=GenerationTaskOut)
def create_generation(payload: GenerationTaskIn, user: UserOut = Depends(require_user)) -> GenerationTaskOut:
    next_payload = payload.model_copy(update={"projectId": resolve_owned_project_id(payload.projectId, user)})
    return insert_generation(next_payload, user.id)


@router.get("/api/generations/{task_id}", response_model=GenerationTaskOut)
def get_generation(task_id: str, user: UserOut = Depends(require_user)) -> GenerationTaskOut:
    with get_conn() as conn:
        row = conn.execute(
            "SELECT * FROM generation_tasks WHERE id = ? AND user_id = ?",
            (task_id, user.id),
        ).fetchone()
    if not row:
        raise HTTPException(status_code=404, detail="Generation not found")
    return row_to_task(row)


@router.get("/api/generations/{task_id}/stream")
async def stream_generation_status(task_id: str, request: Request, user: UserOut = Depends(require_user)):
    with get_conn() as conn:
        row = conn.execute(
            "SELECT * FROM generation_tasks WHERE id = ? AND user_id = ?",
            (task_id, user.id),
        ).fetchone()
    if not row:
        raise HTTPException(status_code=404, detail="Generation not found")

    async def event_generator():
        task = row_to_task(row)
        yield f"event: status\ndata: {task.model_dump_json()}\n\n"
        if task.status in FINAL_TASK_STATUSES:
            return
        max_iterations = 200
        for _ in range(max_iterations):
            if await request.is_disconnected():
                return
            updated = await wait_for_task_update(task_id, timeout=25.0)
            if await request.is_disconnected():
                return
            with get_conn() as conn:
                fresh_row = conn.execute(
                    "SELECT * FROM generation_tasks WHERE id = ? AND user_id = ?",
                    (task_id, user.id),
                ).fetchone()
            if not fresh_row:
                return
            task = row_to_task(fresh_row)
            yield f"event: status\ndata: {task.model_dump_json()}\n\n"
            if task.status in FINAL_TASK_STATUSES:
                return
            if not updated:
                yield ": keepalive\n\n"

    return StreamingResponse(
        event_generator(),
        media_type="text/event-stream",
        headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"},
    )


@router.patch("/api/generations/{task_id}", response_model=GenerationTaskOut)
def patch_generation(task_id: str, payload: GenerationTaskPatch, user: UserOut = Depends(require_user)) -> GenerationTaskOut:
    return _patch_generation(task_id, payload, user)


@router.delete("/api/generations/{task_id}")
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


# PLACEHOLDER_MORE_ROUTES


@router.post("/api/generations/run", response_model=GenerateRunOut)
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
    await _state.GENERATION_RUNTIME.queue_task(task_id)
    return GenerateRunOut(task=task)


@router.post("/api/generations/{task_id}/cancel", response_model=GenerationTaskOut)
async def cancel_generation(task_id: str, user: UserOut = Depends(require_user)) -> GenerationTaskOut:
    existing = get_generation(task_id, user)
    if existing.status in FINAL_TASK_STATUSES:
        return existing

    _state.GENERATION_RUNTIME.discard_queued(task_id)
    _state.GENERATION_RUNTIME.cancel_active(task_id)
    return mark_generation_canceled(task_id, user.id, actor=user)


@router.post("/api/generate", response_model=GenerateOut)
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


def ensure_generation_workers() -> None:
    _state.GENERATION_RUNTIME.ensure_workers()
