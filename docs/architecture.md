# Dockyard architecture

How the panel is put together, read from the source tree at the version this document
was written against (root `package.json` version 0.9.0). Every claim below is grounded
in a file in the repository; file:line references point at the code that carries it.

Dockyard is a Docker control panel. A single Node process (the "panel") serves a JSON API
and WebSocket streams under `/api` and `/ws`, serves the built React frontend from
`web/dist`, and talks to the Docker Engine over the Docker socket using the `dockerode`
library. State lives in Postgres, accessed through Drizzle ORM with hand-written SQL via
`pg`. There is no Docker CLI invocation and no shelling out to `docker`.

## Repository layout

The root is an npm workspace (`package.json:6-9`) with two workspaces, `server` and `web`.

```
dockyard/
  package.json            workspace root: scripts, engines (node >=22)
  Dockerfile              multi-stage image build
  docker-compose.yml      db + panel, optional nginx proxy profile
  install.sh              host installer (not read in detail for this document)
  CONTRACT.md             frozen API contract, referenced by comments throughout
  server/
    package.json          @dockyard/server: fastify, dockerode, drizzle-orm, pg, zod, localtunnel, yaml
    tsconfig.json         noEmit, erasableSyntaxOnly, allowImportingTsExtensions
    drizzle/
      0000_init.sql       the single generated migration
      meta/_journal.json  Drizzle's journal (one entry, tag 0000_init)
    src/
      index.ts            process entry point and boot sequence
      app.ts              Fastify assembly
      config.ts           config object, .env loading, repo-root discovery
      logger.ts           structured JSON logger + redact()
      events.ts           in-process event bus
      secrets.ts          AES-256-GCM secret encrypt/decrypt/mask
      version.ts          build info (version, commit, build time)
      stacks.ts           stack lifecycle + container grouping
      auth/               sessions, password hashing, roles, scoping, audit
      cloudflare/         Cloudflare API v4 client
      db/                 pool, Drizzle schema, migration runner
      docker/             dockerode client + container/image/volume/network/stats services
      routes/             REST route plugins
      templates/          template schema, file source, remote source, deploy engine
      tunnels/            tunnel manager, cloudflared supervisor, per-mode starters
      update/             GitHub update check + host-updater file spool
      ws/                 WebSocket route plugins (logs, stats, events)
  web/
    package.json          @dockyard/web: react 19, react-router-dom 7, vite, vitest
    vite.config.ts        dev server on 5190, proxies /api and /ws to :8000
    index.html            Vite entry, mounts /src/main.tsx
    dist/                 build output served by the API in production
    src/                  React app (pages, components, hooks, api client, lib)
  deploy/                 host-side updater, nginx templates, template examples
  scripts/                dev/e2e helpers
```

## Boot sequence

The process entry point is `server/src/index.ts`. `main()` runs these steps in order
(`index.ts:62-82`):

1. `loadEnvFile()` (`index.ts:63`). Reads `<repoRoot>/.env` and copies keys into
   `process.env` without overwriting variables already present (`config.ts:94-119`).
   `config.ts` also calls `loadEnvFile()` at module load (`config.ts:233`), so by the time
   `main()` runs the config object already exists. The call is idempotent.
2. `runMigrations()` (`index.ts:65`). Applies any unapplied Drizzle migration and returns
   `{ applied, already }`. See "Migrations" below.
3. `ensureFirstBootAdmin()` (`index.ts:69`, body at `index.ts:21-32`). When both
   `DOCKYARD_ADMIN_EMAIL` and `DOCKYARD_ADMIN_PASSWORD` are set and the `users` table is
   empty, it inserts one admin row with a scrypt password hash. The password is never
   logged.
4. `pruneExpiredSessions()` (`index.ts:70`). Deletes `sessions` rows whose `expires_at`
   has passed (`auth/sessions.ts:117-120`). Failure is swallowed.
5. `buildApp()` (`index.ts:72`). Builds and returns the configured Fastify instance. See
   "Fastify assembly" below.
6. `app.listen({ port, host })` (`index.ts:73`), using `config.port` (default 8000) and
   `config.host` (default 0.0.0.0). A startup log line records whether Docker is being
   reached over the local socket or a remote host (`index.ts:74-80`).
