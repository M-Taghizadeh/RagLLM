"""
Database service — async SQLAlchemy with PostgreSQL.

Tables:
  users           — کاربران (admin flag, username, hashed_password)
  sessions        — JWT session tokens (24h expiry)
  collections     — مجموعه‌های اسناد per-user
  chat_history    — تاریخچه گفتگو روی اسناد
  uploaded_files  — فایل‌های آپلودشده per-collection
"""

from __future__ import annotations

import os
from datetime import datetime, timezone
from typing import AsyncGenerator

from sqlalchemy import (
    Boolean, DateTime, ForeignKey, Integer, String, Text,
    UniqueConstraint, func, text,
)
from sqlalchemy.ext.asyncio import (
    AsyncSession, async_sessionmaker, create_async_engine,
)
from sqlalchemy.orm import DeclarativeBase, Mapped, mapped_column, relationship

# ── Engine ────────────────────────────────────────────────────────────────────

DATABASE_URL = os.environ.get(
    "DATABASE_URL",
    "postgresql+asyncpg://ragbot:ragbot_secret@localhost:5432/ragbot",
)

engine = create_async_engine(
    DATABASE_URL,
    echo=False,
    pool_pre_ping=True,
    pool_size=10,
    max_overflow=20,
)

AsyncSessionLocal = async_sessionmaker(
    bind=engine,
    class_=AsyncSession,
    expire_on_commit=False,
    autoflush=False,
    autocommit=False,
)


async def get_db() -> AsyncGenerator[AsyncSession, None]:
    """FastAPI dependency — yields an async DB session."""
    async with AsyncSessionLocal() as session:
        try:
            yield session
            await session.commit()
        except Exception:
            await session.rollback()
            raise


# ── ORM Models ────────────────────────────────────────────────────────────────

class Base(DeclarativeBase):
    pass


class User(Base):
    __tablename__ = "users"

    id:             Mapped[int]      = mapped_column(Integer, primary_key=True, autoincrement=True)
    username:       Mapped[str]      = mapped_column(String(64), unique=True, nullable=False, index=True)
    hashed_password:Mapped[str]      = mapped_column(String(256), nullable=False)
    display_name:   Mapped[str]      = mapped_column(String(128), nullable=False, default="")
    is_admin:       Mapped[bool]     = mapped_column(Boolean, default=False, nullable=False)
    is_active:      Mapped[bool]     = mapped_column(Boolean, default=True,  nullable=False)
    created_at:     Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), nullable=False
    )

    sessions:     Mapped[list["Session"]]     = relationship("Session",      back_populates="user", cascade="all, delete-orphan")
    collections:  Mapped[list["Collection"]]  = relationship("Collection",   back_populates="user", cascade="all, delete-orphan")
    chat_history: Mapped[list["ChatHistory"]] = relationship("ChatHistory",  back_populates="user", cascade="all, delete-orphan")


class Session(Base):
    __tablename__ = "sessions"

    id:         Mapped[int]      = mapped_column(Integer, primary_key=True, autoincrement=True)
    user_id:    Mapped[int]      = mapped_column(ForeignKey("users.id", ondelete="CASCADE"), nullable=False, index=True)
    token:      Mapped[str]      = mapped_column(String(512), unique=True, nullable=False, index=True)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now(), nullable=False)
    expires_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False)
    revoked:    Mapped[bool]     = mapped_column(Boolean, default=False, nullable=False)

    user: Mapped["User"] = relationship("User", back_populates="sessions")


class Collection(Base):
    """
    Tracks a per-user FAISS collection.
    folder_id  = sanitized folder name (e.g. "my_docs_a1b2c3")
    The actual FAISS index lives at:  faiss_db/{user_id}/{folder_id}/
    """
    __tablename__ = "collections"
    __table_args__ = (
        UniqueConstraint("user_id", "folder_id", name="uq_user_folder"),
    )

    id:           Mapped[int]      = mapped_column(Integer, primary_key=True, autoincrement=True)
    user_id:      Mapped[int]      = mapped_column(ForeignKey("users.id", ondelete="CASCADE"), nullable=False, index=True)
    folder_id:    Mapped[str]      = mapped_column(String(128), nullable=False)
    display_name: Mapped[str]      = mapped_column(String(256), nullable=False)
    created_at:   Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now(), nullable=False)
    updated_at:   Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), onupdate=func.now(), nullable=False
    )

    user:           Mapped["User"]               = relationship("User",         back_populates="collections")
    chat_history:   Mapped[list["ChatHistory"]]  = relationship("ChatHistory",  back_populates="collection", cascade="all, delete-orphan")
    uploaded_files: Mapped[list["UploadedFile"]] = relationship("UploadedFile", back_populates="collection", cascade="all, delete-orphan")


class ChatHistory(Base):
    """One row per complete Q&A turn (user question + assistant answer)."""
    __tablename__ = "chat_history"

    id:            Mapped[int]      = mapped_column(Integer, primary_key=True, autoincrement=True)
    user_id:       Mapped[int]      = mapped_column(ForeignKey("users.id", ondelete="CASCADE"), nullable=False, index=True)
    collection_id: Mapped[int]      = mapped_column(ForeignKey("collections.id", ondelete="CASCADE"), nullable=False, index=True)
    session_key:   Mapped[str]      = mapped_column(String(128), nullable=False, index=True)
    role:          Mapped[str]      = mapped_column(String(16),  nullable=False)   # "user" | "assistant"
    content:       Mapped[str]      = mapped_column(Text,        nullable=False)
    sources:       Mapped[str]      = mapped_column(Text,        nullable=True)    # JSON string
    created_at:    Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now(), nullable=False)

    user:       Mapped["User"]       = relationship("User",       back_populates="chat_history")
    collection: Mapped["Collection"] = relationship("Collection", back_populates="chat_history")


class UploadedFile(Base):
    """Original file bytes stored on disk; this row tracks metadata."""
    __tablename__ = "uploaded_files"
    __table_args__ = (
        UniqueConstraint("collection_id", "filename", name="uq_col_filename"),
    )

    id:            Mapped[int]      = mapped_column(Integer, primary_key=True, autoincrement=True)
    collection_id: Mapped[int]      = mapped_column(ForeignKey("collections.id", ondelete="CASCADE"), nullable=False, index=True)
    user_id:       Mapped[int]      = mapped_column(ForeignKey("users.id",        ondelete="CASCADE"), nullable=False, index=True)
    filename:      Mapped[str]      = mapped_column(String(256), nullable=False)
    file_type:     Mapped[str]      = mapped_column(String(16),  nullable=False)   # "pdf" | "word"
    file_size:     Mapped[int]      = mapped_column(Integer,     nullable=True)    # bytes
    storage_path:  Mapped[str]      = mapped_column(String(512), nullable=False)   # abs path on disk
    created_at:    Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now(), nullable=False)

    collection: Mapped["Collection"] = relationship("Collection", back_populates="uploaded_files")


# ── Schema creation ───────────────────────────────────────────────────────────

async def init_db() -> None:
    """Create all tables if they don't exist.  Call once on app startup."""
    async with engine.begin() as conn:
        await conn.execute(text("CREATE EXTENSION IF NOT EXISTS pgcrypto"))
        await conn.run_sync(Base.metadata.create_all)
