# Dockyard configuration reference

## How configuration is loaded

Two files define configuration, and they have different jobs.

- `.env.example` is the documented template. It lists the variables an operator is expected to set, with comments explaining intent. Copy it to `.env` and edit.
- `server/src/config.ts` is the authority on parsing and defaults. It loads `<repoRoot>/.env` itself (without overwriting variables already present in the environment), then builds a single frozen `config` object. Defaults, type coercion, and validation all live here.
- `docker-compose.yml` is a third source for container deployments. It passes variables into the panel container and adds several of its own that the server never reads.

When the same variable is handled differently across the files, this document says so in the variable's row or note. The main disagreements:

| Variable | `.env.example` | `config.ts` / `docker-compose.yml` |
|---|---|---|
| `SECRET_KEY` | Documented as required; no default. | `config.ts` silently generates a random key when unset (line 186). `docker-compose.yml` refuses to start without it (`${SECRET_KEY:?…}`, line 50). |
| `COOKIE_SECURE` | Shipped as `false` (line 105). | `config.ts` treats unset as "secure in production" and throws at boot if it is explicitly `false` while `NODE_ENV=production` (lines 154 to 172). Copying `.env.example` verbatim into a production install fails to boot. |
| `DATABASE_URL` | A full connection string is shipped (line 14). | `config.ts` default is the empty string (line 203). `docker-compose.yml` builds it from `POSTGRES_PASSWORD` (line 49) and ignores the `.env` value. |
| `PGSSLMODE` | Present (line 15). | Not read by `config.ts`. See the note under Postgres. |
| `TUNNEL_TARGET_HOST` | Present (line 33). | Not read by `config.ts`. Set by `docker-compose.yml` (line 53). See the note under Tunnels. |
| `DOCKYARD_ADMIN_EMAIL` | Not present. | `config.ts` default is empty (line 222); `docker-compose.yml` default is `admin@dockyard.local` (line 68). |
| `NODE_ENV` | Not present. | Read by `config.ts` (lines 181 to 183); `docker-compose.yml` defaults it to `production` (line 40). |

A few variables the server reads appear in neither `.env.example` nor `docker-compose.yml` and are documented here from `config.ts` alone. Path variables are resolved by `resolveDir` (lines 121 to 124): an empty or whitespace value falls back to the default, an absolute path is used as is, and a relative path is resolved against the repo root.

## API server

| Variable | What it does | Default | Required | Security consequence |
|---|---|---|---|---|
| `NODE_ENV` | Selects the runtime mode (`development`, `production`, or `test`). Anything other than `production` or `test` is treated as `development` (`config.ts` lines 181 to 183). | `development` in `config.ts`; `production` in `docker-compose.yml` (line 40). | No | Sets whether `COOKIE_SECURE` fails closed. In `production`, an explicit `COOKIE_SECURE=false` is refused at boot. |
| `PORT` | TCP port the API server listens on. | `8000` (`config.ts` line 199). | No | None by itself; exposure is governed by `HOST` and the compose publish mapping. |
| `HOST` | Interface the API server binds to. | `0.0.0.0` (`config.ts` line 200). | No | `0.0.0.0` listens on every interface. Because the panel mounts the Docker socket, a reachable panel is root-equivalent control of the host. Use `127.0.0.1` when a tunnel or proxy is the only intended way in. |
| `LOG_LEVEL` | Log verbosity passed to the logger. Lowercased on read. | `info` (`config.ts` line 201). | No | None stated in the files read. |
| `PUBLIC_URL` | Public base URL of the panel, used for links shown in the UI. Trailing slashes are stripped. | `http://localhost:8000` (`config.ts` line 202; `.env.example` line 11). | No | None stated in the files read. |

Parsing note: `PORT` is read with `Number(process.env.PORT ?? 8000)` and is not validated, so a non-numeric value yields `NaN` rather than falling back (`config.ts` line 199). `HOST` is used verbatim with no trim or lowercasing (line 200).

## Postgres

