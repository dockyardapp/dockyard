# Dockyard

A unified control panel for Docker containers. Portainer's job, without Portainer's
surface area: **containers, app templates, and Cloudflare tunnels** on one screen, backed by
Postgres.

- **Node.js + TypeScript** API (Fastify, run directly by Node's native type stripping, no build step)
- **Postgres** for users, sessions, audit trail, templates, stacks and tunnel state
- **React 19 + Vite** frontend, hand-written CSS, no UI framework
- **Docker Engine API** over the socket via `dockerode` (no `docker` CLI dependency)
- **Built-in Cloudflare tunnel support** in both flavours:
  - *non-persistent* (quick) — one click, no Cloudflare account, a `*.trycloudflare.com` URL
    that lives until you stop it
  - *persistent* (named) — a real named tunnel with its own credentials, config file and DNS
    route, restarted automatically when the panel boots

![Dockyard](docs/preview.png)

## Quick start (local)

```bash
cd dockyard
cp .env.example .env            # fill in DATABASE_URL, SECRET_KEY, admin credentials
npm install
node server/src/db/migrate.ts   # create the schema
node server/src/index.ts        # API + built frontend on http://localhost:8000
```

Frontend development runs Vite on `:5190` and proxies `/api` and `/ws` to `:8000`:

```bash
npm --workspace web run dev
```

## Install on a server

One script takes a fresh Linux host to a running panel. It installs Docker Engine with the Compose
plugin, git, curl and openssl, generates the secrets, writes `.env`, builds the images, starts the
panel and waits until the API answers before it reports success.

```bash
curl -fsSL https://raw.githubusercontent.com/dockyardapp/dockyard/main/install.sh | sudo bash
```

Or from a checkout you already have, which installs in place so the updater has a clone to pull:

```bash
sudo ./install.sh
```

It supports `apt`, `dnf`, `yum` and `zypper`, and is safe to re-run: an existing checkout is reused,
an existing `.env` is never rewritten, and the image is rebuilt from whatever the checkout holds. The
useful flags are `--dir`, `--port`, `--bind`, `--public-url`, `--email`, `--password`, `--no-admin`,
`--no-updater` and `--dry-run`; `--help` lists them all with the reasoning.

Two decisions in it are worth knowing about, because both are about the panel's blast radius:

- **It generates an admin password by default**, and prints it once. The panel mounts the Docker
  socket, so anyone who can sign in has root-equivalent control of the host, and while the users table
  is empty the bootstrap route is open. An install published on a public address with no account set
  is a race that whoever finds the port first wins. `--no-admin` takes that race deliberately.
- **It publishes on `0.0.0.0` by default**, and warns about it. `--bind 127.0.0.1` keeps the panel on
  the host, which is what you want when a tunnel or a reverse proxy is the only intended way in.

## Quick start (Docker Compose)

The same thing by hand, if you would rather see each step:

```bash
export POSTGRES_PASSWORD="$(openssl rand -hex 16)"
export SECRET_KEY="$(node -e 'console.log(require("crypto").randomBytes(32).toString("hex"))')"
# The panel image runs as uid/gid 1001 and /var/run/docker.sock is root:docker
# 0660, so it needs the host's docker group id to open the socket.
export DOCKER_GID="$(getent group docker | cut -d: -f3)"
docker compose up -d --build
```

`PANEL_PORT` chooses the host-side port (default 8000) and `PANEL_BIND` the address it is published
on (default `0.0.0.0`; use `127.0.0.1` when a tunnel or proxy is the only intended way in). The panel
itself always listens on 8000; the only deployment that differs is one behind a tunnel, which
publishes it on **80** instead. `PUBLIC_URL` should match whatever you publish, because the UI uses
it for the links it shows.

The compose file mounts `/var/run/docker.sock` into the panel and sets
`TUNNEL_TARGET_HOST=host.docker.internal` so tunnels can reach containers' published ports from
inside the panel's own container.

## How it is put together

```
server/src/
  index.ts      boot: config -> migrate -> buildApp -> listen
  app.ts        Fastify instance, plugins, routes, SPA fallback
  config.ts     env + .env loading
  db/           pg pool, Drizzle schema and the migration runner
  docker/       Docker Engine API service layer (containers, images, volumes, networks, stats)
  auth/         scrypt password hashing, session cookies, roles, audit log
  routes/       one file per resource, mounted under /api
  ws/           log tail, live stats and a global event stream
  tunnels/      tunnel supervision: cloudflared (quick, named) and localtunnel
  cloudflare/   Cloudflare API v4 client
  templates/    template spec, deploy engine, file and repository sources
web/            React app (see web/DESIGN.md for the design system)
```

### Database and migrations

The schema is defined once, in TypeScript, with [Drizzle](https://orm.drizzle.team):
`server/src/db/schema.ts`. `drizzle-kit` generates the SQL from it into `server/drizzle/`, and the
server applies that at boot through Drizzle's migrator, so starting the panel is also migrating it.

```bash
cd server
npx drizzle-kit generate      # after editing schema.ts: writes server/drizzle/NNNN_name.sql
```

Changing the schema means editing `schema.ts` and generating, not writing SQL by hand. The generated
baseline migration is written entirely with `IF NOT EXISTS` and declares every constraint inline, so
it is a no-op against a database that already has the tables. That matters more than it sounds: the
migrator runs any migration it has not recorded, and a database that predates Drizzle has no journal
at all, so the first boot after an upgrade applies the baseline to a fully populated schema. Being a
no-op there is the expected outcome, not a failure.

`scripts/diff-schema.mjs` is the check for that. It builds a throwaway database from the migrations
and compares it, table by table, column by column, constraint by constraint, against a reference
database, then exits non-zero if anything differs:

```bash
node scripts/diff-schema.mjs            # server/drizzle vs the database named in DATABASE_URL
node scripts/diff-schema.mjs --keep     # leave the throwaway database for inspection
```

The reference database is read-only; only the throwaway is written to and dropped.

### API

Everything lives under `/api` and is documented in [`CONTRACT.md`](CONTRACT.md), which is the
frozen interface the whole project was built against. Highlights:

```
GET    /api/system/info
GET    /api/containers                 POST /api/containers
POST   /api/containers/:id/:action     GET  /api/containers/:id/logs
GET    /api/templates                  POST /api/templates/:slug/deploy
GET    /api/tunnels                    POST /api/tunnels
POST   /api/tunnels/:id/:action
GET    /api/cloudflare/status          POST /api/cloudflare/credentials
GET    /api/users                      POST /api/users/:id/grants
```

WebSocket endpoints: `/ws/containers/:id/logs`, `/ws/containers/:id/stats`, `/ws/events`.

### Roles

`viewer` reads, `operator` writes (no deletes, no settings), `admin` does everything. The first
user is created from `DOCKYARD_ADMIN_EMAIL` / `DOCKYARD_ADMIN_PASSWORD` on first boot, or through
`POST /api/auth/bootstrap` while the users table is empty. Every mutating call lands in
`audit_log`.

A new password must be at least 8 characters. That minimum is enforced by the API, not just by the
forms: `POST /api/auth/bootstrap`, `POST /api/users` and `PATCH /api/users/:id` all reject a shorter
one with `validation_error`. Sign-in deliberately does not apply it, so an account whose password
predates the rule can still get in and change it. The number lives in
`server/src/auth/password.ts`; `web/src/lib/password.ts` mirrors it for the forms, and
`server/test/password-rules.test.ts` fails if the two drift.

### Resource allocation

The role ladder decides what a user may **do**. It does not decide what they may **see** — by
default every authenticated user sees the whole host. `users.scope_mode` adds that second axis:

- `all` (the default) — the whole host, unchanged from before.
- `granted` — exactly the resources listed in `user_grants`, nothing else.

A grant is either an explicit resource (`resource_id`) or a label selector (`label_key` +
`label_value`), never both.

The admin UI defaults to the explicit form because it needs no vocabulary: pick the user, tick the
resources they should have. A grant written that way stores the resource's **name** (or slug, or
image tag), so the allocation list reads as `dy-demo-app` rather than a 64 character digest.

```
GET    /api/users/:id/grants            list the allocation
POST   /api/users/:id/grants            allocate one resource
DELETE /api/users/:id/grants/:grantId   revoke one
DELETE /api/users/:id/grants            revoke all
```

Enforcement lives at the route boundary: list endpoints filter, per-id endpoints answer `404`.
A scoped-out resource returns `404` rather than `403` on purpose, because a `403` confirms the
resource exists and would let a restricted user enumerate the host by probing ids. Dashboard
counts are recomputed for a scoped user, since the engine totals describe the whole host.

Two consequences follow from a name grant, and both are why the label form still exists (it sits
under **Advanced** in the dialog, one click away):

- Renaming or recreating the resource drops the grant, since the name no longer matches.
- A resource the user creates themselves is *not* granted, so it stays hidden until an admin ticks
  it. A label grant does not have this problem: it keeps matching through a recreate, and anything
  the user creates afterwards inherits the label, so their own work stays visible (a container they
  run, a volume they add, a stack they deploy from an allocated template).

Two things are deliberately not on the ladder:

- **Admins are never scoped.** Setting `scope_mode = 'granted'` on an admin is rejected, so there
  is always one account that can undo a bad allocation.
- **`exec` is not an operator right.** The panel mounts the Docker socket, so a shell in any
  container is root-equivalent on the host. It needs the explicit `users.can_exec` flag;
  administrators bypass it. The flag only applies to operators, since the route requires that role
  anyway.

An allocated user sees a notice at the top of every page explaining why their lists are short,
because an unexplained empty panel reads as a bug.

## Templates

The catalog is not compiled into the panel. It is pulled from a public repository of template JSON
(see below), which is where the templates live, so a new one reaches every install without a
release. Deploying a template renders it with your values, creates the container, starts it, and
records a stack so the whole thing can be started, stopped or removed as a unit. Containers created
by Dockyard are labelled:

```
dockyard.managed=true
dockyard.stack=<stack id>
dockyard.template=<template slug>
```

so the panel can tell its own containers apart from anything else on the host. User templates can
be created, edited and deleted from the UI and are validated against the same spec schema.

The deploy form is where you supply the values a template asks for, and the **host port** is the one
worth a second look. A template declares the port inside the container; the host port is what you
reach it on from outside and what a tunnel forwards to, so it is yours to choose. Publish it
wherever you like, and a port that another running container already holds is flagged in the form
rather than failing at the daemon. If you are going to tunnel the container, a high port is easier to
keep track of and less likely to be taken.

Volumes work the same way round: give a path and the container bind-mounts it, or leave it blank and
Dockyard gives the container a named volume of its own, so the data outlives the container.

Each template card shows the deployed product's real logo, and nothing else: no emoji anywhere in
the product. The marks are vendored, not fetched at runtime, so the panel works with no outbound
access. `web/src/components/templateLogos.ts` is generated; to change it, see the header of
`scripts/gen-template-logos.py`. A product with no mark falls back to the template's own `icon`,
which names one of the app's glyphs rather than carrying a pictograph.
`server/test/template-logos.test.ts` fails if the repository ships a template whose product has no
mark, so adding one is a deliberate act with a reason.

### Templates from a file

A template does not have to come from the repository. Put a `*.json` file in the template directory
and it appears in the list on the next page load, with no rebuild and no restart:

```sh
mkdir -p data/templates
cp deploy/template-examples/gitea.json data/templates/
```

The directory is `DOCKYARD_TEMPLATE_DIR`, which defaults to `<repo>/data/templates` and is a
bind mount in `docker-compose.yml`, so the file goes on the host next to the compose file.
`deploy/template-examples/` has one of each accepted shape (a bare spec in `gitea.json` and
`vaultwarden.json`, an array in `two-services.json`, and a `{ "templates": [ ... ] }` pack in
`pack-homelab.json`) plus a field reference.

These templates show up as `source: file` and carry a **from a file** tag. The rules:

- A file beats the repository's copy of the same slug, so a repository template can be retagged
  without touching the repository. Delete the file and the repository's copy comes back.
- A file never overwrites a template you edited in the panel.
- Deleting a file removes the template it defined.
- Naming a file with a leading `.` or `_` parks it: ignored, but still on disk.
- A malformed file is reported and skipped. The other files still load and the panel still
  starts, so one typo cannot take the catalog down.

The Templates page has a **Template sources** card listing every file, what came out of it, and
the validation error for any that failed. Administrators get a **Reload files** button that
re-reads the directory immediately. `GET /api/template-files` returns the same thing, and
`POST /api/template-files/reload` forces a reconcile.

### Templates from the repository

The same files, without you having to copy them around. The panel pulls a public repository of
template JSON and reconciles it exactly like a local directory, so a template added or corrected
there reaches every install on the next refresh. No release, no rebuild, no restart.

The collection is [dockyardapp/dockyard-templates](https://github.com/dockyardapp/dockyard-templates),
and it is the whole catalog: the panel compiles none of it in, so a fresh install has whatever that
repository holds. To add a template to every Dockyard in the world, open a pull request there.

```sh
DOCKYARD_TEMPLATES_REPO=dockyardapp/dockyard-templates   # empty switches it off
DOCKYARD_TEMPLATES_BRANCH=main
DOCKYARD_TEMPLATES_REFRESH_MINUTES=15                   # how often a page load may refresh
DOCKYARD_TEMPLATES_DIR=/app/data/templates-remote       # the cache
DOCKYARD_TEMPLATES_TOKEN=                               # only for a private repo or a higher limit
```

These templates show up as `source: remote` and carry a **from the repo** tag. The rules, in
precedence order:

- A template you edited in the panel always wins, and is reported as skipped rather than
  overwritten.
- A local file beats the repository. Delete the file and the repository version comes back.
- The repository is the lowest source: it never overwrites a local file or a template edited in the
  panel. Correcting a repository template means changing it there.
- **A failed fetch never removes a template.** The previous cache keeps being served.
- **A pull is all or nothing.** One unreadable file fails the whole pull, so the cache is either
  the old commit's contents or the new one's, never a mixture.

Administrators get a **Pull now** button, which ignores the refresh window.
`POST /api/template-remote/pull` does the same over the API.

The repository may be public, so no token is needed: the anonymous GitHub API allows 60 requests
an hour per address and the default refresh uses about four. `DOCKYARD_TEMPLATES_TOKEN` raises
that, and is what a private repository would need. The token is never logged or returned; the API
reports only whether one is set.

## Tunnels

Three ways to reach a container from outside. The end user picks one per tunnel.

| | quick | named | localtunnel |
|---|---|---|---|
| Account needed | none | Cloudflare | none |
| URL | random `*.trycloudflare.com` | your own hostname on your zone | random `*.loca.lt` |
| Survives panel restart | no | yes, if `auto_start` is on | no, the URL is reassigned |
| Credentials on disk | none | `data/tunnels/<slug>/credentials.json` | none |

Localtunnel is the lightest of the three to set up and the least durable: localtunnel.me assigns
the URL and it changes on every start. The tunnel name is offered as a subdomain, so a restart
sometimes lands on the same URL. The client is a library rather than a child process, so the panel
opens the tunnel in-process and the tunnel has no pid.

Two things to know before handing a `*.loca.lt` URL to someone:

- A browser visitor is shown a localtunnel.me reminder page before the target loads, and has to
  enter the tunnel host's **public IP** to continue. The page appears once per visitor IP every
  7 days, and it displays that public IP to the visitor. Plain HTTP clients (curl, webhooks, API
  callers) are not gated and get the target straight away.
- It is a third-party service, so a loca.lt URL is only as available as localtunnel.me is.

Use quick or named when the link is going to a person; localtunnel suits machine-to-machine access
where nobody has to click through.

Named tunnels need an API token with `Account: Cloudflare Tunnel:Edit` and `Zone:DNS:Edit`. Add it
in **Settings** (stored AES-256-GCM encrypted in the `settings` table) or via
`CLOUDFLARE_API_TOKEN` / `CLOUDFLARE_ACCOUNT_ID`. The token is never returned by the API and never
logged.

## Version and updates

The panel shows the build it is running in the top bar of every page (`v0.2.1 · 01638e1`), and the
full detail on **Settings**: version, commit, build time, source repository and branch. The badge
links there.

Updates are pulled from GitHub and applied by a script on the host, because a container cannot
replace its own image. The panel writes `data/update/request.json`; a systemd path unit runs
`deploy/update.sh`, which fetches, checks the move is a fast-forward, resets the checkout, rebuilds
the image, recreates the container and waits for the health endpoint. If the new build does not come
up it puts the previous commit back and rebuilds that, so a bad commit costs one build rather than
an outage.

```bash
sudo ./deploy/install-updater.sh     # once, on the host, to wire up the button
./deploy/update.sh                   # or update by hand, any time
```

The deployed directory has to be a git checkout with an `origin` remote, because that is what the
updater pulls. A directory that was copied onto the host instead of cloned has nothing to pull, so
`install-updater.sh` checks and refuses rather than installing a button that cannot work.

Until the updater is installed the panel says so and leaves **Install update** disabled. A button
that silently does nothing is worse than a disabled one.

The check reads the GitHub compare endpoint, so a build made from a local commit ahead of origin is
not reported as an available update. While the repository is private the check needs
`DOCKYARD_UPDATE_TOKEN` (read-only is enough); once the repository is public the token is not
needed. Set `DOCKYARD_UPDATE_ENABLED=false` to take the feature out of the UI entirely.

Builds stamp the commit into the image via the `GIT_COMMIT` build argument, which `deploy/update.sh`
passes. A build made without it reports the commit as unknown rather than claiming to be current.

## Security notes

- Mounting the Docker socket gives the panel root-equivalent power over the host. Put it behind
  TLS and an authenticating proxy before exposing it.
- Sessions are opaque tokens; only a SHA-256 hash is stored. Passwords use scrypt.
- Secrets at rest (`cloudflare.api_token`) are encrypted with `SECRET_KEY`. Rotating `SECRET_KEY`
  invalidates stored secrets, nothing else.
- `.env` should be mode `0600` and must never be committed.

## Tests

```bash
export PATH=/root/.hermes/node/bin:$PATH
npm test                               # server: migrations, docker, api, tunnels, templates, scope
npm --workspace web run typecheck
npm --workspace web run test           # component and page tests (vitest)
npm --workspace web run build
npx playwright test --config web/playwright.config.ts   # end-to-end against a real API
```

`server/test/mock-docker.ts` is a test double that speaks the subset of the Docker Engine API this
panel uses, so the suite runs without a daemon. When a real daemon is reachable the tests exercise
it too — including the scoping tests, which create real containers and check that a scoped session
cannot list, inspect, stop or exec into one it was not allocated.

The end-to-end suite raises the login rate limit (`DOCKYARD_LOGIN_RATE_MAX`) because it signs in
many throwaway accounts from one IP. The shipped default stays at 10 per minute.
