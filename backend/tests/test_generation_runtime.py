from __future__ import annotations

import asyncio

import pytest

from backend.app.generation_runtime import GenerationRuntime


@pytest.mark.asyncio
async def test_generation_runtime_starts_multiple_workers():
    runtime = GenerationRuntime(
        prepare_execution=lambda _task_id: None,
        run_execution=lambda *_args: asyncio.sleep(0),
        mark_canceled=lambda *_args: None,
        worker_count=3,
    )

    runtime.ensure_workers()

    try:
        assert len(runtime.worker_tasks) == 3
    finally:
        await runtime.shutdown()