| Variable | What it does | Default | Required | Security consequence |
|---|---|---|---|---|
| `DATABASE_URL` | Postgres connection string the server connects with. | Empty string (`config.ts` line 203). `.env.example` ships a full URL. | No in `config.ts`. The connection fails at runtime if empty. | Contains the database password in plaintext in the environment. |
| `POSTGRES_PASSWORD` | Password for the Postgres container's `dockyard` user, and the password substituted into the panel's `DATABASE_URL`. | None. Compose aborts with `set POSTGRES_PASSWORD (no default is shipped)` (`docker-compose.yml` lines 16 and 49). | Yes, for `docker compose`. | A weak or shared password is a direct database credential. |
| `POSTGRES_USER` | Postgres user name. | `dockyard`, hardcoded (`docker-compose.yml` line 15). | No | None stated in the files read. |
| `POSTGRES_DB` | Postgres database name. | `dockyard`, hardcoded (`docker-compose.yml` line 17). | No | None stated in the files read. |
| `PGSSLMODE` | Present in `.env.example` (line 15) with the value `disable`. | Value `disable` in `.env.example`. | Unknown. | Cannot be determined from the files read. `config.ts` does not read `PGSSLMODE`, and `docker-compose.yml` does not pass it into any service. Something outside these three files may consume it, or it may be unused. |

Note: `docker-compose.yml` builds the panel's `DATABASE_URL` as `postgres://dockyard:${POSTGRES_PASSWORD}@db:5432/dockyard` (line 49), pointing at the compose service `db`, not at `127.0.0.1` as `.env.example` shows.

## Docker engine

| Variable | What it does | Default | Required | Security consequence |
|---|---|---|---|---|
| `DOCKER_HOST` | Docker daemon endpoint. Empty means the default socket (`/var/run/docker.sock`, or a named pipe on Windows). A value like `tcp://127.0.0.1:2375` targets a plain TCP daemon. | Empty string, meaning the default socket (`config.ts` line 204; `.env.example` lines 18 to 20). | No | A TCP daemon endpoint without TLS is unauthenticated root-equivalent control. A remote host moves the trust boundary off the panel host. |
| `DOCKER_TLS_CERT` | TLS client certificate for a TCP daemon. | Undefined. If either cert or key is absent, no TLS config is built (`config.ts` lines 138 to 144). | No | Required as a pair with `DOCKER_TLS_KEY` for TLS to be used at all. |
| `DOCKER_TLS_KEY` | TLS client private key for a TCP daemon. | Undefined (same rule as above). | No | Private key material. Present in the environment if set inline. |
| `DOCKER_TLS_CA` | TLS CA certificate for a TCP daemon. | Empty string when absent (`config.ts` line 142). | No | None stated in the files read. |

Reading note: `DOCKER_TLS_CERT`, `DOCKER_TLS_KEY`, and `DOCKER_TLS_CA` each pass through `readMaybeFile` (lines 126 to 136). If the value names a readable file, the file's contents are used; otherwise the value is treated as an inline PEM. TLS is only enabled when both a cert and a key are present; the CA alone does nothing.

## Tunnels

| Variable | What it does | Default | Required | Security consequence |
|---|---|---|---|---|
| `CLOUDFLARED_BIN` | Path to the `cloudflared` binary. Overridable in tests with a stub. | `cloudflared` (`config.ts` line 206; `.env.example` line 28). `docker-compose.yml` sets `/usr/local/bin/cloudflared` (line 65). | No | None stated in the files read. |
| `TUNNEL_DATA_DIR` | Directory where named-tunnel `credentials.json` and `config.yml` are written. | `<repoRoot>/data/tunnels` (`config.ts` line 189; `.env.example` line 30). `docker-compose.yml` sets `/app/data/tunnels` (line 54). | No | Holds tunnel credential files. Treat the directory as secret. |
| `TUNNEL_TARGET_HOST` | Host used when a tunnel targets a container's published port. `.env.example` recommends `host.docker.internal` when the panel runs in a container (line 33); `docker-compose.yml` sets exactly that (line 53). | `127.0.0.1` in `.env.example` (line 33); `host.docker.internal` in `docker-compose.yml` (line 53). | No | Cannot be fully determined from the files read. `config.ts` does not read `TUNNEL_TARGET_HOST`, so the consumer is outside these three files. |
| `CLOUDFLARE_API_TOKEN` | Cloudflare API token for tunnel management. Scopes per `.env.example`: Zone:DNS:Edit plus Account:Cloudflare Tunnel:Edit. Can also be set at runtime from Settings, stored encrypted in the DB. | Empty string (`config.ts` line 217; `.env.example` line 36). | No | Grants DNS edit and tunnel control on the Cloudflare account. When stored via Settings it is encrypted at rest with `SECRET_KEY`. |
| `CLOUDFLARE_ACCOUNT_ID` | Cloudflare account identifier paired with the API token. | Empty string (`config.ts` line 218; `.env.example` line 37). | No | An account identifier, not a secret on its own. |

