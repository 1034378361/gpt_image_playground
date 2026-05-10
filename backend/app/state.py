from __future__ import annotations

import asyncio
from collections import defaultdict, deque
from dataclasses import dataclass
from typing import Any, Callable

from .generation_runtime import GenerationRuntime

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
DEFAULT_AUTH_SETTINGS: dict[str, Any] = {
    "registrationMode": "open",
}
GENERATION_RUNTIME: GenerationRuntime
