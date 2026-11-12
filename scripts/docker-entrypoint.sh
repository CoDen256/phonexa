#!/usr/bin/env bash
# Container entrypoint: apply pending Alembic migrations, then start the app.
# Idempotent (a no-op once at head). `set -e` makes a failed migration abort
# the container instead of serving against a half-built schema.
set -euo pipefail

echo "[entrypoint] alembic upgrade head"
alembic upgrade head

exec "$@"
