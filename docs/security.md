# Dockyard security model

What Dockyard protects, what it does not, and where each control lives in the source.
Read from the tree at version 0.9.0 (`package.json:4`); file:line references point at
the code that carries each claim. This document expands the "Security notes" section of
the root `README.md`; it does not replace or contradict it.

The single fact everything below follows from: the panel mounts the host's Docker
socket (`docker-compose.yml:95`). Anyone who can sign in, or who can reach a route that
acts on their behalf, has root-equivalent control of the host. The controls in this
document are therefore mostly about **who becomes an authenticated user**, not about
limiting what an authenticated user can do, because once you can run a container you can
already mount `/` or run `--privileged` and own the box.

## Threat model

Assets, in the order they matter:

1. **Host root.** Reachable from any authenticated panel session, via the Docker socket.
2. **The Docker socket itself** (`/var/run/docker.sock`), mounted read/write into the
   panel (`docker-compose.yml:95`). The image runs as uid/gid 1001 and is added to the
   host's docker group (`docker-compose.yml:78-83`), which is what lets the unprivileged
   process open a `root:docker 0660` socket.
3. **The Postgres database.** Holds password hashes, session token hashes, the audit
   trail, and encrypted secrets. It is not published; the `db` service has no `ports`
   mapping, so it is reachable only on the compose network.
4. **Credentials at rest.** `SECRET_KEY`, `POSTGRES_PASSWORD`, `DOCKYARD_ADMIN_PASSWORD`
   and the Cloudflare API token.
5. **The host updater.** `data/update/request.json` is written by the panel and consumed
   by `deploy/update.sh` running as root on the host, so the spool is a privilege
   boundary between the panel process and root (see the root `README.md`).

Adversaries the controls are aimed at:

- Someone who can reach the published port and try to sign in, or to race the bootstrap
  route on a fresh install.
- A signed-in user with a low role or a narrow allocation who tries to reach resources
  they were not granted, or to escalate.
- A process that reads the panel's logs, the database, or the `.env` file.

Explicitly **out of scope** for these controls:

- A compromised host, Docker daemon, or Postgres. The panel trusts all three.
- The host-side updater script, which runs as root by design.
- Physical access, and the cloudflared or localtunnel third-party services used by
  tunnels.
- Anything that can already read the Docker socket directly. That is root, and no panel
  control changes it.

## The Docker socket is the door

`docker-compose.yml:95` bind-mounts `/var/run/docker.sock`. Every write route in the
panel is a Docker Engine API call through `dockerode`. The practical consequences:

- `POST /api/containers` can create a container with an arbitrary host bind mount or an
  arbitrary command, which is host root. It requires only the `operator` role
  (`server/src/routes/containers.ts:129`).
- `POST /api/containers/:id/exec` runs a command in a container, also host root, gated
  separately on the `can_exec` flag (see below).
- Even `operator`-level actions like `POST /api/containers/:id/restart` operate on a
  shared daemon.

So the role ladder is not a containment boundary for a determined operator or admin. It
separates "can change the host" from "can only read", and separates exec from everything
else, but an `operator` is already effectively root. Treat `operator` and `admin` as
trusted and size your user list accordingly.

## The published port, and why the bind address matters

The panel listens on `0.0.0.0:8000` inside its container by default (`config.ts:200`,
`config.ts:199`) and is published on the host by `docker-compose.yml:92`:

```
- "${PANEL_BIND:-0.0.0.0}:${PANEL_PORT:-8000}:8000"
```

`PANEL_BIND` defaults to `0.0.0.0` (`.env.example:81`), reachable from anywhere the host
is reachable. The compose file and `.env.example` both state the reason plainly: the
panel mounts the Docker socket, so the published address is a root-equivalent door
(`docker-compose.yml:89-91`, `.env.example:77-80`).

The intended topology is the optional nginx service (`docker-compose.yml:110-131`),
enabled with `COMPOSE_PROFILES=proxy`, as the single public door, with the panel moved
to loopback (`PANEL_BIND=127.0.0.1`). `install.sh` forces `PANEL_BIND=127.0.0.1` when the
proxy is on. This is not only about exposure: the panel sets `trustProxy: true`
(`server/src/app.ts:99`), so `req.ip` is taken from `X-Forwarded-For`. On a directly
reachable panel a client can set that header itself, which spoofs the source IP used by
the per-IP login limit and recorded in the audit log. Behind nginx the header is set by
the proxy; directly exposed it is attacker-controlled.