## Templates

| Variable | What it does | Default | Required | Security consequence |
|---|---|---|---|---|
| `DOCKYARD_TEMPLATE_DIR` | Directory scanned for `*.json` template files. A file dropped here appears in the panel on the next page load, no rebuild or restart. | `<repoRoot>/data/templates` (`config.ts` line 190; `.env.example` line 44). `docker-compose.yml` bind-mounts `./data/templates` to `/app/data/templates` and sets this to `/app/data/templates` (lines 57 and 104). | No | A writable template directory is a place an attacker can inject a container definition. |
| `DOCKYARD_TEMPLATES_REPO` | Public repository of template files pulled over the network and reconciled like local files. Reads `templates/*.json`, or `*.json` at the root if there is no such folder. Empty string switches the whole remote source off. | `dockyardapp/dockyard-templates` (`config.ts` line 191, constant `DEFAULT_TEMPLATES_REPO` at line 19; `.env.example` line 53; `docker-compose.yml` line 60). | No | Pulled templates are treated like local files, so the repository is a supply channel for container definitions. |
| `DOCKYARD_TEMPLATES_BRANCH` | Branch of `DOCKYARD_TEMPLATES_REPO` to pull. | `main` (`config.ts` line 211; `.env.example` line 54; `docker-compose.yml` line 61). | No | None stated in the files read. |
| `DOCKYARD_TEMPLATES_DIR` | Cache directory for pulled templates. Must be writable; a container path in Docker deployments. | `<repoRoot>/data/templates-remote` (`config.ts` lines 192 to 195; `.env.example` line 56). `docker-compose.yml` sets `/app/data/templates-remote` (line 62). | No | None stated in the files read. |
| `DOCKYARD_TEMPLATES_REFRESH_MINUTES` | How long a successful pull is trusted before the next page load refreshes it, in minutes. Parsed by `positiveInt`, so a zero, negative, or non-numeric value falls back. | `15` (`config.ts` line 213; `.env.example` line 58; `docker-compose.yml` line 63). | No | None stated in the files read. |
| `DOCKYARD_TEMPLATES_TOKEN` | Optional token to raise the anonymous GitHub API limit (60 requests an hour per address) or pull from a private repository. A read-only, public-repo-scope token is enough. `.env.example` states it is never logged. | Empty string (`config.ts` line 216; `.env.example` line 61). | No | A credential; keep it read-only and scoped to public repo contents. |
| `DOCKYARD_TEMPLATES_API_BASE` | Base URL for the GitHub API used to list templates. Overridable so a test can serve the API from localhost. Trailing slashes stripped. | `https://api.github.com` (`config.ts` line 214). | No | Points template fetching at an arbitrary host. Only change it for a trusted mirror or a test. |
| `DOCKYARD_TEMPLATES_RAW_BASE` | Base URL for raw template file downloads. Trailing slashes stripped. | `https://raw.githubusercontent.com` (`config.ts` line 215). | No | Same as above: redirects where template content is fetched from. |

Precedence for template sources, highest first: a template edited in the panel, a local file, then the repository (`.env.example` lines 50 to 51). Pulling therefore cannot undo local work.

## Secrets

| Variable | What it does | Default | Required | Security consequence |
|---|---|---|---|---|
| `SECRET_KEY` | 32-plus byte hex or base64 key used to encrypt secrets at rest (AES-256-GCM), including runtime-set Cloudflare credentials. `.env.example` documents it as 64 hex chars and gives a generation command. | If unset, `config.ts` generates a fresh random 32-byte hex value on each boot (lines 185 to 186). | Yes for `docker compose` (`${SECRET_KEY:?…}`, `docker-compose.yml` line 50). No hard requirement in `config.ts`, but see the consequence. | Everything encrypted at rest becomes undecryptable after a restart when the key is random, because the key changes every boot. A stable, secret key is required for encrypted data to survive. Leaking it exposes every secret it protects. |
| `DOCKYARD_ADMIN_EMAIL` | First-boot admin account email. | Empty string in `config.ts` (line 222); `admin@dockyard.local` in `docker-compose.yml` (line 68). | No | None stated in the files read. |
| `DOCKYARD_ADMIN_PASSWORD` | Optional first-boot admin password. | Empty string (`config.ts` line 223; `docker-compose.yml` line 69). | No | An initial credential. If empty, no first-boot admin is created from this value. |