7. `initTunnels()` (`index.ts:82`, body at `index.ts:34-47`). Dynamically imports
   `./tunnels/manager.ts` and, if present, calls `tunnelManager.init()`, which reconciles
   stale tunnel rows and auto-starts tunnels marked `auto_start` (see "Tunnel supervision").
   A missing module is logged as a warning, not fatal.

`main()` is invoked at module load (`index.ts:116`); a rejected promise sets
`process.exitCode = 1` and logs a fatal boot error.

Shutdown: `SIGINT` and `SIGTERM` both call `shutdown()` (`index.ts:104-105`). It guards
against re-entry, calls `app.close()` (stops accepting connections and closes WebSocket
clients), then `shutdownTunnels()`, then `closePool()`, then `process.exit(0)`
(`index.ts:84-102`). `unhandledRejection` and `uncaughtException` are logged and do not
terminate the process (`index.ts:108-113`).

Repo-root discovery walks up from `config.ts` until it finds a directory containing
`CONTRACT.md`, falling back to two levels up (`config.ts:79-91`). `repoRoot` is exported
and used to locate `web/dist` and `.env`.

## Fastify assembly

`buildApp()` in `server/src/app.ts` wires the whole HTTP surface.

- The Fastify instance is created with `logger: false`, `trustProxy: true`, and a 1 MiB
  body limit (`app.ts:97-101`). Logging is done by the app's own `logger.ts`, not Fastify.
- Request-scoped auth state is decorated onto the request: `user` and `sessionToken`
  (`app.ts:104-105`).
- Plugins registered in order: `@fastify/cookie` (`app.ts:107`), `@fastify/rate-limit`
  with `global: false` so rate limiting is opt-in per route (`app.ts:110`),
  `@fastify/websocket` (`app.ts:112`), and `@fastify/static` when the frontend bundle
  exists (`app.ts:175`).
- One error handler for the whole API emits a single frozen error envelope (`app.ts:117-157`).
  It maps `ZodError` to 400, `DockerError` to its carried status/code, generic 4xx errors
  to a code derived from the status, and everything else to a logged 500 `internal`.
- An `onResponse` hook logs method, url, status and elapsed ms at debug level (`app.ts:160-167`).

Routes, all mounted under the `/api` prefix except the WebSockets:

- Registered directly (`app.ts:200-207`): `auth`, `system`, `containers`, `images`,
  `volumes`, `networks`, `audit`, `users`.
- Registered dynamically (`app.ts:209-215`): `routes/tunnels.ts`, `routes/settings.ts`,
  `routes/templates.ts`, `routes/stacks.ts`. These are loaded with `import()` and skipped
  with a warning if absent (`app.ts:78-94`). `apiPrefixFor()` reads the file text to decide
  whether the module already bakes `/api/` into its paths, so both conventions mount at the
  contract URLs (`app.ts:55-62`). The tunnels and settings modules declare absolute
  `/api/...` paths; templates and stacks declare bare paths and get the prefix.
- WebSocket routes, no `/api` prefix (`app.ts:218-220`): `ws/logs.ts`, `ws/stats.ts`,
  `ws/events.ts`.

Static frontend and SPA fallback are described under "Frontend build and serving".

## Module layout

Each `server/src` directory owns a distinct concern.

| Directory | Owns |
|---|---|
| `auth/` | `sessions.ts` (cookie sessions, token hashing), `password.ts` (scrypt hashing), `rbac.ts` (role ladder, `requireRole`, `sendError`, error envelope), `scope.ts` (allocation/scoping and grant matching), `audit.ts` (audit writes and reads). |
| `cloudflare/` | `api.ts`: Cloudflare API v4 client (tunnel create/delete, token, DNS route, zones, accounts, token verify). |
| `db/` | `pool.ts` (shared `pg.Pool`, `query`/`one`/`many`/`tx`), `schema.ts` (Drizzle table definitions), `migrate.ts` (migration runner, runnable as a CLI or imported). |
| `docker/` | `index.ts` (memoized dockerode client, `dockerPing`/`dockerVersion`, re-exports), `containers.ts`, `images.ts`, `volumes.ts`, `networks.ts`, `stats.ts`, `errors.ts` (`DockerError` + `normalizeDockerError`). |
| `routes/` | One Fastify plugin per REST resource: `auth`, `system`, `containers`, `images`, `volumes`, `networks`, `audit`, `users`, `tunnels`, `settings`, `templates`, `stacks`. |
| `templates/` | `schema.ts` (spec type, zod schema, validation, rendering, secret persistence), `files.ts` (local `*.json` source and table reconcile), `remote.ts` (GitHub repository source), `engine.ts` (deploy). |
| `tunnels/` | `manager.ts` (lifecycle, DB row + live process map), `supervisor.ts` (cloudflared process spawn/kill), `quick.ts`, `named.ts`, `localtunnel.ts` (per-mode starters), `url-parse.ts` (URL/error line scanning), `visibility.ts` (scope filtering). |
| `update/` | `check.ts` (GitHub compare-based update check), `spool.ts` (request/status file handshake with the host updater). |
| `ws/` | `logs.ts`, `stats.ts`, `events.ts`: WebSocket route plugins. |

