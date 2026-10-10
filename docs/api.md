# Dockyard API reference

Derived from the route source under `server/src/`. Where the source and `CONTRACT.md`
disagree, the source is described and the difference is called out in
[Discrepancies with CONTRACT.md](#discrepancies-with-contractmd).

## Overview

- Base path: `/api` for all REST routes. WebSocket routes live under `/ws` with no `/api` prefix.
- Every response is JSON except `GET /api/containers/:id/logs`, which returns
  `text/plain; charset=utf-8` (`server/src/routes/containers.ts:223`).
- The frontend is served from the same origin. Any `GET`/`HEAD` that is not under `/api` or `/ws`
  returns `index.html` (SPA fallback, `server/src/app.ts:225`). Requests under `/api`, `/ws`, or
  `/assets/` that match no route return the standard 404 envelope.
- Request body limit is 1 MiB (`server/src/app.ts:100`).

## Authentication

Sessions are carried in a single cookie, not a bearer token.

- Cookie name: `dockyard_session` (`server/src/auth/sessions.ts:16`).
- Attributes: `httpOnly`, `sameSite=lax`, `path=/`, `secure` from `config.cookieSecure`,
  `maxAge` from the session TTL (default 168 hours / 7 days) (`server/src/auth/sessions.ts:61`).
- The token is 32 random bytes, base64url. Only `sha256(token)` is stored, so a database leak
  cannot be replayed (`server/src/auth/sessions.ts:32`).
- A session is resolved on every request by `authenticate()`; the query also checks
  `expires_at > now()` (`server/src/auth/sessions.ts:76`).
- Login timing is equalised: an unknown email still runs a dummy scrypt verify so response time
  does not reveal whether an account exists (`server/src/auth/password.ts:77`,
  `server/src/routes/auth.ts:101`).

`POST /api/auth/login` is rate limited to `config.loginRateMax` attempts per IP per minute
(default 10). Rate limiting is opt-in per route, not global (`server/src/app.ts:110`).

## Roles and scoping

Two independent axes decide access.

**Role** (`server/src/auth/rbac.ts:30`): `viewer` (1) < `operator` (2) < `admin` (3).
Enforced centrally by the `requireRole(min)` preHandler, never by ad-hoc checks in handlers.
`requireAuth()` is an alias for `requireRole('viewer')`.

- `401 unauthorized` when there is no valid session (`server/src/auth/rbac.ts:116`).
- `403 forbidden` when the session is valid but the role is too low (`server/src/auth/rbac.ts:119`).

**Scope** (`server/src/auth/scope.ts`): decides what a user may *see*, separately from what they
may *do*. `scope_mode` is `all` (whole host, the default) or `granted` (only resources matched by
a grant). A grant matches a resource by id/name/slug/repo tag, or by a label key/value pair.

- List endpoints filter with `filterVisible`.
- Per-resource endpoints answer `404 not_found` for a resource the caller may not see, worded
  exactly like a genuine miss so the caller cannot enumerate the host by probing ids
  (`server/src/auth/scope.ts:185`, used via `denyScoped`).
- Admins are never scoped. This is forced in `loadScope` regardless of the stored row
  (`server/src/auth/scope.ts:159`).
- Resources a scoped user creates inherit their grant label so they stay visible
  (`server/src/auth/scope.ts:142`).

`can_exec` is a per-user flag, separate from the role, that gates container exec
(`server/src/auth/scope.ts:173`). Admins always may.

## Error envelope

One shape for the whole API (`server/src/auth/rbac.ts:87`):

```json
{ "error": { "code": "validation_error", "message": "human readable", "details": {} } }
```

`details` is present only when supplied. Zod validation failures become `400 validation_error`
with an `issues` array (`server/src/app.ts:118`). Docker-layer errors carry their own status and
code; anything unmapped becomes `500 internal` and the stack is logged, never returned
(`server/src/app.ts:133`).

The `ErrorCode` union in code is: `unauthorized`, `forbidden`, `not_found`, `validation_error`,
`conflict`, `docker_error`, `docker_unavailable`, `internal` (`server/src/auth/rbac.ts:77`).

## Endpoints by resource

All paths below are shown with their full `/api` prefix.

### System

| Method | Path | Role | Body / query | Notes |
|---|---|---|---|---|
| GET | `/api/system/health` | public | none | `{ ok: true, uptime }` (seconds). |
| GET | `/api/system/info` | public | none | `SystemInfo`. When anonymous, `counts` is zeroed and `docker.containers` is omitted; scoped callers get recomputed counts instead of host totals (`server/src/routes/system.ts:207`). `mode` is `demo` when Docker is unreachable. |
| GET | `/api/system/update` | viewer | none | `UpdateStatus`. Always 200 with `build` present, even when the upstream check fails. `canUpdate` is true for admins. |
| POST | `/api/system/update` | admin | none | `202 { requested: true, request, job }`. Writes an update request to the spool; the panel does not rebuild itself. |

`POST /api/system/update` returns `409 conflict` when updates are disabled
(`DOCKYARD_UPDATE_ENABLED=false`), no updater is installed, the build is already current, ahead
or diverged, or the comparison is impossible (`server/src/routes/system.ts:301`). It returns
`503` with code `unavailable` when the spool directory is not writable
(`server/src/routes/system.ts:363`). See the discrepancy note on this code.

### Auth

| Method | Path | Role | Body | Notes |
|---|---|---|---|---|
| POST | `/api/auth/bootstrap` | public | `{ email, password }` | Creates the first admin. `200 { user }`. `409 conflict` as soon as any user exists (`server/src/routes/auth.ts:49`). Password min length 8. |
| POST | `/api/auth/login` | public | `{ email, password }` | `200 { user }`. Rate limited. `401 unauthorized` on bad credentials. |
| POST | `/api/auth/logout` | any | none | `200 { ok: true }`. Deletes the session and clears the cookie. |
| GET | `/api/auth/me` | public | none | `200 { user: PublicUser | null }`. Anonymous callers get `{ user: null }`. |

`PublicUser`: `{ id, email, role, scope_mode, can_exec, created_at, last_login_at }`
(`server/src/auth/rbac.ts:18`). Never includes `password_hash`.

### Users

Admin only.

| Method | Path | Role | Body / query | Notes |
|---|---|---|---|---|
| GET | `/api/users` | admin | none | `PublicUser[]` plus `grant_count`. |
| POST | `/api/users` | admin | `{ email, password, role, scope_mode?, can_exec? }` | `200 PublicUser`. `409` if the email exists or if `role=admin` with `scope_mode=granted`. |
| PATCH | `/api/users/:id` | admin | `{ role?, password?, scope_mode?, can_exec? }` | At least one field required. `200 PublicUser`. `404` unknown user. Changing `password` or `scope_mode` deletes that user's sessions. |
| DELETE | `/api/users/:id` | admin | none | `200 { ok: true }`. `404` unknown user. |
| GET | `/api/users/:id/grants` | admin | none | `Grant[]`. `404` unknown user. |
| POST | `/api/users/:id/grants` | admin | `{ resource_kind, resource_id?, label_key?, label_value? }` | `201 Grant`, or `200` when the identical grant already exists. Provide exactly one of `resource_id` or `label_key`. `409` if the target is an admin. Adding the first grant flips the user to `scope_mode=granted` and drops their sessions. |
| DELETE | `/api/users/:id/grants` | admin | none | `200 { ok: true, removed }`. Clears all grants; does not flip `scope_mode` back. |
| DELETE | `/api/users/:id/grants/:grantId` | admin | none | `200 { ok: true }`. `404` if the grant does not belong to the user. |

Invariants enforced: the last admin can never be demoted or deleted, and an admin can never be
scoped (`server/src/routes/users.ts:137`).

### Containers

`:id` accepts a full id, an id prefix, or a container name (`resolveContainer`).

| Method | Path | Role | Body / query | Notes |
|---|---|---|---|---|
| GET | `/api/containers` | viewer | `?all=1&q=` | `ContainerSummary[]`, filtered by scope. |
| POST | `/api/containers` | operator | `CreateContainerInput` | `201 { id, name }`. |
| GET | `/api/containers/:id` | viewer | none | `ContainerDetail`. |
| GET | `/api/containers/:id/inspect` | viewer | none | Raw Docker inspect. |
| POST | `/api/containers/:id/:action` | operator | action ∈ `start|stop|restart|kill|pause|unpause` | `200 ContainerDetail`. `400 validation_error` for an unsupported action, with `allowed` in details. |
| DELETE | `/api/containers/:id` | admin | `?force=1&volumes=1` | `200 { ok: true }`. |
| GET | `/api/containers/:id/logs` | viewer | `?tail=200&since=&timestamps=` | `text/plain`. `tail` default 200, max 100000. |
| GET | `/api/containers/:id/stats` | viewer | none | `ContainerStats`. |
| POST | `/api/containers/:id/exec` | operator | `{ cmd: string[] }` | Runs a command in the container. Requires `can_exec` (or admin); otherwise `403 forbidden` (`server/src/routes/containers.ts:239`). |

`CreateContainerInput`: `{ name, image, cmd?, entrypoint?, env?, ports?, volumes?, restartPolicy?,
labels?, network?, pull? }` (`server/src/routes/containers.ts:59`). `ports` entries are
`{ host?, container, proto? }`; `volumes` entries are `{ host?, container, mode? }`;
`restartPolicy` ∈ `no|always|unless-stopped|on-failure`.

A container outside the caller's scope answers `404 not_found`, identically to a genuine miss
(`server/src/routes/containers.ts:105`).

### Images

| Method | Path | Role | Body / query | Notes |
|---|---|---|---|---|
| GET | `/api/images` | viewer | none | `ImageSummary[]`, filtered by scope (images carry no labels, so only id or repo tag grants apply). |
| POST | `/api/images/pull` | operator | `{ ref }` | `200 { ok: true, ref }`. Can take up to about 120 seconds. |
| DELETE | `/api/images/:id` | admin | `?force=1` | `200 { ok: true }`. |

### Volumes

| Method | Path | Role | Body / query | Notes |
|---|---|---|---|---|
| GET | `/api/volumes` | viewer | none | `VolumeSummary[]`, filtered by scope. |
| POST | `/api/volumes` | operator | `{ name, labels? }` | `200 VolumeSummary`. |
| DELETE | `/api/volumes/:name` | admin | `?force=1` | `200 { ok: true }`. |

### Networks

| Method | Path | Role | Body | Notes |
|---|---|---|---|---|
| GET | `/api/networks` | viewer | none | `NetworkSummary[]`, filtered by scope. |
| POST | `/api/networks` | operator | `{ name, driver?, labels? }` | `200 NetworkSummary`. |
| DELETE | `/api/networks/:id` | admin | none | `200 { ok: true }`. |

### Templates

Reads reconcile the local template directory and the remote template repository before answering,
so a dropped file or a pushed template appears without a restart (`server/src/routes/templates.ts:158`).
`source` is one of `user`, `file`, `remote`.

| Method | Path | Role | Body / query | Notes |
|---|---|---|---|---|
| GET | `/api/templates` | viewer | `?category=&source=` | `Template[]`, filtered by scope. |
| GET | `/api/templates/:slug` | viewer | none | `Template`. `404` unknown or scoped out. |
| POST | `/api/templates` | operator | `{ spec }` | `201 Template`. `400` invalid spec, `409` slug exists. A scoped author is auto-granted the new template. |
| PATCH | `/api/templates/:slug` | operator | `{ spec }` | `200 Template`. `400` invalid spec, `404` unknown. |
| DELETE | `/api/templates/:slug` | admin | none | `200 { ok: true }`. `409 conflict` if the template is file- or remote-sourced (delete it at its source instead). |
| POST | `/api/templates/:slug/deploy` | operator | `{ name, values? }` | `201 { stack, container: { id, name } }`. `400` validation, `404` not found. Scoped users may only deploy granted templates. |
| GET | `/api/template-files` | viewer | none | `TemplateFilesStatus & { remote }`. Diagnostics for the file/remote catalog. |
| POST | `/api/template-files/reload` | admin | none | `200 TemplateFileSync & { status }`. |
| POST | `/api/template-remote/pull` | admin | none | `200 { pull, reconcile, cached, remote }`. Forces a repository pull regardless of the refresh window. |

`values` values may be string, number, or boolean; they are coerced to strings before deploy
(`server/src/routes/templates.ts:110`).

### Stacks

| Method | Path | Role | Body / query | Notes |
|---|---|---|---|---|
| GET | `/api/stacks` | viewer | none | `StackWithContainers[]`, filtered by scope. A stack is visible when granted directly or when any of its containers is. |
| GET | `/api/stacks/:id` | viewer | none | `StackWithContainers`. `404` unknown or scoped out. |
| POST | `/api/stacks/:id/:action` | operator | action ∈ `start|stop` | `200 StackWithContainers`. `400` unsupported action, `404` unknown. |
| DELETE | `/api/stacks/:id` | admin | `?volumes=1` | `200 { ok: true }`. `404` unknown. |

### Tunnels

| Method | Path | Role | Body | Notes |
|---|---|---|---|---|
| GET | `/api/tunnels` | viewer | none | `Tunnel[]`, filtered by scope. |
| POST | `/api/tunnels` | operator | `CreateTunnelInput` | `201 Tunnel`. |
| GET | `/api/tunnels/:id` | viewer | none | `Tunnel`. `404` unknown or scoped out. |
| POST | `/api/tunnels/:id/:action` | operator | action ∈ `start|stop` | `200 Tunnel`. `400` unknown action. |
| DELETE | `/api/tunnels/:id` | admin | none | `200 { ok: true }`. |

`CreateTunnelInput`: `{ name, mode, target_url?, container_id?, port?, hostname?, zone_id?,
auto_start? }` (`server/src/routes/tunnels.ts:21`). `mode` ∈ `quick|named|localtunnel`. Either
`target_url` or `container_id` is required; `hostname` is required when `mode=named`.

### Settings and Cloudflare

Admin only.

| Method | Path | Role | Body | Notes |
|---|---|---|---|---|
| GET | `/api/settings` | admin | none | `SettingsView`. Secrets are masked; non-secret settings are returned as a key/value map. |
| PATCH | `/api/settings` | admin | `{ settings: {...} }` or a flat object | `200 SettingsView`. `400` when empty or when it tries to set `cloudflare.api_token` (use the credentials route). |
| GET | `/api/cloudflare/status` | admin | none | `{ configured, verified, accountId, accounts, zones, error? }`. |
| POST | `/api/cloudflare/credentials` | admin | `{ apiToken?, accountId }` | `{ ok: true, verified, error? }`. Stores the token encrypted; it is never returned. |
| DELETE | `/api/cloudflare/credentials` | admin | none | `{ ok: true }`. Removes the stored token and account id. |

### Audit

| Method | Path | Role | Query | Notes |
|---|---|---|---|---|
| GET | `/api/audit` | admin | `?limit=100&offset=0&action=` | `AuditEntry[]`, newest first. `limit` is clamped to 1..500. |

`AuditEntry`: `{ id, user_id, user_email, action, target_type, target_id, detail, ip, created_at }`
(`server/src/auth/audit.ts:11`). Every mutating route writes a row before responding; `detail` is
passed through `redact()` first.

## WebSocket endpoints

Auth is the same session cookie on the upgrade request. An unauthenticated upgrade is closed with
code `4401` (`server/src/ws/logs.ts:22`). All frames are JSON text. These routes are registered
without the `/api` prefix (`server/src/app.ts:218`).

| Path | Server to client | Client to server |
|---|---|---|
| `/ws/containers/:id/logs?tail=200` | `{ "type": "log", "line": "..." }` repeated, then `{ "type": "end", "reason": "stream_ended"|"container_gone"|"error" }` | `{ "type": "ping" }` (keepalive; the server sends no reply) |
| `/ws/containers/:id/stats` | `{ "type": "stats", "stats": ContainerStats }` every 1500 ms | `{ "type": "ping" }` (keepalive; no reply) |
| `/ws/events` | `{ "type": "container"|"tunnel"|"stack", "action": "...", "data": {...} }` | none (one-way) |

Close codes:

- `4401` unauthenticated (`server/src/ws/logs.ts:22`).
- `1000` normal: `container gone` or `stream ended` (`server/src/ws/logs.ts:52`, `:78`).
- `1011` on a Docker or stream error (`server/src/ws/logs.ts:47`, `:62`).

The stats stream's interval timer is cleared on close (`server/src/ws/stats.ts:55`). The events
stream subscribes each authenticated client to the in-process bus and unsubscribes on close
(`server/src/ws/events.ts:33`).

Scope is NOT applied on the WebSocket routes: `logs`, `stats` and `events` check only that a
session exists, then serve the requested container or all bus events without a `canSee` check
(`server/src/ws/logs.ts:43`, `server/src/ws/stats.ts:39`, `server/src/ws/events.ts:33`). A scoped
user who knows a container id can therefore read its logs and stats over the socket even though
the REST equivalents 404. This looks like a gap rather than a deliberate choice; flagged for
review, not asserted as intended.

## Cross-cutting behaviour

- SPA fallback: non-`/api`, non-`/ws` `GET`/`HEAD` returns `index.html`; a missing `/assets/*`
  file returns 404 rather than HTML (`server/src/app.ts:225`).
- Route mounting: `auth`, `system`, `containers`, `images`, `volumes`, `networks`, `audit`,
  `users` are registered with prefix `/api` (`server/src/app.ts:200`). `tunnels`, `settings`,
  `templates`, `stacks` are loaded dynamically and skipped with a warning if the file is absent
  (`server/src/app.ts:209`). Because tunnels/settings declare absolute `/api/...` paths while
  templates/stacks declare bare paths, `apiPrefixFor()` inspects each module's source to decide
  whether to add the prefix, so all four still mount at `/api/...` (`server/src/app.ts:55`).
- `trustProxy` is on, so `req.ip` (used for rate limiting and audit) honours proxy headers
  (`server/src/app.ts:99`).

## Discrepancies with CONTRACT.md

1. `POST /api/system/update` can emit error code `unavailable` with status 503
   (`server/src/routes/system.ts:363`). `unavailable` is not in the frozen `ErrorCode` union
   (`server/src/auth/rbac.ts:77`) and not in the contract's code list, which uses
   `docker_unavailable` for 503 (`CONTRACT.md:376`).
2. The error handler maps HTTP 429 to code `rate_limited` (`server/src/app.ts:145`), which is also
   absent from the frozen `ErrorCode` union and from the contract's code list.
3. `POST /api/containers/:id/exec` requires `operator` (per contract) but adds a second gate:
   the account must also have `can_exec` (or be admin), else `403 forbidden`
   (`server/src/routes/containers.ts:239`). The contract lists only the role
   (`CONTRACT.md:401`).
4. `POST /api/users` and `PATCH /api/users/:id` accept `scope_mode` and `can_exec` in addition to
   the contract's `{email,password,role}` / `{role?,password?}` (`server/src/routes/users.ts:34`).
   The contract does not mention per-user scoping or the exec flag at all.
5. `GET /api/containers/:id/logs` also accepts a `timestamps` query parameter
   (`server/src/routes/containers.ts:73`), not listed in the contract.
6. The contract describes `GET /api/system/update` as min role "any" (`CONTRACT.md:435`); the code
   requires an authenticated session (`requireAuth()`, i.e. viewer) and rejects anonymous callers
   (`server/src/routes/system.ts:283`). `/api/system/info` is the public one.
7. Scope enforcement (grants, `scope_mode`, 404-for-scoped-out, grant-label inheritance) is
   implemented throughout the routes but is not described in the contract's REST table. It is a
   real part of the API surface.