## The session cookie, and the Secure flag being tied to TLS

Sessions are opaque tokens in one cookie, set in `server/src/auth/sessions.ts:61-68`:

- Name `dockyard_session` (`sessions.ts:16`).
- `httpOnly: true`, `sameSite: 'lax'`, `path: '/'`.
- `secure: config.cookieSecure`.
- `maxAge` equal to the session TTL, default 168 hours / 7 days (`config.ts:220`).

The token is 32 random bytes, base64url, and only `sha256(token)` is stored
(`sessions.ts:32-38`), so a database leak cannot be replayed. A session is resolved on
every request by a query that also checks `expires_at > now()` (`sessions.ts:76-86`).
Changing a user's password or scope deletes that user's sessions
(`server/src/routes/users.ts:176-178`), and expired rows are pruned at boot
(`index.ts:70`).

The `Secure` flag is resolved by `resolveCookieSecure` (`config.ts:154-172`) and it fails
closed:

- Unset means "secure when `NODE_ENV=production`" (`config.ts:160`).
- An explicit `false` **while `NODE_ENV=production` refuses to boot**
  (`config.ts:165-170`).

The consequence, which the root `README.md` also states, is that a panel served over
plain HTTP must run with `NODE_ENV=development` and `COOKIE_SECURE=false`. A `Secure`
cookie is not sent by a browser over `http`, so a production-configured panel on plain
HTTP would appear to sign in and then not stick, while `curl` based checks keep passing.

Two things worth being precise about:

- `NODE_ENV=development` disables **no other control**. `config.env` is read in exactly
  one decision, the cookie (`config.ts:160`, `config.ts:165`), and three reporting sites
  (`routes/settings.ts:98`, `index.ts:78`, `app.ts:245`). Nothing else branches on it.
  Running plain HTTP is a transport change, not a security-off switch, but it does mean
  the session cookie crosses the network in the clear.
- There is no separate CSRF token. `sameSite: 'lax'` is the CSRF defense: the browser
  will not attach the session cookie to a cross-site `POST`, and every mutating route is
  `POST`, `PATCH` or `DELETE`, so a cross-site form submission arrives unauthenticated and
  gets `401`. `lax` still sends the cookie on top-level `GET` navigations, which is why
  state changes are not modeled as `GET`.

## Login rate limiting

`@fastify/rate-limit` is registered with `global: false` (`server/src/app.ts:110`), so it
applies only where a route opts in. Exactly one route opts in: `POST /api/auth/login`
(`server/src/routes/auth.ts:77-79`), limited to `config.loginRateMax` attempts per IP per
minute, default 10 (`config.ts:224`, `.env.example:106-108`).

- The limit is keyed on `req.ip`, which with `trustProxy: true` is derived from
  `X-Forwarded-For`. On a directly exposed panel that header is attacker-controlled, so
  the per-IP limit is only as strong as the deployment's control of the header (again the
  reason the proxy deployment forces the panel to loopback).
- The default is deliberately low; the server test suite and the Playwright suite raise
  `DOCKYARD_LOGIN_RATE_MAX` because they sign in many accounts from one address.
- `POST /api/auth/bootstrap` does **not** opt in to the limiter. It is unthrottled while
  the users table is empty, which is the state in which it is reachable at all.
- There is no account lockout beyond this rolling per-minute budget. A slow, distributed
  attempt is not blocked by it.

Login also equalizes timing so it does not reveal whether an account exists: an unknown
email still runs a dummy scrypt verify (`routes/auth.ts:100-101`, `auth/password.ts:74-83`).

## The role ladder

Three roles, ranked in `server/src/auth/rbac.ts:30`:

```
viewer (1)  <  operator (2)  <  admin (3)
```

Enforcement is centralized in the `requireRole(min)` preHandler (`rbac.ts:112-122`), used
as a Fastify `preHandler` on every route rather than as ad-hoc checks inside handlers.
`requireAuth()` is an alias for `requireRole('viewer')` (`rbac.ts:125-127`). The guard
returns:

