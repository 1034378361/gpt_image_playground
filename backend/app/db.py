from __future__ import annotations

import sqlite3
from contextlib import contextmanager
from pathlib import Path
from typing import Iterator

from .config import settings


def connect(path: Path | None = None) -> sqlite3.Connection:
    db_path = path or settings.database_path
    db_path.parent.mkdir(parents=True, exist_ok=True)
    conn = sqlite3.connect(db_path)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA foreign_keys = ON")
    return conn


@contextmanager
def get_conn() -> Iterator[sqlite3.Connection]:
    conn = connect()
    try:
        yield conn
        conn.commit()
    except Exception:
        conn.rollback()
        raise
    finally:
        conn.close()


def init_db(conn: sqlite3.Connection | None = None) -> None:
    owns_conn = conn is None
    db = conn or connect()
    try:
        db.executescript(
            """
            CREATE TABLE IF NOT EXISTS users (
              id TEXT PRIMARY KEY,
              username TEXT UNIQUE NOT NULL,
              password_hash TEXT NOT NULL,
              role TEXT NOT NULL DEFAULT 'user',
              created_at INTEGER NOT NULL,
              updated_at INTEGER NOT NULL
            );

            CREATE TABLE IF NOT EXISTS sessions (
              id TEXT PRIMARY KEY,
              user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
              created_at INTEGER NOT NULL,
              expires_at INTEGER
            );

            CREATE TABLE IF NOT EXISTS prompt_templates (
              id TEXT PRIMARY KEY,
              user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
              title TEXT NOT NULL,
              description TEXT NOT NULL DEFAULT '',
              prompt TEXT NOT NULL,
              negative_prompt TEXT,
              tags_json TEXT NOT NULL DEFAULT '[]',
              category TEXT NOT NULL DEFAULT '',
              params_json TEXT NOT NULL,
              api_mode TEXT NOT NULL,
              model TEXT NOT NULL,
              cover_image_id TEXT,
              linked_task_ids_json TEXT NOT NULL DEFAULT '[]',
              is_favorite INTEGER NOT NULL DEFAULT 0,
              version INTEGER NOT NULL DEFAULT 1,
              created_at INTEGER NOT NULL,
              updated_at INTEGER NOT NULL
            );

            CREATE INDEX IF NOT EXISTS idx_prompt_templates_user_updated
              ON prompt_templates(user_id, updated_at DESC);

            CREATE TABLE IF NOT EXISTS generation_tasks (
              id TEXT PRIMARY KEY,
              user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
              template_id TEXT REFERENCES prompt_templates(id) ON DELETE SET NULL,
              template_version_id TEXT,
              prompt TEXT NOT NULL,
              params_json TEXT NOT NULL,
              input_image_ids_json TEXT NOT NULL DEFAULT '[]',
              output_image_ids_json TEXT NOT NULL DEFAULT '[]',
              status TEXT NOT NULL,
              error TEXT,
              created_at INTEGER NOT NULL,
              finished_at INTEGER,
              elapsed INTEGER,
              is_favorite INTEGER NOT NULL DEFAULT 0,
              api_mode TEXT,
              model TEXT
            );

            CREATE INDEX IF NOT EXISTS idx_generation_tasks_user_created
              ON generation_tasks(user_id, created_at DESC);

            CREATE TABLE IF NOT EXISTS assets (
              id TEXT PRIMARY KEY,
              user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
              task_id TEXT REFERENCES generation_tasks(id) ON DELETE SET NULL,
              template_id TEXT REFERENCES prompt_templates(id) ON DELETE SET NULL,
              type TEXT NOT NULL,
              path TEXT NOT NULL,
              mime TEXT NOT NULL,
              width INTEGER,
              height INTEGER,
              size_bytes INTEGER NOT NULL,
              created_at INTEGER NOT NULL
            );

            CREATE INDEX IF NOT EXISTS idx_assets_user_created
              ON assets(user_id, created_at DESC);
            """
        )
        db.commit()
    finally:
        if owns_conn:
            db.close()
