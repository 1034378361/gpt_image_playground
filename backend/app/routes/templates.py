from __future__ import annotations

import hashlib
import json
import re
from typing import Any

import httpx
from fastapi import APIRouter, Body, Depends, HTTPException, Query
from pydantic import ValidationError

from ..assets import asset_is_publicly_visible
from ..config import settings
from ..db import get_conn
from ..schemas import (
    BatchDeleteIn,
    ChannelModel,
    OpenPromptImportIn,
    OpenPromptPreviewItemOut,
    OpenPromptPreviewOut,
    OpenPromptSourceOut,
    PromptTemplateIn,
    PromptTemplateOut,
    PromptTemplatePatch,
    RateTemplateIn,
    RejectTemplateIn,
    SetCoverIn,
    TaskParams,
    TemplatePackImportIn,
    TemplatePackImportOut,
    TemplateSampleOut,
    TemplateVersionOut,
    UserOut,
)
from ..security import new_id, now_ms
from ..helpers import (
    compact_message,
    get_enabled_channel_model,
    insert_audit_log,
    json_dumps,
    json_loads,
    resolve_owned_project_id,
    row_to_channel,
    row_to_template,
    row_to_template_version,
)
from ..state import (
    OpenPromptSource,
)
from ..dependencies import require_admin, require_template_operator, require_user
from .open_prompt_parsers import (
    IMAGE_PROMPT_POSITIVE_TERMS,
    OPEN_PROMPT_SOURCES,
    _count_term_hits,
)

router = APIRouter(tags=["templates"])


# ---------------------------------------------------------------------------
# Helper functions (private to this module)
# ---------------------------------------------------------------------------


def _validate_template_channel_selection(channel_id: str | None, api_mode: str, model_id: str) -> None:
    if not channel_id:
        raise HTTPException(status_code=400, detail="Channel is required")
    _, selected_model = get_enabled_channel_model(channel_id, model_id)
    if selected_model.apiMode != api_mode:
        raise HTTPException(status_code=400, detail="Selected model does not match the chosen API mode")


def _pick_default_template_target() -> tuple[str, ChannelModel]:
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



def _normalize_example_images(values: list[str] | None) -> list[str]:
    seen: set[str] = set()
    images: list[str] = []
    for raw in values or []:
        value = str(raw or "").strip()
        if not value or value in seen:
            continue
        seen.add(value)
        images.append(value)
    return images[:12]


def _template_variable_count(prompt: str, negative_prompt: str | None = None) -> int:
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


