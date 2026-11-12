## 1. Compose rewrite

- [ ] 1.1 Rename services to `phonexa-postgres` / `phonexa-backend`; set `container_name` and `restart: unless-stopped`
- [ ] 1.2 Switch the database image to `postgres:17-alpine`; drive its password from `PHONEXA_POSTGRES_PASSWORD` (default `phonexa`) and use it in the backend's `DATABASE_URL`
- [ ] 1.3 Move Adminer to `phonexa-adminer` under `profiles: ["dev"]`, bound to `127.0.0.1:8081`
- [ ] 1.4 Bind published ports to loopback (`127.0.0.1:5050`, `127.0.0.1:5432`); grep `mjolnir`, `stabbur`, `smia` compose files for a host-port collision on 5432 and move to 5434 if one exists
- [ ] 1.5 Declare volumes with unique keys (`phonexa-postgres-data`, `phonexa-audio-data` — `include:` merges volume keys too, and `tun`'s backup service references `phonexa-audio-data` directly) and explicit names `phonexa_postgres_data` / `phonexa_audio_data`
- [ ] 1.6 Join the backend to `tun-shared` (`external: true`) alongside `default`, with the same explanatory comment style as smia's compose file
- [ ] 1.7 Add a backend healthcheck using python/urllib against `/ping`

## 2. Schema bootstrap

- [ ] 2.1 Add `scripts/docker-entrypoint.sh` (`alembic upgrade head`, then `exec python formanter.py`), executable, `set -euo pipefail`
- [ ] 2.2 Update the `Dockerfile` to copy it and use it as the entrypoint (scripts/ is already copied)
- [ ] 2.3 Confirm `alembic/env.py` picks up `DATABASE_URL` from the container environment (it imports `db.session.DATABASE_URL`)

## 3. Docs and config

- [ ] 3.1 Add `.env.example` documenting `PHONEXA_POSTGRES_PASSWORD`
- [ ] 3.2 Update `README.md` "Running it": new service names, `--profile dev` for Adminer, automatic migrations, the PG 16 → 17 local-volume note with the export → import steps
- [ ] 3.3 Note in the README that seeding is manual (`scripts/import_db_from_json.py`, destructive) and not part of start-up

## 4. Verification

- [ ] 4.1 `docker compose config` standalone is valid; `docker compose --profile dev config` includes `phonexa-adminer`, the default does not
- [ ] 4.2 Fresh `docker compose up -d`: tables exist (`\dt` in `phonexa-postgres`), `/ping` returns 200, healthcheck goes healthy
- [ ] 4.3 Restart the backend: migrations are a no-op, no data loss
- [ ] 4.4 Include the file from a scratch parent compose together with a stub of the sibling service names: no collision, all services present
- [ ] 4.5 `ss -ltn` / `docker compose port` shows 5050/5432 only on `127.0.0.1`
- [ ] 4.6 `/stream` still connects from the browser mic tracker; `git diff --stat -- js/realtime.js formanter.py` is empty
- [ ] 4.7 Existing local `phonexa_audio_data` volume is picked up by the new compose file (a previously saved sample still plays)
