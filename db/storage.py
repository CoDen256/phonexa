"""
db/storage.py — audio byte storage, abstracted behind a tiny interface so the
DB only ever holds a `storage_key` (never a host path), and swapping the
backend (e.g. to S3-compatible object storage later) needs no caller changes.

AUDIO_STORAGE_ROOT is the one thing that differs between local dev and
deploy: a Docker named volume mounted at a fixed container path, never a
literal path on anyone's actual machine.
"""

from __future__ import annotations

import os
import shutil
from pathlib import Path


class AudioStore:
    def put_path(self, src_path: str, suggested_key: str) -> str:
        raise NotImplementedError

    def put_bytes(self, data: bytes, suggested_key: str) -> str:
        raise NotImplementedError

    def get_path(self, storage_key: str) -> str:
        """Returns an absolute filesystem path to the bytes — only valid for local-fs-backed stores."""
        raise NotImplementedError

    def exists(self, storage_key: str) -> bool:
        raise NotImplementedError


class LocalFsAudioStore(AudioStore):
    def __init__(self, root: str | None = None):
        self.root = Path(root or os.environ.get("AUDIO_STORAGE_ROOT", "./data/audio")).resolve()
        self.root.mkdir(parents=True, exist_ok=True)

    def _resolve(self, storage_key: str) -> Path:
        # storage_key is always relative — never let a caller-supplied key escape the root.
        full = (self.root / storage_key).resolve()
        if self.root not in full.parents and full != self.root:
            raise ValueError(f"storage_key escapes audio root: {storage_key!r}")
        return full

    def put_path(self, src_path: str, suggested_key: str) -> str:
        dest = self._resolve(suggested_key)
        dest.parent.mkdir(parents=True, exist_ok=True)
        shutil.copyfile(src_path, dest)
        return suggested_key

    def put_bytes(self, data: bytes, suggested_key: str) -> str:
        dest = self._resolve(suggested_key)
        dest.parent.mkdir(parents=True, exist_ok=True)
        dest.write_bytes(data)
        return suggested_key

    def get_path(self, storage_key: str) -> str:
        return str(self._resolve(storage_key))

    def exists(self, storage_key: str) -> bool:
        return self._resolve(storage_key).exists()


_store: AudioStore | None = None


def get_audio_store() -> AudioStore:
    global _store
    if _store is None:
        backend = os.environ.get("AUDIO_BACKEND", "local")
        if backend != "local":
            raise NotImplementedError(f"AUDIO_BACKEND={backend!r} not implemented yet — only 'local' exists so far")
        _store = LocalFsAudioStore()
    return _store
