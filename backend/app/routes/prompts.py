from __future__ import annotations

import re
from typing import Any

import httpx
from fastapi import APIRouter, Depends, HTTPException

from ..config import settings
from ..schemas import PromptOptimizeIn, PromptOptimizeOut, UserOut
from ..helpers import endpoint_url, get_enabled_channel_model, normalize_base_url
from ..dependencies import require_user

router = APIRouter(prefix="/api/prompts", tags=["prompts"])


# ---------------------------------------------------------------------------
# Helpers used only by prompts routes
# ---------------------------------------------------------------------------


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


@router.post("/optimize", response_model=PromptOptimizeOut)
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
