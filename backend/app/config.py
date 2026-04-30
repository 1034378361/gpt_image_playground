from __future__ import annotations

import os
from pathlib import Path


class Settings:
    def __init__(self) -> None:
        base_dir = Path(__file__).resolve().parents[1]
        repo_dir = base_dir.parent
        data_dir = Path(os.getenv("GIP_DATA_DIR", base_dir / "data"))
        self.data_dir = data_dir
        self.database_path = Path(os.getenv("GIP_DATABASE_PATH", data_dir / "app.sqlite3"))
        self.asset_dir = Path(os.getenv("GIP_ASSET_DIR", data_dir / "assets"))
        self.restore_point_dir = Path(os.getenv("GIP_RESTORE_POINT_DIR", data_dir / "restore-points"))
        self.frontend_dist_dir = Path(os.getenv("GIP_FRONTEND_DIST_DIR", repo_dir / "dist"))
        self.session_cookie_name = os.getenv("GIP_SESSION_COOKIE", "gip_session")
        self.session_secure = os.getenv("GIP_SESSION_SECURE", "false").lower() == "true"
        self.session_ttl_seconds = int(os.getenv("GIP_SESSION_TTL_SECONDS", str(7 * 24 * 60 * 60)))
        self.default_api_base_url = os.getenv("OPENAI_BASE_URL", "https://api.openai.com/v1")
        self.request_timeout_seconds = float(os.getenv("GIP_REQUEST_TIMEOUT_SECONDS", "300"))
        self.generation_worker_count = max(1, int(os.getenv("GIP_GENERATION_WORKER_COUNT", "4")))
        self.restore_point_retention = max(1, int(os.getenv("GIP_RESTORE_POINT_RETENTION", "10")))
        self.max_upload_bytes = int(os.getenv("GIP_MAX_UPLOAD_BYTES", str(25 * 1024 * 1024)))
        self.thumbnail_max_size = int(os.getenv("GIP_THUMBNAIL_MAX_SIZE", "512"))
        self.cors_origins = [
            origin.strip()
            for origin in os.getenv("GIP_CORS_ORIGINS", "http://127.0.0.1:5173,http://localhost:5173").split(",")
            if origin.strip()
        ]


settings = Settings()