Top-level `server/src` modules: `index.ts`, `app.ts`, `config.ts`, `logger.ts`,
`events.ts`, `secrets.ts`, `version.ts`, `stacks.ts`.

## Data model

The schema is defined in `server/src/db/schema.ts` and realised by the single generated
migration `server/drizzle/0000_init.sql`. It is described there as the post-squash shape
of six earlier hand-written migrations folded into one (`schema.ts:1-6`, `0000_init.sql:1-14`).

Foreign keys are declared with explicit names so constraint names match Postgres
auto-naming (`schema.ts:14-19`). `schema_migrations` is deliberately not defined in the
schema; Drizzle keeps its own bookkeeping in a separate schema (see "Migrations").

| Table | Key columns | Notes |
|---|---|---|
| `users` | `id` uuid PK default random, `email` text unique (`users_email_key`), `password_hash` text, `role` text default `'admin'` (check: admin/operator/viewer), `scope_mode` text default `'all'` (check: all/granted), `can_exec` boolean default false, `created_at`, `last_login_at` | `role`, `scope_mode`, `can_exec` added by the scopes migration (`schema.ts:53-55`). |
| `sessions` | `id` uuid PK, `user_id` uuid NOT NULL, `token_hash` text unique (`sessions_token_hash_key`), `user_agent`, `ip`, `created_at`, `expires_at` NOT NULL | FK `sessions_user_id_fkey` -> `users.id` ON DELETE cascade (`schema.ts:79-83`). Indexes on `user_id` and `expires_at`. Only `sha256(token)` is stored (`auth/sessions.ts:2-4`). |
| `audit_log` | `id` bigserial PK, `user_id` uuid nullable, `action` text NOT NULL, `target_type` text NOT NULL, `target_id` text, `detail` jsonb, `ip` text, `created_at` | FK `audit_log_user_id_fkey` -> `users.id` ON DELETE set null (`schema.ts:104-108`). Index on `created_at DESC`. `detail` is passed through `redact()` before insert (`auth/audit.ts:42-50`). |
| `templates` | `id` uuid PK, `slug` text unique (`templates_slug_key`), `name`, `category` default `'other'`, `icon` default `'package'`, `description` default `''`, `spec` jsonb NOT NULL, `source` text default `'user'` (check: user/file/remote), `created_at`, `updated_at` | Index on `source` (`templates_source_idx`). The `source` check is the final widened form (`schema.ts:122-131`). |
| `stacks` | `id` uuid PK, `name`, `slug`, `source` default `'template'` (check: template/user), `template_slug` text nullable, `spec` jsonb default `'{}'`, `values` jsonb default `'{}'`, `status` default `'running'` (check: running/stopped/partial/error), `created_by` uuid nullable, `created_at`, `updated_at` | FK `stacks_created_by_fkey` -> `users.id` ON DELETE set null (`schema.ts:154-158`). Index on `slug`. `template_slug` is a plain column, not a FK. |
| `tunnels` | `id` uuid PK, `name`, `mode` text (check: quick/named/localtunnel), `target_url` NOT NULL, `container_id` text nullable, `port` integer, `hostname`, `zone_id`, `tunnel_id`, `credentials_path`, `config_path`, `status` default `'stopped'` (check: stopped/starting/running/error), `url`, `pid` integer, `last_error`, `auto_start` boolean default false, `created_by` uuid nullable, `created_at`, `updated_at` | FK `tunnels_created_by_fkey` -> `users.id` ON DELETE set null (`schema.ts:189-193`). `container_id` is a Docker container id (text), not a FK. |
| `settings` | `key` text PK, `value` jsonb NOT NULL, `secret` boolean default false, `updated_at` | Key/value store. The Cloudflare API token is stored encrypted under `cloudflare.api_token` with `secret = true` (`routes/settings.ts:27-28, 203`). |
| `user_grants` | `id` uuid PK, `user_id` uuid NOT NULL, `resource_kind` text NOT NULL (check: container/stack/volume/network/image/template/tunnel), `resource_id` text nullable, `label_key` text nullable, `label_value` text nullable, `created_by` uuid nullable, `created_at` | FKs `user_grants_user_id_fkey` -> `users.id` ON DELETE cascade and `user_grants_created_by_fkey` -> `users.id` ON DELETE set null (`schema.ts:235-244`). A check enforces exactly one selector form: an id, or a label pair (`schema.ts:230-233`). A unique index covers `(user_id, resource_kind, coalesce(resource_id,''), coalesce(label_key,''), coalesce(label_value,''))` (`schema.ts:218-224`). |

