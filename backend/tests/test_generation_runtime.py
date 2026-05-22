from __future__ import annotations

import asyncio

import pytest

from backend.app.generation_runtime import GenerationExecution, GenerationRuntime


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


@pytest.mark.asyncio
async def test_generation_runtime_survives_run_execution_exception():
    completed: list[str] = []

    def prepare_execution(task_id: str) -> GenerationExecution:
        return GenerationExecution(task_id=task_id, user_id="user", started_at=1, payload=task_id, user=None)

    async def run_execution(payload, _user, _started_at):
        if payload == "boom":
            raise RuntimeError("boom")
        completed.append(payload)

    runtime = GenerationRuntime(
        prepare_execution=prepare_execution,
        run_execution=run_execution,
        mark_canceled=lambda *_args: None,
        worker_count=1,
    )

    runtime.ensure_workers()
    await runtime.queue_task("boom")
    await runtime.queue_task("ok")
    await asyncio.wait_for(runtime.queue.join(), timeout=1)

    try:
        assert completed == ["ok"]
        assert len(runtime.worker_tasks) == 1
    finally:
        await runtime.shutdown()


@pytest.mark.asyncio
async def test_generation_runtime_survives_prepare_execution_exception():
    completed: list[str] = []

    def prepare_execution(task_id: str) -> GenerationExecution:
        if task_id == "boom":
            raise RuntimeError("boom")
        return GenerationExecution(task_id=task_id, user_id="user", started_at=1, payload=task_id, user=None)

    async def run_execution(payload, _user, _started_at):
        completed.append(payload)

    runtime = GenerationRuntime(
        prepare_execution=prepare_execution,
        run_execution=run_execution,
        mark_canceled=lambda *_args: None,
        worker_count=1,
    )

    runtime.ensure_workers()
    await runtime.queue_task("boom")
    await runtime.queue_task("ok")
    await asyncio.wait_for(runtime.queue.join(), timeout=1)

    try:
        assert completed == ["ok"]
        assert len(runtime.worker_tasks) == 1
    finally:
        await runtime.shutdown()
