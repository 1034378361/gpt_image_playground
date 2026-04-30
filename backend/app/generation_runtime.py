from __future__ import annotations

import asyncio
from dataclasses import dataclass
from typing import Any, Awaitable, Callable


@dataclass(frozen=True)
class GenerationExecution:
    task_id: str
    user_id: str
    started_at: int
    payload: Any
    user: Any


PrepareExecution = Callable[[str], GenerationExecution | None]
RunExecution = Callable[[Any, Any, int], Awaitable[None]]
MarkCanceled = Callable[[str, str, int], Any]


class GenerationRuntime:
    def __init__(
        self,
        *,
        prepare_execution: PrepareExecution,
        run_execution: RunExecution,
        mark_canceled: MarkCanceled,
        worker_count: int = 1,
    ) -> None:
        self._prepare_execution = prepare_execution
        self._run_execution = run_execution
        self._mark_canceled = mark_canceled
        self._worker_count = max(1, worker_count)
        self.queue: asyncio.Queue[str] = asyncio.Queue()
        self.queued_task_ids: set[str] = set()
        self.worker_tasks: set[asyncio.Task[None]] = set()
        self.active_tasks: dict[str, asyncio.Task[None]] = {}

    async def queue_task(self, task_id: str) -> None:
        if task_id in self.queued_task_ids or task_id in self.active_tasks:
            return
        self.queued_task_ids.add(task_id)
        await self.queue.put(task_id)

    def discard_queued(self, task_id: str) -> None:
        self.queued_task_ids.discard(task_id)

    def cancel_active(self, task_id: str) -> None:
        active_task = self.active_tasks.get(task_id)
        if active_task and not active_task.done():
            active_task.cancel()

    def snapshot(self) -> dict[str, int]:
        active_count = sum(1 for task in self.active_tasks.values() if not task.done())
        return {
            "worker_count": self._worker_count,
            "queued_count": len(self.queued_task_ids),
            "running_count": active_count,
        }

    async def shutdown(self) -> None:
        for task in list(self.worker_tasks):
            task.cancel()
        if self.worker_tasks:
            await asyncio.gather(*self.worker_tasks, return_exceptions=True)

    async def _worker(self) -> None:
        while True:
            task_id = await self.queue.get()
            self.queued_task_ids.discard(task_id)
            try:
                execution = self._prepare_execution(task_id)
                if not execution:
                    continue
                active_task = asyncio.create_task(
                    self._run_execution(execution.payload, execution.user, execution.started_at),
                    name=f"generation-{task_id}",
                )
                self.active_tasks[task_id] = active_task
                try:
                    await active_task
                except asyncio.CancelledError:
                    worker_task = asyncio.current_task()
                    if worker_task and worker_task.cancelling():
                        active_task.cancel()
                        raise
                    self._mark_canceled(execution.task_id, execution.user_id, execution.started_at)
                finally:
                    self.active_tasks.pop(task_id, None)
            finally:
                self.queue.task_done()

    def ensure_workers(self) -> None:
        try:
            current_loop = asyncio.get_running_loop()
        except RuntimeError:
            return

        live_tasks: set[asyncio.Task[None]] = set()
        for task in self.worker_tasks:
            try:
                task_loop = task.get_loop()
            except RuntimeError:
                continue
            if not task.done() and task_loop is current_loop and not task_loop.is_closed():
                live_tasks.add(task)

        self.worker_tasks.clear()
        self.worker_tasks.update(live_tasks)
        if len(self.worker_tasks) >= self._worker_count:
            return

        for index in range(len(self.worker_tasks), self._worker_count):
            worker = asyncio.create_task(self._worker(), name=f"generation-worker-{index + 1}")
            self.worker_tasks.add(worker)
            worker.add_done_callback(lambda task: self.worker_tasks.discard(task))
