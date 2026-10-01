"""
db/session.py — engine/session factory.

DATABASE_URL is the only thing that differs between local dev and deploy —
e.g. postgresql+psycopg2://user:pass@localhost:5432/phonexa locally via
`docker-compose up postgres`, or pointed at a remote instance in deploy.
"""

from __future__ import annotations

import os

from sqlalchemy import create_engine
from sqlalchemy.orm import Session, sessionmaker

DATABASE_URL = os.environ.get(
    "DATABASE_URL", "postgresql+psycopg2://phonexa:phonexa@localhost:5432/phonexa"
)

_engine = None
_SessionLocal = None


def get_engine():
    global _engine
    if _engine is None:
        _engine = create_engine(DATABASE_URL, future=True)
    return _engine


def get_sessionmaker():
    global _SessionLocal
    if _SessionLocal is None:
        _SessionLocal = sessionmaker(bind=get_engine(), expire_on_commit=False, class_=Session)
    return _SessionLocal


def session_scope():
    """Context manager: `with session_scope() as db: ...` — commits on success, rolls back on error."""
    return _SessionScope(get_sessionmaker())


class _SessionScope:
    def __init__(self, sessionmaker_):
        self._sessionmaker = sessionmaker_
        self._session = None

    def __enter__(self) -> Session:
        self._session = self._sessionmaker()
        return self._session

    def __exit__(self, exc_type, exc_val, exc_tb):
        try:
            if exc_type is None:
                self._session.commit()
            else:
                self._session.rollback()
        finally:
            self._session.close()
        return False