## Sessions

| Variable | What it does | Default | Required | Security consequence |
|---|---|---|---|---|
| `SESSION_TTL_HOURS` | Session lifetime in hours. | `168` (7 days) (`config.ts` line 220; `.env.example` line 104). | No | A longer lifetime widens the window a stolen session cookie stays valid. Parsed with `Number`, so junk yields `NaN` rather than falling back. |
| `COOKIE_SECURE` | Sets the `Secure` flag on the session cookie. Accepts `true/1/yes` and `false/0/no`, case-insensitive. | Unset resolves to `true` in production and `false` otherwise (`config.ts` lines 154 to 172). `.env.example` ships `false` (line 105). | No, but production effectively requires it to be true. | A `Secure` cookie is only sent over TLS. If unset while running behind plain HTTP, the browser silently drops the cookie and sign-in fails. `config.ts` refuses to boot if `COOKIE_SECURE=false` with `NODE_ENV=production`, and rejects any value that is not a recognized truthy or falsy string. |
| `DOCKYARD_LOGIN_RATE_MAX` | Login attempts allowed per IP per minute. Parsed by `positiveInt`. | `10` (`config.ts` line 224; `.env.example` line 108). | No | Lower is safer in production. Raise it only for a test host that signs in many accounts, as the end-to-end suite does. |

## Updates

| Variable | What it does | Default | Required | Security consequence |
|---|---|---|---|---|
| `DOCKYARD_UPDATE_REPO` | GitHub `owner/name` this panel updates from. | `dockyardapp/dockyard` (`config.ts` line 225; `.env.example` line 114; `docker-compose.yml` line 72). | No | Determines which repository the panel treats as its own source. Point it at a repository you control. |
| `DOCKYARD_UPDATE_BRANCH` | Branch checked for updates. | `main` (`config.ts` line 226; `.env.example` line 115; `docker-compose.yml` line 73). | No | None stated in the files read. |
| `DOCKYARD_UPDATE_TOKEN` | Optional fine-grained token with read-only Contents access, needed only while the repository is private. The panel only reads; the host updater in `deploy/update.sh` does the pulling. | Empty string (`config.ts` line 227; `.env.example` line 118; `docker-compose.yml` line 74). | No | A credential; keep it read-only. |
| `DOCKYARD_UPDATE_SPOOL` | Directory where the panel writes update requests and reads updater status. The host systemd path unit runs `deploy/update.sh` against it. | `<repoRoot>/data/update` (`config.ts` line 228; `.env.example` lines 123 to 125). `docker-compose.yml` bind-mounts `./data/update` to `/app/data/update` (line 100). | No | The spool is the interface between the panel and a host process that rebuilds and restarts the panel. It is writable by the panel and read by a host-side updater, so treat writes to it as privileged. |
| `DOCKYARD_UPDATE_ENABLED` | Enables the update button. The value is false only for the exact strings `false`, `0`, or `no` (case-insensitive); anything else is true. False refuses `POST /api/system/update` but keeps the version check available. | `true` (`config.ts` line 229; `.env.example` line 122; `docker-compose.yml` line 75). | No | When enabled, the panel can trigger a host-side rebuild and restart of itself. Set false to hide the button entirely. |

## Compose-only

These variables are read by `docker-compose.yml` (or by Compose itself) and are not read by `config.ts`. They affect container deployment, not the server process.