The audit log is `audit_log`. Every mutating route writes a row before it responds, via
`audit()` or `auditFromRequest()` (`auth/audit.ts:41-72`). The `detail` JSON is deep-masked
by `redact()` first, which replaces any key matching `/token|password|secret|key|authorization/i`
with `***` (`logger.ts:19-49`). Reads go through `listAudit()` with a limit clamped to
500 (`auth/audit.ts:74-97`).

## Migrations

Migrations run at boot through `runMigrations()` in `server/src/db/migrate.ts`, called from
`index.ts:65`. Drizzle owns the schema: `schema.ts` is the definition, `server/drizzle/`
holds the SQL generated from it plus Drizzle's journal, and `migrate.ts` is the single entry
point (`migrate.ts:1-23`).

- The migrations directory is resolved to `<repo>/server/drizzle` (`migrate.ts:36`).
- `readJournal()` reads `meta/_journal.json` and sorts entries by `idx` (`migrate.ts:45-55`).
  A missing journal is a hard error naming the fix.
- `runMigrations()` opens a Drizzle instance bound to the shared pool and the schema
  (`migrate.ts:78`), calls Drizzle's `migrate()` against the folder (`migrate.ts:79`), and
  computes `applied`/`already` by diffing the journal's `when` stamps against Drizzle's
  bookkeeping table before and after, because `migrate()` itself returns `void`
  (`migrate.ts:73-91`).
- Drizzle's bookkeeping lives in schema `drizzle`, table `__drizzle_migrations`
  (`migrate.ts:38-40`), and records a migration by its `when` stamp, not its name.
- The generated SQL is written with `IF NOT EXISTS` throughout (`0000_init.sql:12-14`), so
  the first run against a pre-existing database that already has every table is a no-op
  rather than a failure (`migrate.ts:18-21`). The file is split by `statement-breakpoint`
  markers (`0000_init.sql:15-16`).
- `migrationStatus()` reports what has run, mapping each journal entry to its recorded
  timestamp, and surfaces recorded stamps with no journal entry as drift (`migrate.ts:103-131`).
- The module is runnable as a CLI: `node server/src/db/migrate.ts` prints JSON and closes
  the pool (`migrate.ts:133-158`). The root script `npm run migrate` runs it
  (`package.json:16`).

The Dockerfile copies `server/drizzle` into the runtime image because `migrate()` reads the
directory at boot; `drizzle-kit` (which generates migrations) is a dev dependency and is
deliberately not in the runtime image (`Dockerfile:37-41`, `server/package.json:19`).

## Frontend build and serving

The frontend is a React 19 + Vite app in `web/` (`web/package.json:8-13`).

- Vite builds to `web/dist` with `emptyOutDir` and no sourcemaps (`vite.config.ts:9-13`).
  `npm run build:web` runs `vite build` in the web workspace (`package.json:14`).
- In development Vite serves on port 5190 and proxies `/api` and `/ws` to the API on
  `127.0.0.1:8000` (`vite.config.ts:14-22`).
- In production the API serves the bundle. `buildApp()` checks for
  `<repoRoot>/web/dist/index.html` (`app.ts:172-173`); when present it registers
  `@fastify/static` with root `web/dist` and prefix `/` (`app.ts:175-191`). Cache headers are
  set by hand: anything under `/assets/` gets `max-age=31536000, immutable` because Vite
  writes content-hashed filenames, everything else gets `no-cache` because `index.html`
  names the current hashes (`app.ts:180-190`). When `web/dist` is absent, a placeholder HTML
  page is served at `/` and a warning is logged (`app.ts:64-76, 193-195`).
