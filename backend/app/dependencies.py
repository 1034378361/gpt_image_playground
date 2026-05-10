from __future__ import annotations

from fastapi import Depends, HTTPException, Request, Response

from .config import settings
from .db import get_conn
from .helpers import row_to_user
from .schemas import UserOut
from .security import now_ms
from .state import LOGIN_ATTEMPTS


def require_user(request: Request) -> UserOut:
    token = request.cookies.get(settings.session_cookie_name)
    if not token:
        raise HTTPException(status_code=401, detail="Not authenticated")

    ts = now_ms()
    with get_conn() as conn:
        row = conn.execute(
            """
            SELECT users.* FROM sessions
            JOIN users ON users.id = sessions.user_id
            WHERE sessions.id = ? AND (sessions.expires_at IS NULL OR sessions.expires_at > ?)
            """,
            (token, ts),
        ).fetchone()
    if not row:
        raise HTTPException(status_code=401, detail="Not authenticated")
    return row_to_user(row)


def require_admin(user: UserOut = Depends(require_user)) -> UserOut:
    if user.role != "admin":
        raise HTTPException(status_code=403, detail="Admin privileges required")
    return user


def can_manage_template_library(user: UserOut) -> bool:
    return user.role in {"admin", "reviewer"}


def require_template_operator(user: UserOut = Depends(require_user)) -> UserOut:
    if not can_manage_template_library(user):
        raise HTTPException(status_code=403, detail="Template review privileges required")
    return user


def set_session_cookie(response: Response, token: str) -> None:
    response.set_cookie(
        settings.session_cookie_name,
        token,
        httponly=True,
        secure=settings.session_secure,
        samesite="lax",
        max_age=settings.session_ttl_seconds,
        path="/",
    )


def assert_auth_not_rate_limited(username: str) -> None:
    key = username.lower()
    window_ms = 15 * 60 * 1000
    now = now_ms()
    attempts = LOGIN_ATTEMPTS[key]
    while attempts and attempts[0] < now - window_ms:
        attempts.popleft()
    if len(attempts) >= 8:
        raise HTTPException(status_code=429, detail="Too many login attempts, please try again later")


def record_failed_auth(username: str) -> None:
    LOGIN_ATTEMPTS[username.lower()].append(now_ms())


def clear_failed_auth(username: str) -> None:
    LOGIN_ATTEMPTS.pop(username.lower(), None)
