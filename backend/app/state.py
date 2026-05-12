from __future__ import annotations

from collections import defaultdict, deque
from dataclasses import dataclass
from typing import Any, Callable

from .generation_runtime import GenerationRuntime

LOGIN_ATTEMPTS: dict[str, deque[int]] = defaultdict(deque)
GENERATION_ATTEMPTS: dict[str, deque[int]] = defaultdict(deque)
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


DEFAULT_AUTH_SETTINGS: dict[str, Any] = {
    "registrationMode": "open",
}
GENERATION_RUNTIME: GenerationRuntime