- SPA fallback: the not-found handler returns `index.html` for any non-`/api`, non-`/ws`,
  non-`/assets/` GET or HEAD, so client-side routes resolve (`app.ts:225-243`). A missing
  `/assets/*` file returns a clean 404 rather than HTML (`app.ts:236-238`).

The image builds the frontend in its own stage and copies the output in. The Dockerfile has
four stages (`Dockerfile:1-4`): `web` (builds `web/dist`), `deps` (production server
dependencies), `cloudflared` (downloads the cloudflared binary for the target arch), and
`runtime`. The runtime stage copies `server/src`, `server/drizzle`, `web/dist`, and the
cloudflared binary, runs as a non-root `dockyard` user (uid/gid 1001), exposes 8000, and
starts with `tini` running `node server/src/index.ts` (`Dockerfile:26-70`). The image bakes
`DOCKYARD_COMMIT` and `DOCKYARD_BUILD_TIME` build args so the panel can report its build
(`Dockerfile:28-29, 58-59`).

`version.ts` resolves the running build: the package version from `package.json`, the commit
from `DOCKYARD_COMMIT` or `git rev-parse HEAD`, and the build time from `DOCKYARD_BUILD_TIME`
or the commit date (`version.ts:59-73`). `pinned` is false when the commit is unknown, which
the update check treats as "cannot compare" (`version.ts:19-25`).

## Docker interaction

The panel talks to the Docker Engine API through `dockerode`; it never shells out to the
`docker` CLI. `server/src/docker/index.ts` builds one memoized dockerode client from config
and re-exports the whole service surface (`docker/index.ts:1-15, 58-64`).

- `parseDockerHost()` maps `config.dockerHost` to dockerode options (`docker/index.ts:19-56`).
  Empty host means the default socket `/var/run/docker.sock`. A `unix://` or `npipe://` host
  becomes a socket path; a `tcp://`, `http://` or `https://` host becomes host/port/protocol,
  defaulting to port 2375 (or 2376 with TLS). TLS cert/key/ca are read from
  `DOCKER_TLS_CERT`/`DOCKER_TLS_KEY`/`DOCKER_TLS_CA` as file contents or inline PEM
  (`config.ts:138-144`).
- `dockerPing()` calls `docker.ping()`, `docker.version()` and best-effort `docker.info()`,
  returning engine version, API version, os/arch and container/image counts, or `{ ok: false,
  error }` (`docker/index.ts:77-109`).
- `containers.ts` implements list, inspect, resolve (by full id, id prefix, or name,
  `containers.ts:355-365`), create, start/stop/restart/kill/pause/unpause, remove, prune,
  logs, log streaming, stats, stats streaming and exec. Docker's multiplexed stream framing
  (8-byte header) is demuxed in `demuxDockerStream`/`demuxToReadable` (`containers.ts:64-141`).
  Container create dials the daemon directly to preserve the `Warnings` field dockerode drops
  (`containers.ts:430-448`). Exec runs with a default 30s timeout (`containers.ts:596-654`).
- `errors.ts` maps raw dockerode/Node errors to `DockerError` with an API-facing code and
  status: 404 -> not_found, 409 -> conflict, 400 -> validation_error, and
  `ECONNREFUSED`/`ENOENT`/`EACCES` or socket errors -> `docker_unavailable` 503, otherwise
  `docker_error` 502 (`docker/errors.ts:44-81`). The app error handler maps a `DockerError`
  onto the frozen envelope (`app.ts:133-139`).

Deployment expectation: the panel container mounts `/var/run/docker.sock` and is added to the
host docker group via `DOCKER_GID` so the non-root panel user can open the socket
(`docker-compose.yml`, `Dockerfile:63-66`). Because the socket is root-equivalent, the
compose file and comments repeatedly note that the panel's published address is a
root-equivalent door.

## Tunnel supervision

Tunnels are supervised by `server/src/tunnels/manager.ts`. The durable record is the
`tunnels` table row; the live child process (or localtunnel client) is held in an in-memory
map keyed by row id (`manager.ts:120`). Every state change updates the row and publishes a
`{ type: 'tunnel', action, data }` event on the in-process bus (`manager.ts:3-9`).

Three modes (`manager.ts:37-42`):