- `401 unauthorized` when there is no valid session (`rbac.ts:116`).
- `403 forbidden` when the session is valid but the role is too low (`rbac.ts:119`).

What each role may do, read from the route preHandlers:

- `viewer`: reads. List and detail routes for containers, images, volumes, networks,
  tunnels, templates, logs, stats (`routes/containers.ts:123`, `:145`, `:152`, `:213`,
  `:226`; `routes/images.ts:27`; `routes/volumes.ts:27`; `routes/networks.ts:21`).
- `operator`: writes that are not deletes and not account or settings changes. Create a
  container (`containers.ts:129`), start/stop/restart/kill/pause (`containers.ts:159`),
  pull an image (`images.ts:35`), create a volume or network (`volumes.ts:34`,
  `networks.ts:28`), create or act on a tunnel (`routes/tunnels.ts:85`, `:113`).
- `admin`: everything, including deletes (`containers.ts:196`, `images.ts:42`,
  `volumes.ts:42`, `networks.ts:39`, `tunnels.ts:130`), user management and grants
  (all of `routes/users.ts`), settings and Cloudflare credentials (all of
  `routes/settings.ts`), and reading the audit log (`routes/audit.ts:17`).

Two invariants keep an admin from locking the panel out of itself, both in
`routes/users.ts`:

- The last admin can never be demoted or deleted (`users.ts:138`, `users.ts:195`).
- An admin can never be scoped: setting `scope_mode = 'granted'` on an admin is rejected
  (`users.ts:106-108`, `users.ts:145-147`, `users.ts:228-230`), and `loadScope` returns
  the unrestricted scope for an admin regardless of the row (`auth/scope.ts:156-160`).

## Per-user resource scoping

The role ladder decides what a user may **do**; `users.scope_mode` separately decides what
they may **see** (`server/src/auth/scope.ts`, and the "Resource allocation" section of the
root `README.md`). The default is `all`: every authenticated user sees the whole host
(`db/schema.ts:54`). `granted` means exactly the resources matched by the user's rows in
`user_grants`, nothing else.

A grant matches by one of two forms, never both (`db/schema.ts:230-233`):

- An explicit `resource_id`, matched against a resource's id, name, slug or image repo
  tag, with a leading id prefix of at least 12 characters also accepted
  (`scope.ts:89-102`).
- A `label_key` / `label_value` pair, matched against the resource's labels
  (`scope.ts:105-109`).

Enforcement lives at the route boundary:

- List endpoints filter with `filterVisible` (`scope.ts:125-133`; for example
  `containers.ts:126`, `images.ts:31`, `volumes.ts:31`, `networks.ts:25`).
- Per-id endpoints answer **404** for a resource the caller may not see, via `denyScoped`
  (`scope.ts:185-187`; used at `containers.ts:115-118`, `tunnels.ts:106`).

The 404 rather than 403 is deliberate, and it is the interesting part of this control. A
`403` confirms the resource exists, which lets a restricted user enumerate the host by
probing ids. `denyScoped` words the response exactly like a genuine miss
(`no container matches '<id>'`), so a scoped-out resource and a nonexistent one are
indistinguishable.

Two supporting behaviors:

- A scoped user's newly created resources inherit their grant label, so the user can
  still see what they just made (`scope.ts:142-150`; applied at `containers.ts:133-134`,
  `volumes.ts:36`, `networks.ts:30`). Without this a scoped user would create a container
  and immediately lose sight of it.
- Adding the first grant to a user flips them to `scope_mode = 'granted'` automatically,
  because a grant on an unscoped user would otherwise do nothing (`users.ts:244-249`).

Caveats, stated plainly:

- A **name** grant breaks when the resource is renamed or recreated, because the name no
  longer matches. The label form survives a recreate. This is called out in the root
  `README.md` and is why the label form exists.
- Clearing every grant leaves the user with nothing visible; flipping back to `all` is a
  separate, explicit change (`users.ts:279-287`).
