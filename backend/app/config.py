from __future__ import annotations

import os
from pathlib import Path


class Settings:
    def __init__(self) -> None:
        base_dir = Path(__file__).resolve().parents[1]
        data_dir = Path(os.getenv("GIP_DATA_DIR", base_dir / "data"))
        self.data_dir = data_dir
        self.database_path = Path(os.getenv("GIP_DATABASE_PATH", data_dir / "app.sqlite3"))
        self.asset_dir = Path(os.getenv("GIP_ASSET_DIR", data_dir / "assets"))
        self.session_cookie_name = os.getenv("GIP_SESSION_COOKIE", "gip_session")
        self.session_secure = os.getenv("GIP_SESSION_SECURE", "false").lower() == "true"
        self.openai_api_key = os.getenv("OPENAI_API_KEY", "")
        self.default_api_base_url = os.getenv("OPENAI_BASE_URL", "https://api.openai.com/v1")
        self.allow_client_api_key = os.getenv("GIP_ALLOW_CLIENT_API_KEY", "false").lower() == "true"
        self.request_timeout_seconds = float(os.getenv("GIP_REQUEST_TIMEOUT_SECONDS", "300"))


settings = Settings()
