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

# Sample.url convention: a local file is "file://<storage_key>" (storage_key is
# always relative to AUDIO_STORAGE_ROOT); anything else (http/https) is an
# external link and is used as-is, unmirrored.
LOCAL_URL_PREFIX = "file://"


def is_local_url(url: str) -> bool:
    return url.startswith(LOCAL_URL_PREFIX)


def storage_key_from_url(url: str) -> str:
    return url[len(LOCAL_URL_PREFIX):]


def url_from_storage_key(storage_key: str) -> str:
    return LOCAL_URL_PREFIX + storage_key


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

    def delete(self, storage_key: str) -> None:
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

    def delete(self, storage_key: str) -> None:
        try:
            self._resolve(storage_key).unlink()
        except FileNotFoundError:
            pass


_store: AudioStore | None = None


def get_audio_store() -> AudioStore:
    global _store
    if _store is None:
        backend = os.environ.get("AUDIO_BACKEND", "local")
        if backend != "local":
            raise NotImplementedError(f"AUDIO_BACKEND={backend!r} not implemented yet — only 'local' exists so far")
        _store = LocalFsAudioStore()
    return _store
