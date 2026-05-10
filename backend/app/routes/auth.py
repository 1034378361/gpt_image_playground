from __future__ import annotations

from typing import Any

from fastapi import APIRouter, Depends, HTTPException, Request, Response

from ..config import settings
from ..db import get_conn
from ..schemas import AuthIn, AuthRegisterIn, AuthSettingsOut, UserOut
from ..security import create_session_token, hash_password, new_id, now_ms, verify_password
from ..helpers import auth_settings_to_out, get_auth_settings, get_invite_code_row_or_404, row_to_user
from ..dependencies import (
    assert_auth_not_rate_limited,
    clear_failed_auth,
    record_failed_auth,
    require_user,
    set_session_cookie,
)

router = APIRouter(prefix="/api/auth", tags=["auth"])


# ---------------------------------------------------------------------------
# Helpers used only by auth routes
# ---------------------------------------------------------------------------


def consume_invite_code_or_400(conn: Any, invite_row: Any, ts: int) -> None:
    invite_id = invite_row["id"]
    if invite_row["max_uses"] is None:
        result = conn.execute(
            """
            UPDATE registration_invite_codes
            SET used_count = used_count + 1, updated_at = ?
            WHERE id = ? AND is_enabled = 1 AND (expires_at IS NULL OR expires_at >= ?)
            """,
            (ts, invite_id, ts),
        )
    else:
        result = conn.execute(
            """
            UPDATE registration_invite_codes
            SET used_count = used_count + 1, updated_at = ?
            WHERE id = ?
              AND is_enabled = 1
              AND (expires_at IS NULL OR expires_at >= ?)
              AND used_count < max_uses
            """,
            (ts, invite_id, ts),
        )
    if result.rowcount:
        return

    latest = get_invite_code_row_or_404(conn, invite_id)
    if not bool(latest["is_enabled"]):
        raise HTTPException(status_code=400, detail="邀请码已停用")
    if latest["expires_at"] is not None and int(latest["expires_at"]) < ts:
        raise HTTPException(status_code=400, detail="邀请码已过期")
    if latest["max_uses"] is not None and int(latest["used_count"] or 0) >= int(latest["max_uses"]):
        raise HTTPException(status_code=400, detail="邀请码已用完")
    raise HTTPException(status_code=400, detail="邀请码当前不可用，请稍后重试")


# ---------------------------------------------------------------------------
# Routes
# ---------------------------------------------------------------------------


@router.post("/register", response_model=UserOut)
def register(payload: AuthRegisterIn, response: Response) -> UserOut:
    username = payload.username.strip()
    if not username:
        raise HTTPException(status_code=400, detail="Username is required")

    user_id = new_id()
    ts = now_ms()
    expires_at = ts + settings.session_ttl_seconds * 1000
    password_hash = hash_password(payload.password)
    token = create_session_token()

    try:
        with get_conn() as conn:
            conn.execute("BEGIN IMMEDIATE")
            user_count = conn.execute("SELECT COUNT(*) AS count FROM users").fetchone()["count"]
            auth_settings = get_auth_settings(conn)
            registration_mode = str(auth_settings["registrationMode"])
            invite_row = None
            if user_count > 0:
                if registration_mode == "disabled":
                    raise HTTPException(status_code=403, detail="当前系统已关闭用户注册")
                if registration_mode == "invite_only":
                    invite_code = (payload.inviteCode or "").strip()
                    if not invite_code:
                        raise HTTPException(status_code=400, detail="当前注册需要邀请码")
                    invite_row = conn.execute(
                        "SELECT * FROM registration_invite_codes WHERE code = ?",
                        (invite_code,),
                    ).fetchone()
                    if not invite_row:
                        raise HTTPException(status_code=400, detail="邀请码无效")
                    if not bool(invite_row["is_enabled"]):
                        raise HTTPException(status_code=400, detail="邀请码已停用")
                    if invite_row["expires_at"] is not None and int(invite_row["expires_at"]) < ts:
                        raise HTTPException(status_code=400, detail="邀请码已过期")
                    if invite_row["max_uses"] is not None and int(invite_row["used_count"] or 0) >= int(invite_row["max_uses"]):
                        raise HTTPException(status_code=400, detail="邀请码已用完")
            role = "admin" if user_count == 0 else "user"
            conn.execute(
                """
                INSERT INTO users (id, username, password_hash, role, created_at, updated_at)
                VALUES (?, ?, ?, ?, ?, ?)
                """,
                (user_id, username, password_hash, role, ts, ts),
            )
            conn.execute(
                "INSERT INTO sessions (id, user_id, created_at, expires_at) VALUES (?, ?, ?, ?)",
                (token, user_id, ts, expires_at),
            )
            if invite_row is not None:
                consume_invite_code_or_400(conn, invite_row, ts)
                conn.execute(
                    """
                    INSERT INTO registration_invite_code_uses (
                      id, invite_code_id, invite_code, user_id, username, used_at
                    ) VALUES (?, ?, ?, ?, ?, ?)
                    """,
                    (new_id(), invite_row["id"], invite_row["code"], user_id, username, ts),
                )
            row = conn.execute("SELECT * FROM users WHERE id = ?", (user_id,)).fetchone()
    except Exception as exc:
        if isinstance(exc, HTTPException):
            raise
        if "UNIQUE" in str(exc).upper():
            raise HTTPException(status_code=409, detail="Username already exists") from exc
        raise

    set_session_cookie(response, token)
    return row_to_user(row)


@router.post("/login", response_model=UserOut)
def login(payload: AuthIn, response: Response) -> UserOut:
    username = payload.username.strip()
    assert_auth_not_rate_limited(username)
    with get_conn() as conn:
        row = conn.execute("SELECT * FROM users WHERE username = ?", (username,)).fetchone()
        if not row or not verify_password(payload.password, row["password_hash"]):
            record_failed_auth(username)
            raise HTTPException(status_code=401, detail="Invalid username or password")

        token = create_session_token()
        ts = now_ms()
        expires_at = ts + settings.session_ttl_seconds * 1000
        conn.execute(
            "INSERT INTO sessions (id, user_id, created_at, expires_at) VALUES (?, ?, ?, ?)",
            (token, row["id"], ts, expires_at),
        )

    clear_failed_auth(username)
    set_session_cookie(response, token)
    return row_to_user(row)


@router.post("/logout")
def logout(request: Request, response: Response) -> dict[str, bool]:
    token = request.cookies.get(settings.session_cookie_name)
    if token:
        with get_conn() as conn:
            conn.execute("DELETE FROM sessions WHERE id = ?", (token,))
    response.delete_cookie(settings.session_cookie_name, path="/")
    return {"ok": True}


@router.get("/me", response_model=UserOut)
def me(user: UserOut = Depends(require_user)) -> UserOut:
    return user


@router.get("/settings", response_model=AuthSettingsOut)
def get_public_auth_settings() -> AuthSettingsOut:
    with get_conn() as conn:
        user_count = int(conn.execute("SELECT COUNT(*) AS count FROM users").fetchone()["count"])
        auth_settings = get_auth_settings(conn)
    return auth_settings_to_out(auth_settings, user_count > 0)
