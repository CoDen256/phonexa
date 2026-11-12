## ADDED Requirements

### Requirement: Compose service names are unique within the Tun ecosystem
phonexa's compose file SHALL name its services so that none collides with a service name in `mjolnir`'s, `stabbur`'s or `smia`'s compose files: the database as `phonexa-postgres`, the application as `phonexa-backend`, and any development-only database browser as `phonexa-adminer`.

#### Scenario: Included alongside the other stacks
- **WHEN** `tun`'s compose file includes phonexa's compose file together with mjolnir's, stabbur's and smia's
- **THEN** every phonexa service is present in the merged project and none of mjolnir's, stabbur's or smia's services is shadowed or dropped

### Requirement: The development database browser never starts under the unified stack
phonexa's own Adminer SHALL be gated behind a `dev` compose profile so it does not start unless that profile is explicitly enabled.

#### Scenario: Unified deploy
- **WHEN** `docker compose up` runs in `tun` without enabling any profile
- **THEN** no `phonexa-adminer` container is created

#### Scenario: Standalone development
- **WHEN** a developer runs `docker compose --profile dev up -d` in phonexa's repository
- **THEN** `phonexa-adminer` starts and is reachable on loopback only

### Requirement: Persistent state uses explicitly named volumes
phonexa SHALL declare its database and audio volumes with explicit `name:`s (`phonexa_postgres_data`, `phonexa_audio_data`) so the same volumes are used whether phonexa is started standalone or through `tun`.

#### Scenario: Switching entry points
- **WHEN** phonexa is started once from its own repository and later through `tun`'s compose file
- **THEN** both runs read and write the same database and audio volumes

### Requirement: The database runs Postgres 17
`phonexa-postgres` SHALL run Postgres major version 17, matching the other Tun databases and the backup service's single client version.

#### Scenario: Backing up
- **WHEN** `tun`'s backup service dumps `phonexa-postgres` with `pg_dump` 17
- **THEN** the dump succeeds without a client/server version mismatch

### Requirement: The backend is reachable by the reverse proxy and not publicly published
`phonexa-backend` SHALL join the `tun-shared` network so the reverse proxy can reach it by service name, and SHALL publish its host ports on the loopback interface only.

#### Scenario: Reverse proxy reachability
- **WHEN** mjolnir's Caddy proxies to `phonexa-backend:5050`
- **THEN** the name resolves and the request reaches the application, including WebSocket upgrades on `/stream`

#### Scenario: Public interface exposure
- **WHEN** phonexa runs on a host with a public network interface
- **THEN** the application port, the database port and any development Adminer port are not reachable on that interface

### Requirement: The database schema is applied automatically on start
The `phonexa-backend` container SHALL apply all pending Alembic migrations before it begins serving requests, and SHALL fail to start if a migration fails.

#### Scenario: Fresh volume
- **WHEN** `phonexa-backend` starts against an empty `phonexa-postgres` database
- **THEN** all tables exist by the time the application accepts its first request, with no manual step

#### Scenario: Already migrated
- **WHEN** `phonexa-backend` restarts against a database already at the latest revision
- **THEN** the migration step makes no changes and the application starts normally

#### Scenario: Failing migration
- **WHEN** a migration raises an error
- **THEN** the container exits non-zero and does not serve requests

### Requirement: No data is seeded automatically
Starting phonexa SHALL NOT import `db-export/` or any other data into the database; importing remains an explicit manual operation.

#### Scenario: First boot
- **WHEN** phonexa starts for the first time
- **THEN** the database contains the schema and no languages, samples, vowels or tokens

### Requirement: The database password is configurable
The Postgres password SHALL be supplied through `PHONEXA_POSTGRES_PASSWORD` (with a development default), used consistently by the database and the backend's connection string.

#### Scenario: Overriding the password
- **WHEN** `PHONEXA_POSTGRES_PASSWORD` is set before first boot
- **THEN** both the database and the backend use that password
