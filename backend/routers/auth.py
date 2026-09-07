"""
Router: /api/auth
Login, logout, current user info, user management (admin only).
"""

from __future__ import annotations

from datetime import datetime, timezone
from typing import List, Optional

from fastapi import APIRouter, Depends, HTTPException, Request
from fastapi.security import HTTPAuthorizationCredentials, HTTPBearer
from pydantic import BaseModel, Field
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from services.database import User, get_db
from services.auth import (
    authenticate_user,
    create_access_token,
    create_user,
    get_current_admin,
    get_current_user,
    hash_password,
    revoke_session,
    store_session,
    verify_password,
)

_bearer = HTTPBearer(auto_error=False)

router = APIRouter()


# ── Pydantic schemas ──────────────────────────────────────────────────────────

class LoginRequest(BaseModel):
    username: str
    password: str


class TokenResponse(BaseModel):
    access_token: str
    token_type:   str = "bearer"
    user_id:      int
    username:     str
    display_name: str
    is_admin:     bool
    expires_at:   datetime


class UserOut(BaseModel):
    id:           int
    username:     str
    display_name: str
    is_admin:     bool
    is_active:    bool
    created_at:   datetime

    class Config:
        from_attributes = True


class CreateUserRequest(BaseModel):
    username:     str = Field(..., min_length=3, max_length=64)
    password:     str = Field(..., min_length=6)
    display_name: str = Field("", max_length=128)
    is_admin:     bool = False


class UpdateUserRequest(BaseModel):
    display_name: Optional[str] = Field(None, max_length=128)
    password:     Optional[str] = Field(None, min_length=6)
    is_admin:     Optional[bool] = None
    is_active:    Optional[bool] = None


class ChangePasswordRequest(BaseModel):
    current_password: str
    new_password:     str = Field(..., min_length=6)


# ── Endpoints ─────────────────────────────────────────────────────────────────

@router.post("/login", response_model=TokenResponse)
async def login(body: LoginRequest, db: AsyncSession = Depends(get_db)):
    user = await authenticate_user(db, body.username, body.password)
    token, expires_at = create_access_token(user.id, user.username)
    await store_session(db, user.id, token, expires_at)
    return TokenResponse(
        access_token=token,
        user_id=user.id,
        username=user.username,
        display_name=user.display_name,
        is_admin=user.is_admin,
        expires_at=expires_at,
    )


@router.post("/logout")
async def logout(
    credentials: Optional[HTTPAuthorizationCredentials] = Depends(_bearer),
    _:           User                                   = Depends(get_current_user),
    db:          AsyncSession                           = Depends(get_db),
):
    """Revoke the bearer token so it can't be reused."""
    if credentials:
        await revoke_session(db, credentials.credentials)
    return {"status": "logged_out"}


@router.get("/me", response_model=UserOut)
async def me(current_user: User = Depends(get_current_user)):
    return current_user


@router.put("/me/password")
async def change_my_password(
    body: ChangePasswordRequest,
    current_user: User         = Depends(get_current_user),
    db:           AsyncSession = Depends(get_db),
):
    if not verify_password(body.current_password, current_user.hashed_password):
        raise HTTPException(400, detail="رمز عبور فعلی اشتباه است.")
    current_user.hashed_password = hash_password(body.new_password)
    db.add(current_user)
    return {"status": "password_changed"}


# ── Admin: user management ────────────────────────────────────────────────────

@router.get("/users", response_model=List[UserOut])
async def list_users(
    _:  User         = Depends(get_current_admin),
    db: AsyncSession = Depends(get_db),
):
    result = await db.execute(select(User).order_by(User.id))
    return result.scalars().all()


@router.post("/users", response_model=UserOut, status_code=201)
async def admin_create_user(
    body: CreateUserRequest,
    _:    User         = Depends(get_current_admin),
    db:   AsyncSession = Depends(get_db),
):
    return await create_user(
        db,
        username=body.username,
        password=body.password,
        display_name=body.display_name or body.username,
        is_admin=body.is_admin,
    )


@router.get("/users/{user_id}", response_model=UserOut)
async def admin_get_user(
    user_id: int,
    _:       User         = Depends(get_current_admin),
    db:      AsyncSession = Depends(get_db),
):
    result = await db.execute(select(User).where(User.id == user_id))
    user   = result.scalar_one_or_none()
    if not user:
        raise HTTPException(404, detail="کاربر یافت نشد.")
    return user


@router.patch("/users/{user_id}", response_model=UserOut)
async def admin_update_user(
    user_id: int,
    body:    UpdateUserRequest,
    admin:   User         = Depends(get_current_admin),
    db:      AsyncSession = Depends(get_db),
):
    result = await db.execute(select(User).where(User.id == user_id))
    user   = result.scalar_one_or_none()
    if not user:
        raise HTTPException(404, detail="کاربر یافت نشد.")
    # Prevent admin from demoting themselves if they're the only admin
    if body.is_admin is False and user.id == admin.id:
        raise HTTPException(400, detail="نمی‌توان دسترسی مدیر خود را حذف کرد.")
    if body.display_name is not None:
        user.display_name = body.display_name
    if body.password is not None:
        user.hashed_password = hash_password(body.password)
    if body.is_admin is not None:
        user.is_admin = body.is_admin
    if body.is_active is not None:
        user.is_active = body.is_active
    db.add(user)
    return user


@router.delete("/users/{user_id}", status_code=204)
async def admin_delete_user(
    user_id: int,
    admin:   User         = Depends(get_current_admin),
    db:      AsyncSession = Depends(get_db),
):
    if user_id == admin.id:
        raise HTTPException(400, detail="نمی‌توان حساب خود را حذف کرد.")
    result = await db.execute(select(User).where(User.id == user_id))
    user   = result.scalar_one_or_none()
    if not user:
        raise HTTPException(404, detail="کاربر یافت نشد.")
    await db.delete(user)
