from __future__ import annotations

import asyncio
from contextlib import asynccontextmanager
from pathlib import Path

import httpx  # noqa: F401 — used by test monkeypatching
from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse

from .config import settings
from .db import init_db
from .generation_runtime import GenerationRuntime
from . import state as _state
from .state import AUTO_IMPORT_WORKER_TASKS

from .routes.admin import router as admin_router
from .routes.auth import router as auth_router
from .routes.assets import router as assets_router
from .routes.channels import router as channels_router
from .routes.generations import router as generations_router
from .routes.projects import router as projects_router
from .routes.prompts import router as prompts_router
from .routes.templates import router as templates_router
from .routes.templates import perform_auto_import, should_run_auto_import_now, read_auto_import_settings, _first_admin_user as first_admin_user

from .routes.generations import (
    prepare_generation_execution,
    complete_generation_task_safely,
    mark_generation_canceled,
    recover_pending_generation_tasks,
    enqueue_pending_generation_tasks,
    ensure_generation_workers,
)


@asynccontextmanager
async def lifespan(_: FastAPI):
    init_db()
    recover_pending_generation_tasks()
    ensure_generation_workers()
    await enqueue_pending_generation_tasks()
    ensure_auto_import_worker()
    try:
        yield
    finally:
        for task in list(AUTO_IMPORT_WORKER_TASKS):
            task.cancel()
        await GENERATION_RUNTIME.shutdown()
        if AUTO_IMPORT_WORKER_TASKS:
            await asyncio.gather(*AUTO_IMPORT_WORKER_TASKS, return_exceptions=True)


app = FastAPI(title="GPT Image Playground API", lifespan=lifespan)

app.add_middleware(
    CORSMiddleware,
    allow_origins=settings.cors_origins,
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

app.include_router(admin_router)
app.include_router(auth_router)
app.include_router(assets_router)
app.include_router(channels_router)
app.include_router(generations_router)
app.include_router(projects_router)
app.include_router(prompts_router)
app.include_router(templates_router)


@app.get("/api/health")
def healthcheck() -> dict[str, bool]:
    return {"ok": True}


def get_frontend_index_path() -> Path | None:
    dist_dir = settings.frontend_dist_dir
    index_path = dist_dir / "index.html"
    return index_path if dist_dir.is_dir() and index_path.is_file() else None


def resolve_frontend_file(relative_path: str) -> Path | None:
    index_path = get_frontend_index_path()
    if index_path is None:
        return None
    dist_dir = settings.frontend_dist_dir.resolve()
    requested = (dist_dir / relative_path.lstrip("/")).resolve()
    try:
        requested.relative_to(dist_dir)
    except ValueError:
        return None
    return requested if requested.is_file() else None


# ---------------------------------------------------------------------------
# GENERATION_RUNTIME initialization
# ---------------------------------------------------------------------------

GENERATION_RUNTIME = GenerationRuntime(
    prepare_execution=prepare_generation_execution,
    run_execution=complete_generation_task_safely,
    mark_canceled=lambda task_id, user_id, started_at: mark_generation_canceled(task_id, user_id, started_at),
    worker_count=settings.generation_worker_count,
)
_state.GENERATION_RUNTIME = GENERATION_RUNTIME


# ---------------------------------------------------------------------------
# Auto-import scheduler
# ---------------------------------------------------------------------------

async def auto_import_scheduler() -> None:
    while True:
        try:
            settings_data, _ = read_auto_import_settings()
            if should_run_auto_import_now(settings_data):
                actor = first_admin_user()
                if actor:
                    try:
                        await perform_auto_import("scheduled", actor)
                    except HTTPException as exc:
                        if exc.status_code != 409:
                            raise
        except asyncio.CancelledError:
            raise
        except Exception:
            pass
        await asyncio.sleep(60)


def ensure_auto_import_worker() -> None:
    try:
        current_loop = asyncio.get_running_loop()
    except RuntimeError:
        return

    live_tasks: set[asyncio.Task[None]] = set()
    for task in AUTO_IMPORT_WORKER_TASKS:
        try:
            task_loop = task.get_loop()
        except RuntimeError:
            continue
        if not task.done() and task_loop is current_loop and not task_loop.is_closed():
            live_tasks.add(task)

    AUTO_IMPORT_WORKER_TASKS.clear()
    AUTO_IMPORT_WORKER_TASKS.update(live_tasks)
    if AUTO_IMPORT_WORKER_TASKS:
        return

    worker = asyncio.create_task(auto_import_scheduler(), name="auto-import-scheduler")
    AUTO_IMPORT_WORKER_TASKS.add(worker)
    worker.add_done_callback(lambda task: AUTO_IMPORT_WORKER_TASKS.discard(task))


# ---------------------------------------------------------------------------
# Frontend serving (catch-all)
# ---------------------------------------------------------------------------

@app.get("/", include_in_schema=False)
def serve_frontend_index() -> FileResponse:
    index_path = get_frontend_index_path()
    if index_path is None:
        raise HTTPException(status_code=503, detail="Frontend bundle is not available")
    return FileResponse(index_path)


@app.get("/{frontend_path:path}", include_in_schema=False)
def serve_frontend(frontend_path: str) -> FileResponse:
    if frontend_path.startswith("api/"):
        raise HTTPException(status_code=404, detail="Not found")
    file_path = resolve_frontend_file(frontend_path)
    if file_path is not None:
        return FileResponse(file_path)
    index_path = get_frontend_index_path()
    if index_path is None:
        raise HTTPException(status_code=503, detail="Frontend bundle is not available")
    return FileResponse(index_path)

