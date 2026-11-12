## Context

`tun/compose.yaml` uses Compose `include:` to merge `mjolnir`'s, `stabbur`'s and `smia`'s compose files into one project. Three facts from those repos drive this change:

- `include:` merges service names into one namespace and **silently keeps only the first definition** of a colliding name (D94, D118). phonexa's `postgres`, `backend` and `adminer` collide with mjolnir's and stabbur's.
- Every sibling already sets explicit volume `name:`s (otherwise `cd x && up` and `tun`'s `include:` create two different volumes and data "disappears" between entry points) and joins the external `tun-shared` network.
- The `tun` backup service installs exactly one client, `postgresql-client-17`, and `pg_dump` 17 is what makes mixed 16/17 work at all; mjolnir and stabbur are already on 17.

phonexa today: Flask + flask-sock on `:5050`, `DATABASE_URL`/`AUDIO_STORAGE_ROOT`/`AUDIO_BACKEND` from env, Alembic `env.py` reads `db.session.DATABASE_URL`, `/ping` exists, audio under `/data/audio` keyed like `lang/<lang>/ingested/<name>.wav` (nested, arbitrary filenames). `./db-export` is bind-mounted so admin export/import endpoints touch the git-tracked directory.

## Goals / Non-Goals

**Goals:**
- `docker compose up` in `tun` starts phonexa with a migrated, empty schema and no manual step.
- phonexa still runs standalone from its own repo, with its own dev conveniences.
- A `tun` deploy exposes phonexa only through Caddy.

**Non-Goals:** seeding, application code changes, a production WSGI server, auth (see proposal).

## Decisions

### 1. Names: `phonexa-postgres`, `phonexa-backend`, `phonexa-adminer` (profile `dev`)
Same convention as smia (`smia-postgres`/`smia-backend`). `container_name` set equal to the service name. Adminer is **not removed**: standalone dev still wants one, but under `tun` the shared Adminer (login server `phonexa-postgres`) replaces it, so it moves behind `profiles: ["dev"]`. Profile-gated services are skipped by `include:` unless the profile is enabled, so it can't collide or start on the VPS. *Alternative considered:* delete it outright — rejected, it would silently remove a dev tool for no gain.

### 2. Postgres 17, new volume name rather than reusing `pgdata`
`postgres:17-alpine`. A PG 16 data directory cannot be started by a 17 image, so reusing the old volume name would give a confusing crash loop. Using a **new** name (`phonexa_postgres_data`) leaves the old `phonexa_pgdata` volume untouched (nothing destroyed) and the supported path is dump → new volume → import, using the existing JSON export/import scripts, which already cover users, settings and shadowing. Nothing is deployed anywhere yet, so no `pg_upgrade` is needed.

### 3. Audio volume keeps its existing resolved name; volume keys are prefixed
`name: phonexa_audio_data` — exactly what `docker compose` in directory `phonexa` already produces for `audio_data`, so existing local audio is picked up with no migration. The compose **key** is renamed to `phonexa-audio-data` (and `phonexa-postgres-data`): `include:` merges top-level volume keys across files just like service names, so generic keys such as `audio_data` could collide with a sibling, and `tun`'s backup service references this volume by its key. `tun` mounts it read-only into the backup service.

### 4. Ports bound to loopback, not removed
`127.0.0.1:5050:5050`, `127.0.0.1:5432:5432`, `127.0.0.1:8081:8080`. Standalone dev (native nix-shell app connecting in, browser at `localhost:5050`) is unchanged; a VPS deploy no longer exposes an unauthenticated app or DB on a public interface. Caddy reaches the backend over `tun-shared` by name, not via a published port. Under `tun`, the 5432 publish may collide with another stack's — the tasks include checking sibling composes (smia publishes 5433); if one collides, the DB publish moves to 5434.

### 5. Schema bootstrap in an entrypoint script, not in app startup
`scripts/docker-entrypoint.sh`: `alembic upgrade head && exec python formanter.py`. Alembic is idempotent (no-op once at head), runs before any request, and keeps `formanter.py` (frozen in parts) untouched. `depends_on: phonexa-postgres: condition: service_healthy` already guarantees the DB is accepting connections. A failed migration aborts the container instead of serving against a half-built schema.

### 6. Password env-driven with a default
`PHONEXA_POSTGRES_PASSWORD` (default `phonexa`) feeds both Postgres and the backend's `DATABASE_URL`. `tun`'s backup service needs the same value (it connects over the network, never `docker exec`); `tun/.env.example` documents it next to `STABBUR_POSTGRES_PASSWORD`. Same drift risk stabbur already has; accepted and documented. The DB is on the project's internal network and published to loopback only, so a default is tolerable; a real deploy overrides it.

### 7. Healthcheck via python, not curl
`python:3.12-slim` has no `curl`; the check is `python -c "import urllib.request; urllib.request.urlopen('http://localhost:5050/ping')"`. Lets `tun` (and Caddy-dependent services) gate on `service_healthy`.

## Risks / Trade-offs

- **Local dev regression (PG 16 → 17 volume).** → Documented in README; old volume preserved; export/import path exists.
- **`./db-export` bind mount under `include:`.** Relative paths resolve against the included file's directory, so this should still work; verified in tasks rather than assumed. On a deploy host the directory is the git checkout's, which is intended (admin import/export read it).
- **Adminer profile surprises.** `docker compose up -d` no longer starts Adminer. → README states `--profile dev`.
- **Migrations on every start** adds a second or two to boot and makes a bad migration fatal. Accepted; failing loudly beats serving a broken schema.

## Migration Plan

1. Land this change; nothing is deployed, so there is no rollback state.
2. Local dev with data: `scripts/export_db_to_json.py` on the old stack → bring up the new stack → `scripts/import_db_from_json.py`.
3. Rollback: revert the compose file; old `phonexa_pgdata` volume is still there.

## Open Questions

- Whether any sibling already publishes host port 5432 (checked during implementation).