- **The WebSocket routes do not apply the scope filter.** `/ws/containers/:id/logs`
  (`server/src/ws/logs.ts`) and `/ws/containers/:id/stats` (`server/src/ws/stats.ts`)
  authenticate via the session cookie and reject an anonymous upgrade with close code
  `4401`, but they resolve the container by id/name and stream it without a `canSee`
  check. `/ws/events` (`server/src/ws/events.ts`) subscribes any authenticated client to
  the global in-process event bus, which carries every container, tunnel and stack event,
  with no per-user filtering. So a `granted`-scoped user can still read the logs and live
  stats of a container they cannot see over REST, and sees the event stream for the whole
  host. REST scoping is the enforced surface; the streaming surface is not yet covered by
  it.

## The `can_exec` flag

`POST /api/containers/:id/exec` is gated on the `users.can_exec` flag rather than on the
operator role (`server/src/routes/containers.ts:233-248`). The reasoning is in the code:
the panel mounts the Docker socket, so a shell in any container is root on the host, and
that should be an explicit grant rather than a side effect of being able to restart
things.

`canExec` (`server/src/auth/scope.ts:173-179`) resolves as:

- Admins always may exec.
- Otherwise the account must be an `operator` **and** have `can_exec = true`.
- The column defaults to `false` (`db/schema.ts:55`), so the flag is opt-in per user.
- A `viewer` cannot reach the route at all, since it requires the `operator` role; the
  flag is only meaningful for operators.

A denied exec returns `403 forbidden` with `exec is not enabled for this account`
(`containers.ts:240`). Every successful exec is audited with its command
(`containers.ts:246`).

## Secrets encrypted at rest

`server/src/secrets.ts` is AES-256-GCM. The key is 32 bytes decoded from `config.secretKey`
(`secrets.ts:29-47`), which is `SECRET_KEY`, expected as 64 hex characters
(`config.ts:56`). The stored blob format is exactly `v1:<ivB64>:<tagB64>:<ctB64>`
(`secrets.ts:49-61`), with a fresh 12-byte IV per encryption.

What `SECRET_KEY` protects: values written to the `settings` table with `secret = true`.
Today that is the Cloudflare API token, stored under the key `cloudflare.api_token` as an
encrypted blob (`routes/settings.ts:203`). The token is never returned by the API: the
wire carries only `maskSecret(...)` (`settings.ts:95`) plus configured and verified flags,
and the Cloudflare client logs only a fingerprint (`cloudflare/api.ts:8`, `secrets.ts:117-119`).
`maskSecret` shows at most the first and last four characters, and fully masks anything of
eight characters or fewer (`secrets.ts:108-114`).

What `SECRET_KEY` does **not** protect, so it is not a master password:

- `POSTGRES_PASSWORD`, and the `DATABASE_URL` that embeds it, live in the environment in
  plaintext (`docker-compose.yml:49`).
- `DOCKYARD_ADMIN_PASSWORD` is a credential in `.env` (refer to it by location; never
  print its value).
- Session tokens are stored as SHA-256 hashes, not encrypted (`sessions.ts:32-38`).
- The Docker socket and everything reachable through it.
- The `.env` file itself.

Caveats:

- Rotating `SECRET_KEY` makes existing stored secrets undecryptable, because decryption
  uses the current key and GCM authentication then fails with a `SecretError`
  (`secrets.ts:93-100`). Per the root `README.md`, this invalidates stored secrets and
  nothing else. Re-enter the Cloudflare token after a rotation.
- If `SECRET_KEY` is unset, `config.ts` silently generates a random 32-byte key at boot
  (`config.ts:185-186`). Encryption then "works", but the key changes on every restart,
  so anything encrypted in one process cannot be decrypted by the next. `docker-compose.yml`
  refuses to start without `SECRET_KEY` (`docker-compose.yml:50`), which is what keeps a
  compose install out of this state.
- A `SECRET_KEY` that is not 64 hex characters is accepted: the key is derived by
  SHA-256 of the raw string, with a warning logged (`secrets.ts:41-45`). This still yields
  a deterministic key, but it is weaker than a random 256-bit value.

## The audit log

Every mutating route writes a row to `audit_log` before it responds (`auth/audit.ts:3`),
through `audit()` / `auditFromRequest()` (`audit.ts:42-72`). Columns are `user_id`,
`action`, `target_type`, `target_id`, `detail` (jsonb), `ip`, `created_at`
(`db/schema.ts:87-110`).