- `quick`: cloudflared is spawned with `tunnel --url <target> --no-autoupdate` and prints an
  ephemeral `trycloudflare` URL on stderr; the tunnel dies with the process
  (`quick.ts:23-29, 36-107`). `--protocol http2` is added when `DOCKYARD_CF_PROTOCOL=http2`.
- `named`: the manager creates a Cloudflare tunnel, fetches its token, writes
  `credentials.json` (mode 0600) and a generated `config.yml` under `data/tunnels/<slug>/`
  (`named.ts:45-62`), spawns `cloudflared tunnel --config <config> run <name>`, waits 1.5s to
  catch an immediate exit, then routes DNS if a zone id was supplied (`manager.ts:325-361,
  495-525`). The token is decoded into a credentials object best-effort (`manager.ts:304-323`).
- `localtunnel`: a library, not a child process. It dials localtunnel.me and returns a public
  `https://<words>.loca.lt` URL; the handle implements the same `pid`/`kill`/`onExit` surface
  as a spawned process, with `pid` null (`localtunnel.ts:1-11, 76-126`).

`supervisor.ts` spawns the cloudflared binary with piped stdio, line-buffers stdout and
stderr separately, strips ANSI, and delivers one callback per complete line (`supervisor.ts:28-97`).
`kill()` is SIGTERM then SIGKILL after a 5s grace and is safe to call more than once
(`supervisor.ts:130-157`). A missing binary (`ENOENT`) is reported through the callbacks
rather than throwing (`supervisor.ts:114-123`).

Supervision mechanics:

- Starting a tunnel sets the row to `starting`, launches the provider, registers the live
  entry, and sets the row to `running` with the URL and pid (`manager.ts:471-546`). On any
  failure the process is killed and the row is set to `error` with `last_error` (`manager.ts:528-545`).
- The live entry's exit callback marks the row `error` unless the stop was intentional
  (`manager.ts:363-398`).
- `stop()` kills the process, waits up to 7s, and sets the row `stopped` (`manager.ts:548-563`).
- `init()` (called at boot) first `reconcile()`s: any row left `starting`/`running` with no
  live process is reset to `stopped` (`manager.ts:597-611`); then it starts every row with
  `auto_start = true` in `stopped`/`error` (`manager.ts:613-628`).
- `shutdown()` stops every live tunnel (`manager.ts:630-643`).
- Visibility is scope-aware: a tunnel is visible when granted directly or when the container
  it exposes is granted (`tunnels/visibility.ts:19-44`).

The `tunnelTargetHost` used when a tunnel targets a container's published port is read
defensively from config and falls back to `127.0.0.1` (`manager.ts:130-138`). In compose it is
set to `host.docker.internal`, because the panel is itself a container and a target on another
container's published port must be reached through the host gateway (`docker-compose.yml`).
This document could not confirm that `tunnelTargetHost` is a declared field on the `Config`
type in `config.ts`; `manager.ts:130-138` and `routes/settings.ts:74-77` both read it
defensively with a fallback, which suggests it may not be.

## Templates: resolution and deployment

Templates are declarative container specs. The spec type, zod schema, validation and
rendering live in `server/src/templates/schema.ts` (`schema.ts:41-59, 108-140, 178-245`).

Resolution: there is no compiled-in catalog. A template is a row in the `templates` table,
and a row arrives from one of three sources (`templates/files.ts:1-19`):

- `user`: authored in the panel (`POST /templates`, `routes/templates.ts:182-216`).
- `file`: a `*.json` file the operator dropped into `config.templateDir`
  (`DOCKYARD_TEMPLATE_DIR`, a bind mount in compose).
- `remote`: a `*.json` file pulled from a public template repository
  (`DOCKYARD_TEMPLATES_REPO`, default `dockyardapp/dockyard-templates`) into a local cache
  directory (`templates/remote.ts:1-25`).

Precedence is `user > file > remote` (`templates/files.ts:1-15`). `syncTemplateSource()`
upserts every valid spec and deletes rows of that source whose file is gone
(`templates/files.ts:221-317`). The `where templates.source = any(...)` clause on the upsert
is what protects a panel-authored template: a file or remote reconcile can overwrite only
rows at or below its own level (`templates/files.ts:255-289`). Reads reconcile the sources
first: `resyncTemplateSources()` runs the file reconcile then the remote reconcile, forcing
the remote one when the file reconcile removed a row (`routes/templates.ts:123-152`).

