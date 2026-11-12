## Why

phonexa is the only service of the Tun ecosystem that cannot be brought up by `tun`'s unified `docker compose up`. Its own `docker-compose.yml` was written as a standalone dev stack, and it breaks under Compose's `include:` in three ways: its service names (`postgres`, `backend`, `adminer`) collide with mjolnir's `postgres` and stabbur's `backend`/`adminer` (`include:` silently keeps only the first definition, so phonexa would simply never start — the same bug D118 already fixed for smia), it publishes Postgres `5432`, Adminer `8081` and the unauthenticated app on `5050` to every interface, and it never applies its own schema (a fresh volume has no tables until someone runs `alembic upgrade head` by hand). This change makes phonexa deployable alongside the others without changing how it is developed standalone.

## What Changes

- Rename compose services to ecosystem-unique names: `phonexa-postgres`, `phonexa-backend`, and `phonexa-adminer` (moved behind a `dev` profile, so it never starts under `tun`, whose shared Adminer replaces it). Add `container_name` and `restart: unless-stopped`.
- Move the database to **Postgres 17** (`postgres:17-alpine`), matching mjolnir and stabbur and the single `postgresql-client-17` in `tun`'s backup image. The Postgres volume gets a new explicit name (`phonexa_postgres_data`) so the existing local PG 16 volume is left untouched rather than failing to start under 17.
- Give both volumes explicit `name:`s (`phonexa_postgres_data`, `phonexa_audio_data`) so the same volume is used whether phonexa runs standalone or via `tun`'s `include:` (the D-series rule every sibling already follows). `phonexa_audio_data` is the name today's local volume already resolves to, so existing local audio carries over.
- Join the backend to the `tun-shared` external network so mjolnir's Caddy can reach `phonexa-backend:5050` by name.
- Stop publishing to every interface: `5050`, Postgres and the dev Adminer bind to `127.0.0.1` only, so a `tun` deploy exposes phonexa solely through Caddy (and its auth, see the `mjolnir` change).
- Make the Postgres password env-driven (`PHONEXA_POSTGRES_PASSWORD`, default `phonexa`) and document it in a new `.env.example`, so `tun`'s backup service can use the same value.
- Container entrypoint runs `alembic upgrade head` before starting the server, so a fresh deploy gets its schema with no manual step.
- Add a backend healthcheck (`/ping`).
- README "Running it" updated for the new service names, the `dev` profile and the PG 16 → 17 local-volume note.

**Non-goals:**
- No seeding. `db-export/` import stays a manual, documented, destructive operation; the data is not available on the deploy host yet.
- No change to `/stream`, `js/realtime.js`, `/frames`, or any application code path.
- No switch away from Flask's built-in threaded server (flask-sock needs it; a production WSGI server is a separate decision).
- No auth in this repo — the operator-token gate lives in Caddy (`mjolnir` change).
- Speech-to-text and Whisper removal are the separate `stt-via-smia` change.

## Capabilities

### New Capabilities
- `tun-deployment`: how phonexa is packaged to run inside the unified Tun compose stack — service naming, networks, volumes, port exposure, schema bootstrap, database version.

### Modified Capabilities
- None.

## Impact

- `docker-compose.yml` (rewritten), `Dockerfile` (entrypoint), new `scripts/docker-entrypoint.sh`, new `.env.example`, `README.md`.
- Existing local dev: `docker compose up -d` now starts only Postgres + backend; Adminer needs `--profile dev`. The old PG 16 `phonexa_pgdata` volume is not reused — export with `scripts/export_db_to_json.py` first if it holds data worth keeping, then re-import into the new one.
- Cross-repo: `tun` includes this file and adds it to backups (`tun` change `add-phonexa-to-stack`); `mjolnir`'s Caddy routes a subdomain to it (`phonexa-site-block`).