def _calculate_template_quality(
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
    score = 0.0

    # --- Prompt content quality (max 35) ---
    prompt_text = prompt.strip()
    prompt_len = len(prompt_text)
    if prompt_len >= 200:
        score += 18
    elif prompt_len >= 120:
        score += 14
    elif prompt_len >= 60:
        score += 8
    elif prompt_len >= 20:
        score += 3

    combined = f"{title} {prompt_text} {category} {' '.join(tags)}".lower()
    relevance_hits = _count_term_hits(combined, IMAGE_PROMPT_POSITIVE_TERMS)
    score += min(relevance_hits, 7) * 2.5  # max +17.5

    # --- Structure & metadata (max 25) ---
    if title.strip() and len(title.strip()) <= 80:
        score += 5
    if category.strip():
        score += 4
    score += min(len(tags), 5) * 1.5  # max +7.5
    if negative_prompt and len(negative_prompt.strip()) >= 10:
        score += 3
    var_count = _template_variable_count(prompt, negative_prompt)
    score += min(var_count, 4) * 1.5  # max +6

    # --- Visual assets (max 12) ---
    if cover_image_id or external_cover_url:
        score += 5
    if example_images:
        score += min(len(example_images), 4) * 1.75  # max +7

    # --- Usage signals (max 28) ---
    total_generations = max(0, success_count) + max(0, failure_count)
    if total_generations >= 3:
        success_rate = max(0, success_count) / total_generations
        score += success_rate * 12  # max +12
    score += min(max(0, success_count), 20) * 0.3  # max +6
    score += min(max(0, usage_count), 50) / 50 * 4  # max +4
    score += min(max(0, favorite_count), 20) / 20 * 4  # max +4
    if rating_count > 0:
        avg_rating = max(0, rating_total) / rating_count
        score += (avg_rating / 5) * 8  # max +8
        score += min(rating_count, 10) / 10 * 2  # max +2 (confidence bonus)

    return round(max(0.0, min(score, 100.0)), 1)


def _quality_for_payload(payload: PromptTemplateIn | PromptTemplateOut) -> float:
    return _calculate_template_quality(
        payload.title,
        payload.prompt,
        payload.tags,
        payload.category,
        payload.coverImageId,
        payload.externalCoverUrl,
        _normalize_example_images(payload.exampleImages),
        payload.sourceName,
        payload.negativePrompt,
        payload.usageCount if isinstance(payload, PromptTemplateOut) else 0,
        payload.favoriteCount if isinstance(payload, PromptTemplateOut) else 0,
        payload.successCount if isinstance(payload, PromptTemplateOut) else 0,
        payload.failureCount if isinstance(payload, PromptTemplateOut) else 0,
        int((payload.averageRating if isinstance(payload, PromptTemplateOut) else 0) * (payload.ratingCount if isinstance(payload, PromptTemplateOut) else 0)),
        payload.ratingCount if isinstance(payload, PromptTemplateOut) else 0,
    )


def _recalculate_template_quality(conn: Any, template_id: str) -> None:
    row = conn.execute("SELECT * FROM prompt_templates WHERE id = ?", (template_id,)).fetchone()
    if not row:
        return
    score = _calculate_template_quality(
        row["title"],
        row["prompt"],
        json_loads(row["tags_json"], []),
        row["category"],
        row["cover_image_id"],
        row["external_cover_url"] if "external_cover_url" in row.keys() else None,
        _normalize_example_images(json_loads(row["example_images_json"] if "example_images_json" in row.keys() else None, [])),
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


def _snapshot_template_version(conn: Any, template_id: str, actor: UserOut | None = None) -> None:
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


def _open_prompt_item_key(source: OpenPromptSource, item: dict[str, str | list[str]]) -> str:
    raw = "\0".join(
        [
            source.id,
            str(item.get("title") or ""),
            str(item.get("sourceAuthor") or ""),
            str(item.get("sourceUrl") or ""),
        ]
    )
    return hashlib.sha1(raw.encode("utf-8")).hexdigest()[:18]


def _normalize_open_prompt_item(source: OpenPromptSource, item: dict[str, str | list[str]]) -> dict[str, Any]:
    image = str(item.get("image") or "")
    tags = [str(tag) for tag in item.get("tags", [])]
    example_images = _normalize_example_images([image] if image else [])
    quality_score = _calculate_template_quality(
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
        "key": _open_prompt_item_key(source, item),
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




async def _fetch_open_prompt_items(source: OpenPromptSource, limit: int) -> list[dict[str, Any]]:
    try:
        async with httpx.AsyncClient(timeout=30) as client:
            response = await client.get(source.readme_url)
            response.raise_for_status()
    except httpx.HTTPError as exc:
        raise HTTPException(status_code=502, detail=f"Failed to fetch open prompt source: {compact_message(exc)}") from exc
    parsed = [_normalize_open_prompt_item(source, item) for item in source.parser(source, response.text)]
    return parsed if limit <= 0 else parsed[:limit]


def _open_prompt_duplicate_marker(item: dict[str, Any]) -> tuple[str, str]:
    return (
        str(item.get("sourceUrl") or "").strip(),
        f"{str(item.get('title') or '')}\0{str(item.get('sourceAuthor') or '')}",
    )


def _open_prompt_exists(conn: Any, prompt_source: OpenPromptSource, item: dict[str, Any]) -> Any:
    source_url, _ = _open_prompt_duplicate_marker(item)
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
    same_source = conn.execute(
        """
        SELECT id FROM prompt_templates
        WHERE source_name = ? AND title = ? AND source_author = ?
        """,
        (prompt_source.source_name, item["title"], item["sourceAuthor"]),
    ).fetchone()
    if same_source:
        return same_source
    prompt_text = str(item.get("prompt") or "").strip()
    if prompt_text:
        return conn.execute(
            "SELECT id FROM prompt_templates WHERE prompt = ? LIMIT 1",
            (prompt_text,),
        ).fetchone()
    return None




def _upsert_open_prompt_items(
    prompt_source: OpenPromptSource,
    parsed: list[dict[str, Any]],
    actor: UserOut,
    *,
    visibility: str,
    submission_status: str,
    description_prefix: str,
) -> dict[str, int]:
    channel_id, model = _pick_default_template_target()
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
            example_images = _normalize_example_images(item["exampleImages"])
            tags = [str(tag) for tag in item["tags"]]
            quality_score = float(item["qualityScore"])
            exists = _open_prompt_exists(conn, prompt_source, item)
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
                    _recalculate_template_quality(conn, exists["id"])
                    _snapshot_template_version(conn, exists["id"], actor)
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
            _recalculate_template_quality(conn, template_id)
            _snapshot_template_version(conn, template_id, actor)
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



def _get_template_or_404(template_id: str, user: UserOut) -> PromptTemplateOut:
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


def _assert_can_manage_template(template: PromptTemplateOut, user: UserOut) -> None:
    if user.role == "admin":
        return
    if template.userId != user.id:
        raise HTTPException(status_code=404, detail="Template not found")
    if template.submissionStatus == "submitted":
        raise HTTPException(status_code=409, detail="Submitted templates cannot be edited before review")
    if template.visibility == "public" or template.submissionStatus == "approved":
        raise HTTPException(status_code=403, detail="Public templates are managed by admins")


def _visible_template_rows(conn: Any, user: UserOut) -> list[Any]:
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


def _tokenize_similarity_text(value: str) -> set[str]:
    normalized = re.sub(r"[^0-9a-zA-Z一-鿿+#.-]+", " ", value.lower())
    tokens = {token for token in normalized.split() if len(token) >= 2}
    for match in re.findall(r"[一-鿿]{2,}", normalized):
        tokens.add(match)
    return tokens


def _template_similarity_text(template: PromptTemplateOut) -> str:
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


def _hamming_distance_hex(left: str, right: str) -> int:
    if len(left) != len(right):
        return 64
    return bin(int(left, 16) ^ int(right, 16)).count("1")


def _score_template_similarity(
    target: str,
    candidate: PromptTemplateOut,
    target_visual_hash: str | None = None,
    candidate_visual_hash: str | None = None,
) -> float:
    target_tokens = _tokenize_similarity_text(target)
    candidate_tokens = _tokenize_similarity_text(_template_similarity_text(candidate))
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
        distance = _hamming_distance_hex(target_visual_hash, candidate_visual_hash)
        score += max(0.0, 24.0 - distance / 2)
    return score


def _resolve_similarity_target(
    conn: Any,
    user: UserOut,
    template_id: str | None,
    asset_id: str | None,
    query: str,
) -> tuple[str, str | None, str | None]:
    if template_id:
        template = _get_template_or_404(template_id, user)
        visual_hash: str | None = None
        if template.coverImageId:
            asset = conn.execute("SELECT visual_hash FROM assets WHERE id = ?", (template.coverImageId,)).fetchone()
            visual_hash = asset["visual_hash"] if asset and asset["visual_hash"] else None
        return _template_similarity_text(template), template.id, visual_hash
    if asset_id:
        asset = conn.execute("SELECT * FROM assets WHERE id = ?", (asset_id,)).fetchone()
        if not asset:
            raise HTTPException(status_code=404, detail="Asset not found")
        if asset["user_id"] != user.id and not asset_is_publicly_visible(conn, asset):
            raise HTTPException(status_code=404, detail="Asset not found")
        if asset["template_id"]:
            template = _get_template_or_404(asset["template_id"], user)
            return _template_similarity_text(template), template.id, asset["visual_hash"]
        if asset["task_id"]:
            task = conn.execute("SELECT prompt FROM generation_tasks WHERE id = ?", (asset["task_id"],)).fetchone()
            if task:
                return task["prompt"], None, asset["visual_hash"]
    return query.strip(), None, None


def _pack_item_to_template_payload(item: dict[str, Any], fallback_channel_id: str, fallback_model: ChannelModel) -> PromptTemplateIn:
    params = item.get("params") if isinstance(item.get("params"), dict) else {}
    channel_id = item.get("recommendedChannelId") or item.get("channelId") or fallback_channel_id
    api_mode = item.get("recommendedApiMode") or item.get("apiMode") or fallback_model.apiMode
    model_id = item.get("recommendedModel") or item.get("model") or fallback_model.id
    try:
        _validate_template_channel_selection(str(channel_id), str(api_mode), str(model_id))
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
        exampleImages=_normalize_example_images([str(url) for url in item.get("exampleImages", [])]),
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


async def _import_open_prompt_source(
    source_id: str,
    limit: int,
    admin: UserOut,
    selected_keys: list[str] | None = None,
) -> dict[str, int | bool | str]:
    prompt_source = OPEN_PROMPT_SOURCES.get(source_id)
    if not prompt_source:
        raise HTTPException(status_code=404, detail="Open prompt source not found")
    parsed = await _fetch_open_prompt_items(prompt_source, 0 if selected_keys else limit)
    selected = set(selected_keys or [])
    if selected:
        parsed = [item for item in parsed if item["key"] in selected]
    result = _upsert_open_prompt_items(
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


# ---------------------------------------------------------------------------
# Route handlers
# ---------------------------------------------------------------------------


@router.get("/api/templates", response_model=list[PromptTemplateOut])
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


@router.post("/api/templates", response_model=PromptTemplateOut)
def create_template(payload: PromptTemplateIn, user: UserOut = Depends(require_user)) -> PromptTemplateOut:
    template_id = new_id()
    ts = now_ms()
    _validate_template_channel_selection(payload.channelId, payload.apiMode, payload.model)
    project_id = resolve_owned_project_id(payload.projectId, user)
    example_images = _normalize_example_images(payload.exampleImages)
    quality_score = _quality_for_payload(
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
        _recalculate_template_quality(conn, template_id)
        _snapshot_template_version(conn, template_id, user)
        row = conn.execute("SELECT * FROM prompt_templates WHERE id = ? AND user_id = ?", (template_id, user.id)).fetchone()
    return row_to_template(row)


@router.get("/api/templates/discover", response_model=list[PromptTemplateOut])
def discover_templates(
    limit: int = Query(50, ge=1, le=200),
    user: UserOut = Depends(require_user),
) -> list[PromptTemplateOut]:
    with get_conn() as conn:
        rows = conn.execute(
            """
            SELECT * FROM prompt_templates
            WHERE visibility = 'public' AND submission_status = 'approved'
              AND user_id != ?
            ORDER BY quality_score DESC, success_count DESC, updated_at DESC
            LIMIT ?
            """,
            (user.id, limit),
        ).fetchall()
    return [row_to_template(row) for row in rows]


@router.get("/api/templates/similar", response_model=list[PromptTemplateOut])
def list_similar_templates(
    templateId: str | None = Query(None),
    assetId: str | None = Query(None),
    query: str = Query(""),
    limit: int = Query(8, ge=1, le=40),
    user: UserOut = Depends(require_user),
) -> list[PromptTemplateOut]:
    with get_conn() as conn:
        target_text, exclude_id, target_visual_hash = _resolve_similarity_target(conn, user, templateId, assetId, query)
        if not target_text:
            return []
        candidates = [row_to_template(row) for row in _visible_template_rows(conn, user)]
        candidate_hashes = {
            row["id"]: row["visual_hash"]
            for row in conn.execute("SELECT id, visual_hash FROM assets WHERE visual_hash IS NOT NULL").fetchall()
        }
    scored = [
        (
            _score_template_similarity(
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


@router.post("/api/templates/import-pack", response_model=TemplatePackImportOut)
def import_template_pack(payload: TemplatePackImportIn, user: UserOut = Depends(require_user)) -> TemplatePackImportOut:
    channel_id, model = _pick_default_template_target()
    created = 0
    skipped = 0
    for item in payload.templates[:200]:
        template_payload = _pack_item_to_template_payload(item, channel_id, model)
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


@router.get("/api/templates/{template_id}", response_model=PromptTemplateOut)
def get_template(template_id: str, user: UserOut = Depends(require_user)) -> PromptTemplateOut:
    return _get_template_or_404(template_id, user)


@router.post("/api/templates/{template_id}/use", response_model=PromptTemplateOut)
def mark_template_used(template_id: str, user: UserOut = Depends(require_user)) -> PromptTemplateOut:
    _get_template_or_404(template_id, user)
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
        _recalculate_template_quality(conn, template_id)
        row = conn.execute("SELECT * FROM prompt_templates WHERE id = ?", (template_id,)).fetchone()
    return row_to_template(row)


@router.patch("/api/templates/{template_id}", response_model=PromptTemplateOut)
def patch_template(template_id: str, payload: PromptTemplatePatch, user: UserOut = Depends(require_user)) -> PromptTemplateOut:
    existing = _get_template_or_404(template_id, user)
    _assert_can_manage_template(existing, user)
    data = payload.model_dump(exclude_unset=True)
    if not data:
        return existing

    ts = now_ms()
    next_template = PromptTemplateOut.model_validate({**existing.model_dump(), **data})
    project_id = resolve_owned_project_id(next_template.projectId, user)
    if {"channelId", "apiMode", "model"} & set(data):
        _validate_template_channel_selection(next_template.channelId, next_template.apiMode, next_template.model)
    example_images = _normalize_example_images(next_template.exampleImages)
    quality_score = _calculate_template_quality(
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
        _recalculate_template_quality(conn, template_id)
        _snapshot_template_version(conn, template_id, user)
        row = conn.execute("SELECT * FROM prompt_templates WHERE id = ?", (template_id,)).fetchone()
    return row_to_template(row)


@router.delete("/api/templates/{template_id}")
def delete_template(template_id: str, user: UserOut = Depends(require_user)) -> dict[str, bool]:
    template = _get_template_or_404(template_id, user)
    _assert_can_manage_template(template, user)
    with get_conn() as conn:
        cur = conn.execute("DELETE FROM prompt_templates WHERE id = ?", (template_id,))
    if cur.rowcount == 0:
        raise HTTPException(status_code=404, detail="Template not found")
    return {"ok": True}


@router.post("/api/templates/batch-delete")
def batch_delete_templates(payload: BatchDeleteIn, user: UserOut = Depends(require_user)) -> dict[str, int]:
    ids = list(set(payload.ids[:200]))
    deleted = 0
    with get_conn() as conn:
        for template_id in ids:
            row = conn.execute(
                "SELECT * FROM prompt_templates WHERE id = ?", (template_id,),
            ).fetchone()
            if not row:
                continue
            template = row_to_template(row)
            if template.userId != user.id and user.role != "admin":
                continue
            if template.submissionStatus == "submitted":
                continue
            if template.visibility == "public" or template.submissionStatus == "approved":
                if user.role != "admin":
                    continue
            conn.execute("DELETE FROM prompt_templates WHERE id = ?", (template_id,))
            deleted += 1
    return {"deleted": deleted}


@router.post("/api/admin/templates/dedup")
def dedup_templates(admin: UserOut = Depends(require_admin)) -> dict[str, int]:
    removed = 0
    with get_conn() as conn:
        rows = conn.execute(
            "SELECT id, title, prompt, source_name, quality_score, created_at FROM prompt_templates ORDER BY quality_score DESC, created_at ASC"
        ).fetchall()
        seen_prompts: dict[str, str] = {}
        to_delete: list[str] = []
        for row in rows:
            prompt_text = (row["prompt"] or "").strip()
            if not prompt_text:
                continue
            if prompt_text in seen_prompts:
                to_delete.append(row["id"])
            else:
                seen_prompts[prompt_text] = row["id"]
        for template_id in to_delete:
            conn.execute("DELETE FROM prompt_templates WHERE id = ?", (template_id,))
            removed += 1
        if removed:
            insert_audit_log(conn, admin, "template.dedup", "prompt_templates", "batch", {"removed": removed})
    return {"removed": removed}


@router.post("/api/templates/{template_id}/duplicate", response_model=PromptTemplateOut)
def duplicate_template(template_id: str, user: UserOut = Depends(require_user)) -> PromptTemplateOut:
    source = _get_template_or_404(template_id, user)
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


@router.post("/api/templates/{template_id}/set-cover", response_model=PromptTemplateOut)
def set_template_cover(template_id: str, payload: SetCoverIn, user: UserOut = Depends(require_user)) -> PromptTemplateOut:
    template = _get_template_or_404(template_id, user)
    _assert_can_manage_template(template, user)
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


@router.post("/api/templates/{template_id}/rate", response_model=PromptTemplateOut)
def rate_template(template_id: str, payload: RateTemplateIn, user: UserOut = Depends(require_user)) -> PromptTemplateOut:
    _get_template_or_404(template_id, user)
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
        _recalculate_template_quality(conn, template_id)
        row = conn.execute("SELECT * FROM prompt_templates WHERE id = ?", (template_id,)).fetchone()
    return row_to_template(row)


@router.get("/api/templates/{template_id}/samples", response_model=list[TemplateSampleOut])
def list_template_samples(
    template_id: str,
    limit: int = Query(24, ge=1, le=80),
    user: UserOut = Depends(require_user),
) -> list[TemplateSampleOut]:
    template = _get_template_or_404(template_id, user)
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


@router.get("/api/templates/{template_id}/versions", response_model=list[TemplateVersionOut])
def list_template_versions(template_id: str, user: UserOut = Depends(require_user)) -> list[TemplateVersionOut]:
    _get_template_or_404(template_id, user)
    with get_conn() as conn:
        existing_count = conn.execute(
            "SELECT COUNT(*) AS count FROM prompt_template_versions WHERE template_id = ?",
            (template_id,),
        ).fetchone()["count"]
        if not existing_count:
            _snapshot_template_version(conn, template_id, user)
        rows = conn.execute(
            """
            SELECT * FROM prompt_template_versions
            WHERE template_id = ?
            ORDER BY version DESC
            """,
            (template_id,),
        ).fetchall()
    return [row_to_template_version(row) for row in rows]


@router.post("/api/templates/{template_id}/versions/{version_id}/restore", response_model=PromptTemplateOut)
def restore_template_version(
    template_id: str,
    version_id: str,
    user: UserOut = Depends(require_user),
) -> PromptTemplateOut:
    existing = _get_template_or_404(template_id, user)
    _assert_can_manage_template(existing, user)
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
                json_dumps(_normalize_example_images(restored.exampleImages)),
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
        _recalculate_template_quality(conn, template_id)
        _snapshot_template_version(conn, template_id, user)
        row = conn.execute("SELECT * FROM prompt_templates WHERE id = ?", (template_id,)).fetchone()
    return row_to_template(row)


@router.post("/api/templates/{template_id}/submit", response_model=PromptTemplateOut)
def submit_template(template_id: str, user: UserOut = Depends(require_user)) -> PromptTemplateOut:
    template = _get_template_or_404(template_id, user)
    if template.userId != user.id:
        raise HTTPException(status_code=404, detail="Template not found")
    if template.submissionStatus == "submitted":
        return template
    if template.visibility == "public" or template.submissionStatus == "approved":
        raise HTTPException(status_code=409, detail="Template is already public")
    if template.submissionStatus == "rejected":
        raise HTTPException(status_code=409, detail="已被驳回的模板不能重新提交，请修改后再试")
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


@router.get("/api/admin/template-submissions", response_model=list[PromptTemplateOut])
def list_template_submissions(admin: UserOut = Depends(require_template_operator)) -> list[PromptTemplateOut]:
    with get_conn() as conn:
        rows = conn.execute(
            "SELECT * FROM prompt_templates WHERE submission_status = 'submitted' ORDER BY submitted_at DESC, updated_at DESC",
        ).fetchall()
    return [row_to_template(row) for row in rows]


@router.post("/api/admin/template-submissions/{template_id}/approve", response_model=PromptTemplateOut)
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


@router.post("/api/admin/template-submissions/{template_id}/reject", response_model=PromptTemplateOut)
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


@router.get("/api/admin/templates/import-open-library/preview", response_model=OpenPromptPreviewOut)
async def preview_open_library_templates(
    source: str = Query("evolink"),
    limit: int = Query(0, ge=0, le=5000),
    admin: UserOut = Depends(require_template_operator),
) -> OpenPromptPreviewOut:
    del admin
    prompt_source = OPEN_PROMPT_SOURCES.get(source)
    if not prompt_source:
        raise HTTPException(status_code=404, detail="Open prompt source not found")
    all_items = await _fetch_open_prompt_items(prompt_source, 0)
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
        all_existing_prompts = {
            row["prompt"].strip()
            for row in conn.execute("SELECT prompt FROM prompt_templates").fetchall()
            if row["prompt"] and row["prompt"].strip()
        }

        def _is_duplicate(item: dict[str, Any]) -> bool:
            if _open_prompt_duplicate_marker(item)[0] in existing_urls:
                return True
            if _open_prompt_duplicate_marker(item)[1] in existing_title_authors:
                return True
            prompt_text = str(item.get("prompt") or "").strip()
            if prompt_text and prompt_text in all_existing_prompts:
                return True
            return False

        loaded = len(items)
        total = len(all_items)
        duplicate_count = sum(1 for item in items if _is_duplicate(item))
        new_count = max(0, loaded - duplicate_count)
        high_quality_count = sum(1 for item in items if float(item["qualityScore"]) >= 70)
        high_quality_new_count = sum(
            1
            for item in items
            if float(item["qualityScore"]) >= 70 and not _is_duplicate(item)
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
                isDuplicate=_is_duplicate(item),
            )
            for item in items
        ],
    )


@router.post("/api/admin/templates/import-open-library")
async def import_open_library_templates(
    payload: OpenPromptImportIn | None = Body(None),
    source: str = Query("evolink"),
    limit: int = Query(0, ge=0, le=5000),
    admin: UserOut = Depends(require_template_operator),
) -> dict[str, int | bool | str]:
    source_id = payload.source if payload else source
    import_limit = max(0, min(payload.limit, 5000)) if payload else limit
    return await _import_open_prompt_source(source_id, import_limit, admin, payload.selectedKeys if payload else None)


@router.post("/api/admin/templates/import-evolink")
async def import_evolink_templates(
    limit: int = Query(0, ge=0, le=5000),
    admin: UserOut = Depends(require_template_operator),
) -> dict[str, int | bool | str]:
    return await _import_open_prompt_source("evolink", limit, admin)


@router.get("/api/admin/open-prompt-sources", response_model=list[OpenPromptSourceOut])
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