- `detail` is passed through `redact()` before being serialized (`audit.ts:44`), so a
  value under a key matching `/token|password|secret|key|authorization/i` is masked before
  it can be persisted. The same `redact()` backs the logger (`server/src/logger.ts:19`,
  `:22-49`).
- `ip` is `req.ip` (`audit.ts:52-54`), which is `X-Forwarded-For`-derived when
  `trustProxy` is on.
- The read API is admin-only (`routes/audit.ts:17`).
- The `user_id` foreign key is `on delete set null` (`db/schema.ts:104-108`), so audit
  rows survive deletion of the user who acted, with the actor shown as null rather than
  the row disappearing.
- Login success and failure, logout, bootstrap, and every create/update/delete of a
  container, image, volume, network, tunnel, user, grant, and setting are recorded
  (`routes/auth.ts:64-71`, `:104-111`, `:119-126`, `:135-141`; and the mutating routes
  above).

Caveats:

- Redaction is key-name based. A secret placed under a key that does not match the
  pattern is not masked, so this is a backstop against accidental logging, not a proof
  that no secret can be logged.
- The audit log covers mutations and authentication events. It does not record reads:
  listing containers, reading logs or stats, or streaming events is not audited, so the
  log is a change history, not a full access log.
- An audit write failure propagates to the caller (`audit.ts:41`); it is not swallowed.

## The bootstrap race on a fresh install

`POST /api/auth/bootstrap` is public and creates an admin, and it is available **only
while the users table is empty** (`server/src/routes/auth.ts:46-51`): as soon as any user
exists it returns `409 conflict` (`auth.ts:49-51`). On a fresh install with no account,
the first caller to reach the route creates the first admin and receives a session
(`auth.ts:53-73`).

Combined with the default `0.0.0.0` publish, that is a race: whoever finds the port first
before an account exists wins the host. The installer closes the window by **generating
an admin password by default and printing it once**, so the users table is non-empty
before the port is exposed; `--no-admin` takes the race deliberately (root `README.md`,
"Install on a server"). The route is also not rate limited (see above), so the only thing
stopping it is that it stops working the moment a user exists.

There is a second, quieter path to the same first account: `ensureFirstBootAdmin()`
(`server/src/index.ts:21-32`) creates an admin at boot when both `DOCKYARD_ADMIN_EMAIL`
and `DOCKYARD_ADMIN_PASSWORD` are set and the users table is empty. The password is
hashed and never logged (`index.ts:26`, `index.ts:31`). If neither is set, this path is a
no-op and the panel relies on the bootstrap route or a pre-existing account.

If you deploy without generating an account and without setting the admin variables, do
it on `127.0.0.1` until the first account exists, then expose it.

## Logging and credential hygiene

- The logger masks any key matching `/token|password|secret|key|authorization/i`
  (`server/src/logger.ts:19`, `:22-49`). `secrets.ts` states the rule it depends on: a
  secret value must never appear in a log line, an API response, or an error message, and
  only `maskSecret` / `fingerprint` output is safe to surface (`secrets.ts:6-7`).
- Public user shapes never carry `password_hash`: `publicUser()` projects only id, email,
  role, scope, `can_exec` and timestamps (`auth/rbac.ts:52-71`).
- `.env` should be mode `0600` and must never be committed (root `README.md`). The
  checkout's `.env` is `0600`.
- The updater's repository credential is deliberately read-only. The root `README.md`
  and `dockyard-panel` notes record that a compromise of a Docker-socket control plane
  should not yield write access to the repository, so the host uses a read-only deploy
  key rather than the panel's update token.

## What is not protected

To be concrete about the boundary:

- Once a user is authenticated at `operator` or `admin`, they are host root. The role
  ladder limits reads for `viewer`, and separates exec from other operator actions, but it
  does not sandbox an operator.
- The WebSocket streaming surface (logs, stats, events) enforces authentication but not
  resource scoping, unlike the REST surface.
- The per-IP login limit and the recorded audit IP depend on `X-Forwarded-For` being set
  by a trusted proxy, not by the client.
- Plain-HTTP deployments send the session cookie in the clear; `NODE_ENV=development` is
  the only way to run that way, and it does not change any other control.
- Postgres, the Docker daemon, and the host-side updater are trusted. Their compromise is
  outside the panel's control.
