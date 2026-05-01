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

            CREATE TABLE IF NOT EXISTS auth_settings (
              id TEXT PRIMARY KEY,
              registration_mode TEXT NOT NULL DEFAULT 'open',
              updated_at INTEGER NOT NULL
            );

            CREATE TABLE IF NOT EXISTS registration_invite_codes (
              id TEXT PRIMARY KEY,
              code TEXT UNIQUE NOT NULL,
              note TEXT NOT NULL DEFAULT '',
              max_uses INTEGER,
              used_count INTEGER NOT NULL DEFAULT 0,
              is_enabled INTEGER NOT NULL DEFAULT 1,
              expires_at INTEGER,
              created_at INTEGER NOT NULL,
              updated_at INTEGER NOT NULL
            );

            CREATE INDEX IF NOT EXISTS idx_registration_invite_codes_enabled_updated
              ON registration_invite_codes(is_enabled, updated_at DESC);

            CREATE TABLE IF NOT EXISTS registration_invite_code_uses (
              id TEXT PRIMARY KEY,
              invite_code_id TEXT REFERENCES registration_invite_codes(id) ON DELETE SET NULL,
              invite_code TEXT NOT NULL,
              user_id TEXT REFERENCES users(id) ON DELETE SET NULL,
              username TEXT NOT NULL DEFAULT '',
              used_at INTEGER NOT NULL
            );

            CREATE INDEX IF NOT EXISTS idx_registration_invite_code_uses_invite_used
              ON registration_invite_code_uses(invite_code_id, used_at DESC);

            CREATE TABLE IF NOT EXISTS projects (
              id TEXT PRIMARY KEY,
              user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
              name TEXT NOT NULL,
              description TEXT NOT NULL DEFAULT '',
              color TEXT NOT NULL DEFAULT '#3b82f6',
              is_archived INTEGER NOT NULL DEFAULT 0,
              created_at INTEGER NOT NULL,
              updated_at INTEGER NOT NULL
            );

            CREATE INDEX IF NOT EXISTS idx_projects_user_updated
              ON projects(user_id, updated_at DESC);

            CREATE TABLE IF NOT EXISTS prompt_templates (
              id TEXT PRIMARY KEY,
              user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
              project_id TEXT REFERENCES projects(id) ON DELETE SET NULL,
              title TEXT NOT NULL,
              description TEXT NOT NULL DEFAULT '',
              prompt TEXT NOT NULL,
              negative_prompt TEXT,
              tags_json TEXT NOT NULL DEFAULT '[]',
              category TEXT NOT NULL DEFAULT '',
              params_json TEXT NOT NULL,
              channel_id TEXT,
              api_mode TEXT NOT NULL,
              model TEXT NOT NULL,
              cover_image_id TEXT,
              external_cover_url TEXT,
              example_images_json TEXT NOT NULL DEFAULT '[]',
              recommended_channel_id TEXT,
              recommended_api_mode TEXT,
              recommended_model TEXT NOT NULL DEFAULT '',
              linked_task_ids_json TEXT NOT NULL DEFAULT '[]',
              is_favorite INTEGER NOT NULL DEFAULT 0,
              favorite_count INTEGER NOT NULL DEFAULT 0,
              usage_count INTEGER NOT NULL DEFAULT 0,
              success_count INTEGER NOT NULL DEFAULT 0,
              failure_count INTEGER NOT NULL DEFAULT 0,
              rating_total INTEGER NOT NULL DEFAULT 0,
              rating_count INTEGER NOT NULL DEFAULT 0,
              last_used_at INTEGER,
              quality_score REAL NOT NULL DEFAULT 0,
              source_name TEXT NOT NULL DEFAULT '',
              source_url TEXT NOT NULL DEFAULT '',
              source_author TEXT NOT NULL DEFAULT '',
              license_name TEXT NOT NULL DEFAULT '',
              form_fields_json TEXT NOT NULL DEFAULT '[]',
              collections_json TEXT NOT NULL DEFAULT '[]',
              is_featured INTEGER NOT NULL DEFAULT 0,
              visibility TEXT NOT NULL DEFAULT 'private',
              submission_status TEXT NOT NULL DEFAULT 'draft',
              submitted_at INTEGER,
              reviewed_at INTEGER,
              reviewed_by TEXT REFERENCES users(id) ON DELETE SET NULL,
              rejection_reason TEXT,
              version INTEGER NOT NULL DEFAULT 1,
              created_at INTEGER NOT NULL,
              updated_at INTEGER NOT NULL
            );

            CREATE INDEX IF NOT EXISTS idx_prompt_templates_user_updated
              ON prompt_templates(user_id, updated_at DESC);

            CREATE TABLE IF NOT EXISTS prompt_template_versions (
              id TEXT PRIMARY KEY,
              template_id TEXT NOT NULL REFERENCES prompt_templates(id) ON DELETE CASCADE,
              version INTEGER NOT NULL,
              snapshot_json TEXT NOT NULL,
              created_by TEXT REFERENCES users(id) ON DELETE SET NULL,
              created_at INTEGER NOT NULL,
              UNIQUE(template_id, version)
            );

            CREATE INDEX IF NOT EXISTS idx_prompt_template_versions_template
              ON prompt_template_versions(template_id, version DESC);

            CREATE TABLE IF NOT EXISTS template_ratings (
              template_id TEXT NOT NULL REFERENCES prompt_templates(id) ON DELETE CASCADE,
              user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
              score INTEGER NOT NULL,
              updated_at INTEGER NOT NULL,
              PRIMARY KEY(template_id, user_id)
            );

            CREATE TABLE IF NOT EXISTS api_channels (
              id TEXT PRIMARY KEY,
              name TEXT NOT NULL,
              base_url TEXT NOT NULL,
              api_key TEXT NOT NULL,
              models_json TEXT NOT NULL DEFAULT '[]',
              timeout_seconds INTEGER NOT NULL DEFAULT 300,
              codex_cli INTEGER NOT NULL DEFAULT 0,
              codex_cli_mode TEXT NOT NULL DEFAULT 'auto',
              health_status TEXT NOT NULL DEFAULT 'unknown',
              health_message TEXT NOT NULL DEFAULT '',
              health_checked_at INTEGER,
              health_latency_ms INTEGER,
              compatibility_status TEXT NOT NULL DEFAULT 'unknown',
              compatibility_message TEXT NOT NULL DEFAULT '',
              compatibility_checked_at INTEGER,
              is_enabled INTEGER NOT NULL DEFAULT 1,
              created_at INTEGER NOT NULL,
              updated_at INTEGER NOT NULL
            );

            CREATE INDEX IF NOT EXISTS idx_api_channels_enabled_updated
              ON api_channels(is_enabled, updated_at DESC);

            CREATE TABLE IF NOT EXISTS generation_tasks (
              id TEXT PRIMARY KEY,
              user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
              template_id TEXT REFERENCES prompt_templates(id) ON DELETE SET NULL,
              template_version_id TEXT,
              project_id TEXT REFERENCES projects(id) ON DELETE SET NULL,
              parent_task_id TEXT REFERENCES generation_tasks(id) ON DELETE SET NULL,
              experiment_id TEXT,
              variation_label TEXT,
              prompt TEXT NOT NULL,
              params_json TEXT NOT NULL,
              input_image_ids_json TEXT NOT NULL DEFAULT '[]',
              mask_target_image_id TEXT,
              mask_image_id TEXT,
              output_image_ids_json TEXT NOT NULL DEFAULT '[]',
              actual_params_json TEXT,
              actual_params_by_image_json TEXT,
              revised_prompt_by_image_json TEXT,
              status TEXT NOT NULL,
              error TEXT,
              created_at INTEGER NOT NULL,
              finished_at INTEGER,
              elapsed INTEGER,
              is_favorite INTEGER NOT NULL DEFAULT 0,
              diagnostics_json TEXT NOT NULL DEFAULT '[]',
              channel_id TEXT REFERENCES api_channels(id) ON DELETE SET NULL,
              api_mode TEXT,
              model TEXT
            );

            CREATE INDEX IF NOT EXISTS idx_generation_tasks_user_created
              ON generation_tasks(user_id, created_at DESC);

            CREATE TABLE IF NOT EXISTS audit_logs (
              id TEXT PRIMARY KEY,
              actor_user_id TEXT REFERENCES users(id) ON DELETE SET NULL,
              actor_username TEXT,
              action TEXT NOT NULL,
              resource_type TEXT NOT NULL,
              resource_id TEXT,
              details_json TEXT NOT NULL DEFAULT '{}',
              created_at INTEGER NOT NULL
            );

            CREATE INDEX IF NOT EXISTS idx_audit_logs_created
              ON audit_logs(created_at DESC);

            CREATE TABLE IF NOT EXISTS auto_import_settings (
              id TEXT PRIMARY KEY,
              settings_json TEXT NOT NULL DEFAULT '{}',
              github_token TEXT NOT NULL DEFAULT '',
              last_run_at INTEGER,
              updated_at INTEGER NOT NULL
            );

            CREATE TABLE IF NOT EXISTS open_prompt_discoveries (
              id TEXT PRIMARY KEY,
              source_id TEXT NOT NULL,
              label TEXT NOT NULL,
              repo_url TEXT UNIQUE NOT NULL,
              description TEXT NOT NULL DEFAULT '',
              stars INTEGER NOT NULL DEFAULT 0,
              forks INTEGER NOT NULL DEFAULT 0,
              hot_score REAL NOT NULL DEFAULT 0,
              prompt_count INTEGER NOT NULL DEFAULT 0,
              license_name TEXT NOT NULL DEFAULT '',
              last_seen_at INTEGER NOT NULL,
              last_imported_at INTEGER,
              last_status TEXT NOT NULL DEFAULT '',
              last_message TEXT NOT NULL DEFAULT ''
            );

            CREATE INDEX IF NOT EXISTS idx_open_prompt_discoveries_hot
              ON open_prompt_discoveries(hot_score DESC, last_seen_at DESC);

            CREATE TABLE IF NOT EXISTS auto_import_runs (
              id TEXT PRIMARY KEY,
              status TEXT NOT NULL,
              trigger TEXT NOT NULL,
              started_at INTEGER NOT NULL,
              finished_at INTEGER,
              discovered_repositories INTEGER NOT NULL DEFAULT 0,
              selected_repositories INTEGER NOT NULL DEFAULT 0,
              created INTEGER NOT NULL DEFAULT 0,
              updated INTEGER NOT NULL DEFAULT 0,
              skipped INTEGER NOT NULL DEFAULT 0,
              submitted INTEGER NOT NULL DEFAULT 0,
              approved INTEGER NOT NULL DEFAULT 0,
              message TEXT NOT NULL DEFAULT '',
              details_json TEXT NOT NULL DEFAULT '{}'
            );

            CREATE INDEX IF NOT EXISTS idx_auto_import_runs_started
              ON auto_import_runs(started_at DESC);

            CREATE TABLE IF NOT EXISTS assets (
              id TEXT PRIMARY KEY,
              user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
              task_id TEXT REFERENCES generation_tasks(id) ON DELETE SET NULL,
              template_id TEXT REFERENCES prompt_templates(id) ON DELETE SET NULL,
              type TEXT NOT NULL,
              path TEXT NOT NULL,
              thumbnail_path TEXT,
              mime TEXT NOT NULL,
              width INTEGER,
              height INTEGER,
              size_bytes INTEGER NOT NULL,
              visual_hash TEXT,
              created_at INTEGER NOT NULL
            );

            CREATE INDEX IF NOT EXISTS idx_assets_user_created
              ON assets(user_id, created_at DESC);
            """
        )
        ensure_column(db, "generation_tasks", "actual_params_json", "TEXT")
        ensure_column(db, "generation_tasks", "actual_params_by_image_json", "TEXT")
        ensure_column(db, "generation_tasks", "revised_prompt_by_image_json", "TEXT")
        ensure_column(db, "generation_tasks", "project_id", "TEXT REFERENCES projects(id) ON DELETE SET NULL")
        ensure_column(db, "generation_tasks", "parent_task_id", "TEXT REFERENCES generation_tasks(id) ON DELETE SET NULL")
        ensure_column(db, "generation_tasks", "experiment_id", "TEXT")
        ensure_column(db, "generation_tasks", "variation_label", "TEXT")
        ensure_column(db, "generation_tasks", "channel_id", "TEXT REFERENCES api_channels(id) ON DELETE SET NULL")
        ensure_column(db, "generation_tasks", "mask_target_image_id", "TEXT")
        ensure_column(db, "generation_tasks", "mask_image_id", "TEXT")
        ensure_column(db, "generation_tasks", "diagnostics_json", "TEXT NOT NULL DEFAULT '[]'")
        ensure_column(db, "api_channels", "timeout_seconds", "INTEGER NOT NULL DEFAULT 300")
        ensure_column(db, "api_channels", "codex_cli_mode", "TEXT NOT NULL DEFAULT 'auto'")
        ensure_column(db, "api_channels", "health_status", "TEXT NOT NULL DEFAULT 'unknown'")
        ensure_column(db, "api_channels", "health_message", "TEXT NOT NULL DEFAULT ''")
        ensure_column(db, "api_channels", "health_checked_at", "INTEGER")
        ensure_column(db, "api_channels", "health_latency_ms", "INTEGER")
        ensure_column(db, "api_channels", "compatibility_status", "TEXT NOT NULL DEFAULT 'unknown'")
        ensure_column(db, "api_channels", "compatibility_message", "TEXT NOT NULL DEFAULT ''")
        ensure_column(db, "api_channels", "compatibility_checked_at", "INTEGER")
        ensure_column(db, "prompt_templates", "project_id", "TEXT REFERENCES projects(id) ON DELETE SET NULL")
        ensure_column(db, "prompt_templates", "channel_id", "TEXT")
        ensure_column(db, "prompt_templates", "external_cover_url", "TEXT")
        ensure_column(db, "prompt_templates", "example_images_json", "TEXT NOT NULL DEFAULT '[]'")
        ensure_column(db, "prompt_templates", "recommended_channel_id", "TEXT")
        ensure_column(db, "prompt_templates", "recommended_api_mode", "TEXT")
        ensure_column(db, "prompt_templates", "recommended_model", "TEXT NOT NULL DEFAULT ''")
        ensure_column(db, "prompt_templates", "source_name", "TEXT NOT NULL DEFAULT ''")
        ensure_column(db, "prompt_templates", "source_url", "TEXT NOT NULL DEFAULT ''")
        ensure_column(db, "prompt_templates", "source_author", "TEXT NOT NULL DEFAULT ''")
        ensure_column(db, "prompt_templates", "license_name", "TEXT NOT NULL DEFAULT ''")
        ensure_column(db, "prompt_templates", "favorite_count", "INTEGER NOT NULL DEFAULT 0")
        ensure_column(db, "prompt_templates", "usage_count", "INTEGER NOT NULL DEFAULT 0")
        ensure_column(db, "prompt_templates", "success_count", "INTEGER NOT NULL DEFAULT 0")
        ensure_column(db, "prompt_templates", "failure_count", "INTEGER NOT NULL DEFAULT 0")
        ensure_column(db, "prompt_templates", "rating_total", "INTEGER NOT NULL DEFAULT 0")
        ensure_column(db, "prompt_templates", "rating_count", "INTEGER NOT NULL DEFAULT 0")
        ensure_column(db, "prompt_templates", "last_used_at", "INTEGER")
        ensure_column(db, "prompt_templates", "quality_score", "REAL NOT NULL DEFAULT 0")
        ensure_column(db, "prompt_templates", "visibility", "TEXT NOT NULL DEFAULT 'private'")
        ensure_column(db, "prompt_templates", "submission_status", "TEXT NOT NULL DEFAULT 'draft'")
        ensure_column(db, "prompt_templates", "submitted_at", "INTEGER")
        ensure_column(db, "prompt_templates", "reviewed_at", "INTEGER")
        ensure_column(db, "prompt_templates", "reviewed_by", "TEXT REFERENCES users(id) ON DELETE SET NULL")
        ensure_column(db, "prompt_templates", "rejection_reason", "TEXT")
        ensure_column(db, "prompt_templates", "form_fields_json", "TEXT NOT NULL DEFAULT '[]'")
        ensure_column(db, "prompt_templates", "collections_json", "TEXT NOT NULL DEFAULT '[]'")
        ensure_column(db, "prompt_templates", "is_featured", "INTEGER NOT NULL DEFAULT 0")
        ensure_column(db, "assets", "thumbnail_path", "TEXT")
        ensure_column(db, "assets", "visual_hash", "TEXT")
        db.execute(
            """
            CREATE INDEX IF NOT EXISTS idx_prompt_templates_visibility_updated
              ON prompt_templates(visibility, submission_status, updated_at DESC)
            """
        )
        db.commit()
    finally:
        if owns_conn:
            db.close()


def ensure_column(conn: sqlite3.Connection, table: str, column: str, declaration: str) -> None:
    existing = {row["name"] for row in conn.execute(f"PRAGMA table_info({table})").fetchall()}
    if column not in existing:
        conn.execute(f"ALTER TABLE {table} ADD COLUMN {column} {declaration}")
