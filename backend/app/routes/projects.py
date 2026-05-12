from __future__ import annotations

from typing import Any

from fastapi import APIRouter, Depends, HTTPException

from ..db import get_conn
from ..schemas import ProjectBoardIn, ProjectBoardOut, ProjectBoardPatch, UserOut
from ..security import new_id, now_ms
from ..helpers import get_project_row_or_404, row_to_project
from ..dependencies import require_user

router = APIRouter(prefix="/api/projects", tags=["projects"])


@router.get("", response_model=list[ProjectBoardOut])
def list_projects(user: UserOut = Depends(require_user)) -> list[ProjectBoardOut]:
    with get_conn() as conn:
        rows = conn.execute(
            """
            SELECT
              projects.*,
              (
                SELECT COUNT(*) FROM generation_tasks
                WHERE generation_tasks.project_id = projects.id AND generation_tasks.user_id = projects.user_id
              ) AS task_count,
              (
                SELECT COUNT(*) FROM prompt_templates
                WHERE prompt_templates.project_id = projects.id AND prompt_templates.user_id = projects.user_id
              ) AS template_count
            FROM projects
            WHERE projects.user_id = ?
            ORDER BY projects.is_archived ASC, projects.updated_at DESC
            """,
            (user.id,),
        ).fetchall()
    return [row_to_project(row) for row in rows]


@router.post("", response_model=ProjectBoardOut)
def create_project(payload: ProjectBoardIn, user: UserOut = Depends(require_user)) -> ProjectBoardOut:
    project_id = new_id()
    ts = now_ms()
    with get_conn() as conn:
        conn.execute(
            """
            INSERT INTO projects (id, user_id, name, description, color, is_archived, created_at, updated_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?)
            """,
            (
                project_id,
                user.id,
                payload.name.strip(),
                payload.description.strip(),
                payload.color.strip() or "#3b82f6",
                int(payload.isArchived),
                ts,
                ts,
            ),
        )
        row = conn.execute(
            """
            SELECT projects.*, 0 AS task_count, 0 AS template_count
            FROM projects
            WHERE id = ? AND user_id = ?
            """,
            (project_id, user.id),
        ).fetchone()
    return row_to_project(row)


@router.patch("/{project_id}", response_model=ProjectBoardOut)
def patch_project(project_id: str, payload: ProjectBoardPatch, user: UserOut = Depends(require_user)) -> ProjectBoardOut:
    data = payload.model_dump(exclude_unset=True)
    with get_conn() as conn:
        row = get_project_row_or_404(conn, project_id, user)
        if not data:
            return row_to_project(
                conn.execute(
                    """
                    SELECT projects.*,
                      (
                        SELECT COUNT(*) FROM generation_tasks
                        WHERE generation_tasks.project_id = projects.id AND generation_tasks.user_id = projects.user_id
                      ) AS task_count,
                      (
                        SELECT COUNT(*) FROM prompt_templates
                        WHERE prompt_templates.project_id = projects.id AND prompt_templates.user_id = projects.user_id
                      ) AS template_count
                    FROM projects WHERE id = ? AND user_id = ?
                    """,
                    (project_id, user.id),
                ).fetchone()
            )
        next_name = payload.name.strip() if payload.name is not None else row["name"]
        next_description = payload.description.strip() if payload.description is not None else row["description"]
        next_color = payload.color.strip() if payload.color is not None else row["color"]
        next_archived = int(payload.isArchived if payload.isArchived is not None else bool(row["is_archived"]))
        ts = now_ms()
        conn.execute(
            """
            UPDATE projects
            SET name = ?, description = ?, color = ?, is_archived = ?, updated_at = ?
            WHERE id = ? AND user_id = ?
            """,
            (next_name, next_description, next_color or "#3b82f6", next_archived, ts, project_id, user.id),
        )
        updated = conn.execute(
            """
            SELECT
              projects.*,
              (
                SELECT COUNT(*) FROM generation_tasks
                WHERE generation_tasks.project_id = projects.id AND generation_tasks.user_id = projects.user_id
              ) AS task_count,
              (
                SELECT COUNT(*) FROM prompt_templates
                WHERE prompt_templates.project_id = projects.id AND prompt_templates.user_id = projects.user_id
              ) AS template_count
            FROM projects
            WHERE projects.id = ? AND projects.user_id = ?
            """,
            (project_id, user.id),
        ).fetchone()
    return row_to_project(updated)


@router.delete("/{project_id}")
def delete_project(project_id: str, user: UserOut = Depends(require_user)) -> dict[str, bool]:
    with get_conn() as conn:
        get_project_row_or_404(conn, project_id, user)
        active = conn.execute(
            "SELECT COUNT(*) AS count FROM generation_tasks WHERE project_id = ? AND user_id = ? AND status IN ('queued', 'running')",
            (project_id, user.id),
        ).fetchone()
        if active["count"] > 0:
            raise HTTPException(status_code=409, detail="项目中有正在执行的任务，无法删除")
        cur = conn.execute("DELETE FROM projects WHERE id = ? AND user_id = ?", (project_id, user.id))
    if cur.rowcount == 0:
        raise HTTPException(status_code=404, detail="Project not found")
    return {"ok": True}