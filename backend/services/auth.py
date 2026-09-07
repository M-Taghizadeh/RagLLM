"""
Auth service — JWT tokens, password hashing, current-user dependency.

Token flow:
  POST /api/auth/login  →  {access_token, token_type}
  Header: Authorization: Bearer <token>
  Token valid 24 hours; stored in sessions table for revocation support.
"""

from __future__ import annotations

import os
import secrets
from datetime import datetime, timedelta, timezone
from typing import Optional

import bcrypt
import jwt
from fastapi import Depends, HTTPException, status
from fastapi.security import HTTPAuthorizationCredentials, HTTPBearer
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from services.database import AsyncSessionLocal, Session, User, get_db

# ── Config ────────────────────────────────────────────────────────────────────

JWT_SECRET    = os.environ.get("JWT_SECRET", "change_this_secret_in_production")
JWT_ALGORITHM = "HS256"
TOKEN_TTL_H   = int(os.environ.get("TOKEN_TTL_HOURS", "24"))

ADMIN_USERNAME = os.environ.get("ADMIN_USERNAME", "admin")
ADMIN_PASSWORD = os.environ.get("ADMIN_PASSWORD", "admin123")

_bearer = HTTPBearer(auto_error=False)

# ── Password helpers ──────────────────────────────────────────────────────────

def hash_password(plain: str) -> str:
    return bcrypt.hashpw(plain.encode(), bcrypt.gensalt(rounds=12)).decode()


def verify_password(plain: str, hashed: str) -> bool:
    try:
        return bcrypt.checkpw(plain.encode(), hashed.encode())
    except Exception:
        return False


# ── JWT helpers ───────────────────────────────────────────────────────────────

def _now() -> datetime:
    return datetime.now(timezone.utc)


def create_access_token(user_id: int, username: str) -> tuple[str, datetime]:
    """Return (token_string, expires_at)."""
    expires_at = _now() + timedelta(hours=TOKEN_TTL_H)
    payload = {
        "sub":      str(user_id),
        "username": username,
        "exp":      expires_at,
        "iat":      _now(),
        "jti":      secrets.token_hex(16),
    }
    token = jwt.encode(payload, JWT_SECRET, algorithm=JWT_ALGORITHM)
    return token, expires_at


def _decode_token(token: str) -> dict:
    try:
        return jwt.decode(token, JWT_SECRET, algorithms=[JWT_ALGORITHM])
    except jwt.ExpiredSignatureError:
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="توکن منقضی شده است.")
    except jwt.InvalidTokenError:
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="توکن نامعتبر است.")


# ── DB helpers ────────────────────────────────────────────────────────────────

async def get_user_by_username(db: AsyncSession, username: str) -> Optional[User]:
    result = await db.execute(select(User).where(User.username == username))
    return result.scalar_one_or_none()


async def get_user_by_id(db: AsyncSession, user_id: int) -> Optional[User]:
    result = await db.execute(select(User).where(User.id == user_id))
    return result.scalar_one_or_none()


async def create_user(
    db: AsyncSession,
    username: str,
    password: str,
    display_name: str = "",
    is_admin: bool = False,
) -> User:
    existing = await get_user_by_username(db, username)
    if existing:
        raise HTTPException(status_code=400, detail=f"نام کاربری '{username}' قبلاً ثبت شده است.")
    user = User(
        username=username,
        hashed_password=hash_password(password),
        display_name=display_name or username,
        is_admin=is_admin,
        is_active=True,
    )
    db.add(user)
    await db.flush()
    await db.refresh(user)
    return user


async def authenticate_user(db: AsyncSession, username: str, password: str) -> User:
    user = await get_user_by_username(db, username)
    if not user or not user.is_active:
        raise HTTPException(status_code=401, detail="نام کاربری یا رمز عبور اشتباه است.")
    if not verify_password(password, user.hashed_password):
        raise HTTPException(status_code=401, detail="نام کاربری یا رمز عبور اشتباه است.")
    return user


async def store_session(db: AsyncSession, user_id: int, token: str, expires_at: datetime) -> None:
    sess = Session(user_id=user_id, token=token, expires_at=expires_at)
    db.add(sess)
    await db.flush()


async def revoke_session(db: AsyncSession, token: str) -> None:
    result = await db.execute(select(Session).where(Session.token == token))
    sess = result.scalar_one_or_none()
    if sess:
        sess.revoked = True
        await db.flush()


async def is_session_valid(db: AsyncSession, token: str) -> bool:
    result = await db.execute(
        select(Session).where(
            Session.token    == token,
            Session.revoked  == False,            # noqa: E712
            Session.expires_at > _now(),
        )
    )
    return result.scalar_one_or_none() is not None


# ── FastAPI dependency — get current user ────────────────────────────────────

async def get_current_user(
    credentials: Optional[HTTPAuthorizationCredentials] = Depends(_bearer),
    db: AsyncSession = Depends(get_db),
) -> User:
    if not credentials:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="احراز هویت الزامی است.",
            headers={"WWW-Authenticate": "Bearer"},
        )
    token = credentials.credentials
    payload = _decode_token(token)

    if not await is_session_valid(db, token):
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="نشست نامعتبر یا منقضی شده است.")

    user_id = int(payload["sub"])
    user = await get_user_by_id(db, user_id)
    if not user or not user.is_active:
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="کاربر یافت نشد یا غیرفعال است.")
    return user


async def get_current_admin(current_user: User = Depends(get_current_user)) -> User:
    if not current_user.is_admin:
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="دسترسی فقط برای مدیر.")
    return current_user


# ── Bootstrap admin on startup ────────────────────────────────────────────────

async def ensure_admin_exists() -> None:
    """
    Create the default admin account if it doesn't exist yet.
    Called once from main.py lifespan startup.
    """
    async with AsyncSessionLocal() as db:
        try:
            existing = await get_user_by_username(db, ADMIN_USERNAME)
            if not existing:
                user = User(
                    username=ADMIN_USERNAME,
                    hashed_password=hash_password(ADMIN_PASSWORD),
                    display_name="مدیر سیستم",
                    is_admin=True,
                    is_active=True,
                )
                db.add(user)
                await db.commit()
                print(f"[auth] Admin user '{ADMIN_USERNAME}' created.")
            else:
                print(f"[auth] Admin user '{ADMIN_USERNAME}' already exists.")
        except Exception as ex:
            await db.rollback()
            print(f"[auth] Warning: could not ensure admin exists: {ex}")