| Variable | What it does | Default | Required | Security consequence |
|---|---|---|---|---|
| `POSTGRES_PASSWORD` | See Postgres above. Required by Compose. | None; Compose aborts if unset (`docker-compose.yml` line 16). | Yes, for `docker compose`. | Direct database credential; also embedded in the panel's `DATABASE_URL`. |
| `DOCKER_GID` | Host docker group id. The panel image runs as uid/gid 1001 and the socket is `root:docker` mode 0660, so the panel needs this group to open `/var/run/docker.sock`. Find it with `getent group docker \| cut -d: -f3`. | None; Compose aborts if unset (`docker-compose.yml` line 83). | Yes, for `docker compose`. | Membership in the docker group is root-equivalent. A wrong value fails at the first API call, not at start-up. |
| `PANEL_PORT` | Host port the panel is published on. The panel itself always listens on 8000 inside the container; this is the host side. | `8000` (`docker-compose.yml` line 92; `.env.example` line 76). | No | None by itself. The one case that wants `80` is a tunnel in front (`.env.example` lines 5 to 6 and 74 to 76). |
| `PANEL_BIND` | Address the panel is published on. `0.0.0.0` is reachable from anywhere the host is; `127.0.0.1` keeps it on the host. | `0.0.0.0` (`docker-compose.yml` line 92; `.env.example` line 81). | No | The panel mounts the Docker socket, so this address is a root-equivalent door. Set `127.0.0.1` when a tunnel or reverse proxy is the only intended way in. |
| `COMPOSE_PROFILES` | Read by Compose itself to select service profiles. Setting it to `proxy` brings up the nginx service; leaving it empty leaves nginx down. Because Compose reads it from `.env`, `install.sh` and `deploy/update.sh` toggle the proxy by writing one variable. | Empty, so no proxy (`docker-compose.yml` lines 106 to 109; `.env.example` line 95). | No | Turning the proxy on is what lets the panel be bound to `127.0.0.1` and reached only through nginx. Leaving the panel bound to `0.0.0.0` without a proxy keeps the root-equivalent port public. |
| `PROXY_BIND` | Address nginx publishes on. `0.0.0.0` is reachable from anywhere the host is; `127.0.0.1` keeps the proxy on the host for a local load balancer. | `0.0.0.0` (`docker-compose.yml` lines 120 to 121; `.env.example` line 98). | No | When the proxy is the only public door, this is the address the outside world reaches. `127.0.0.1` removes public reachability entirely. |
| `PROXY_HTTP_PORT` | Host port nginx publishes for HTTP. Inside the container nginx always listens on 80. | `80` (`docker-compose.yml` line 120; `.env.example` line 100). | No | None stated in the files read. |
| `PROXY_HTTPS_PORT` | Host port nginx publishes for HTTPS. Inside the container nginx always listens on 443. | `443` (`docker-compose.yml` line 121; `.env.example` line 101). | No | None stated in the files read. |
| `GIT_COMMIT` | Commit hash stamped into the panel image at build time so the panel can name the commit it is running. A plain `docker compose build` leaves it empty and the panel reports the commit as unknown. | Empty (`docker-compose.yml` line 33). | No | None stated in the files read. |
| `BUILD_TIME` | Build timestamp stamped into the panel image at build time, alongside `GIT_COMMIT`. | Empty (`docker-compose.yml` line 34). | No | None stated in the files read. |

Note: `NODE_ENV`, `PORT`, `HOST`, `PUBLIC_URL`, `COOKIE_SECURE`, `DATABASE_URL`, `SECRET_KEY`, `TUNNEL_TARGET_HOST`, `TUNNEL_DATA_DIR`, `DOCKYARD_TEMPLATE_DIR`, `DOCKYARD_TEMPLATES_*`, `CLOUDFLARED_BIN`, `CLOUDFLARE_*`, `DOCKYARD_ADMIN_*`, and `DOCKYARD_UPDATE_*` also appear in the `panel` service's `environment` block. In a container deployment those compose values, not the `.env` values, are what the server sees. `PORT` and `HOST` are hardcoded to `8000` and `0.0.0.0` there (lines 41 and 42).

## Server-read variables not in `.env.example`

These are read by `config.ts` but do not appear in `.env.example` or `docker-compose.yml`. They are documented from code alone.

| Variable | What it does | Default | Required | Security consequence |
|---|---|---|---|---|
| `DOCKYARD_DATA_DIR` | Base data directory. Falls back to `DATA_DIR` if `DOCKYARD_DATA_DIR` is unset. | `<repoRoot>/data` (`config.ts` line 188). | No | None stated in the files read. |
| `DATA_DIR` | Fallback for `DOCKYARD_DATA_DIR` when the latter is unset. | `<repoRoot>/data` (same line). | No | None stated in the files read. |
| `DOCKYARD_TEMPLATES_API_BASE` | See Templates above. | `https://api.github.com` (`config.ts` line 214). | No | Redirects template listing to an arbitrary host. |
| `DOCKYARD_TEMPLATES_RAW_BASE` | See Templates above. | `https://raw.githubusercontent.com` (`config.ts` line 215). | No | Redirects template downloads to an arbitrary host. |