The remote source (`templates/remote.ts`): it lists the repository tree with one GitHub API
call and reads file bodies from the raw host (`remote.ts:165-224`). Files are selected from a
`templates/` folder when present, otherwise from root JSON files excluding a small deny-list
(`remote.ts:145-158`). The cache is replaced atomically (write to a temp dir, two renames), so
a failed fetch never removes a template (`remote.ts:226-293`). Pulling is gated on the
`templatesRefreshMinutes` window and deduplicated through a single in-flight promise
(`remote.ts:301-314`). Limits: `MAX_FILES` 500 and `MAX_FILE_BYTES` 256 KiB
(`templates/files.ts:86-87`), plus a 4 MiB total per pull (`remote.ts:45`).

Deployment: `deployTemplate()` in `templates/engine.ts` (`engine.ts:94-212`):

1. Resolve the spec from the `templates` row by slug and validate it (`engine.ts:67-74`).
   A missing or invalid spec is a 404 `TemplateNotFoundError`.
2. Render the spec plus user values into concrete container inputs, collecting missing
   required values and rejecting before touching Docker (`engine.ts:98-105`, `schema.ts:178-245`).
3. Insert a `stacks` row with `source = 'template'`, status `running` (`engine.ts:112-118`).
4. Create the container with `pull: true`, applying rendered env, ports, volumes, restart
   policy, labels, and an optional healthcheck (`engine.ts:141-159`). On create failure the
   stack row is rolled back (`engine.ts:160-171`). On start failure the created container is
   force-removed and the row is marked `error`, so no orphan container is left (`engine.ts:173-190`).
5. Mark the stack `running` and emit a `stack` deploy event (`engine.ts:192-209`).

A stack links to its containers through the `dockyard.stack` label holding the stack id,
resolved via `listContainers({ all: true })`, never by matching names (`stacks.ts:1-5`). The
deploy engine adds `dockyard.stack` and `dockyard.name` labels on top of the template's own
and any allocation labels (`engine.ts:130-137`). Scoped users inherit a grant label onto the
containers they create so their deployments stay visible to them (`routes/containers.ts:129-143`,
`engine.ts:41-52`). Secrets in a template's env are never persisted: the stored `values`
replace each secret's value with the `***` marker (`schema.ts:61-62, 247-268`).

## Security-relevant wiring (read from code)

- Sessions: 32 random bytes base64url, only `sha256` stored; the cookie `dockyard_session` is
  httpOnly, sameSite lax, path `/`, secure per `config.cookieSecure` (`auth/sessions.ts:1-5,
  36-69`). `COOKIE_SECURE` unset means secure in production, and an explicit `false` in
  production is refused at boot (`config.ts:146-172`).
- Passwords: scrypt via `node:crypto` with cost parameters stored in the hash string; login
  runs a dummy verify for unknown emails to avoid a timing oracle (`auth/password.ts:1-8,
  72-83`).
- Roles: viewer < operator < admin, enforced centrally with `requireRole` as a preHandler
  (`auth/rbac.ts:3-5, 112-127`).
- Exec is gated on the separate `can_exec` flag, not the operator role, because the panel
  mounts the Docker socket (`routes/containers.ts:233-248`, `auth/scope.ts:172-179`).
- Scoping answers 404 for resources a scoped user may not see, worded identically to a real
  miss, so ids cannot be enumerated (`auth/scope.ts:16-23, 185-187`).
- Secrets at rest use AES-256-GCM with a 32-byte key from `SECRET_KEY`; only
  `maskSecret()`/`fingerprint()` outputs are surfaced (`secrets.ts:1-8, 108-119`).

## What could not be determined from the code

- Whether `tunnelTargetHost` is a declared field on the `Config` type. It is read defensively
  with a fallback in two places (`tunnels/manager.ts:130-138`, `routes/settings.ts:74-77`)
  and is not present in the `Config` type literal in `config.ts:21-75`.
- The exact behaviour of `install.sh` and `deploy/update.sh`; they are host-side scripts and
  were not read in full for this document. Their panel-facing side is `update/spool.ts`.
- The contents of `CONTRACT.md` (referenced throughout as the frozen contract) were not read
  here; comments cite it as contract sections.
- The frontend internals (`web/src`) beyond the entry points, router, and Vite config; the
  page and component modules were not read for this document.
