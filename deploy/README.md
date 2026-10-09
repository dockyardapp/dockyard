# Deploying Dockyard

The app is a single Node process that serves both the API and the built
frontend (`web/dist`), so the deployment is: build the frontend, run the server,
put nginx in front of it for TLS.

TLS is not optional here. The panel mounts the Docker socket, which is
root-equivalent control of the host, and in production the server refuses to
start unless it is told it is behind HTTPS.

## 1. Build and configure

```sh
npm install
npm --workspace web run build          # writes web/dist, which the server serves
npm run migrate                        # forward-only migrations
```

In `.env`, for a real host:

- `NODE_ENV=production`
- `COOKIE_SECURE=true` — the server **refuses to boot** with `NODE_ENV=production`
  and an insecure cookie, because that would put the session cookie on the wire
  in plaintext. Unset means "secure in production", so the failure mode is a
  refusal to start rather than a silent downgrade.
- `PUBLIC_URL=https://<host>` — used for the Cloudflare tunnel target and links.
- `SECRET_KEY` — 64 hex chars, `openssl rand -hex 24`.
- `DATABASE_URL`, `DOCKYARD_ADMIN_EMAIL`, `DOCKYARD_ADMIN_PASSWORD`.

Two directories are bind-mounted out of the deployment, so they belong on the host next to the
compose file:

```sh
mkdir -p data/update data/templates
```

`data/update` is where the panel leaves an update request for the host-side updater in
`deploy/update.sh`. `data/templates` is scanned for `*.json` template files: a template dropped
in there appears in the panel on the next page load, with no rebuild and no restart. Copy the
files in `deploy/template-examples/` to start from something real.

Nothing else needs creating for templates pulled from a repository. That cache lives in the
`dockyard-data` volume at `/app/data/templates-remote`, because it is the panel's own working copy
rather than something an operator edits. `DOCKYARD_TEMPLATES_REPO` chooses the repository and an
empty value switches the source off; see `.env.example`.

## 2. Reverse proxy and TLS

Copy `deploy/nginx.conf.example` to `/etc/nginx/sites-available/dockyard`, set
`server_name` and the certificate paths, symlink it into `sites-enabled`, then:

```sh
nginx -t && systemctl reload nginx
```

The shipped config is the TLS-terminating one: an HTTPS server block with the
locations, plus a port-80 block that redirects everything to HTTPS **except**
`/.well-known/acme-challenge/`. That exception is what keeps certificate renewal
working; redirecting it too is a common way to break certbot a month later.

To get the certificate:

```sh
certbot --nginx -d <host> --non-interactive --agree-tos --redirect
```

Two things to check before enabling HSTS. The config ships with it enabled, so
if you are unsure, comment the `Strict-Transport-Security` line out for the first
deploy: HSTS makes browsers refuse the plain-HTTP fallback, so a broken
certificate becomes unrecoverable without clearing browser state.

If you manage the certificate yourself rather than with certbot, note that
`ssl_certificate_key` must be readable by the nginx **worker** user (usually
`www-data`), not just by root. A key left at mode 600 root-only gives
`permission denied` at reload time.

If TLS terminates somewhere else (a load balancer, Cloudflare), use the variant
at the bottom of the config and set `COOKIE_SECURE=true` anyway. The browser is
what decides whether to send the cookie, and it only ever sees HTTPS.

The `/ws/` location matters: nginx's default 60-second read timeout drops an
idle event stream or log tail every minute, which shows up in the console as the
socket reconnecting on a timer.

## 3. Verify from outside

```sh
curl -sI https://<host>/                       # 200, and the security headers
curl -s  https://<host>/api/system/health      # {"ok":true,...}
curl -sI https://<host>/assets/<hashed>.js     # 200, immutable cache
curl -sI http://<host>/containers              # 301 to the https origin
```

Check the cookie is marked secure by signing in and inspecting the
`Set-Cookie` header: it must carry `Secure` and `HttpOnly`.

## 4. Updates

The panel can pull a newer build of itself, but it cannot replace its own container, so the work
happens on the host:

```bash
sudo ./deploy/install-updater.sh
```

That creates `data/update/`, gives it to the panel's uid so the container can write a request into
it, installs `dockyard-updater.service` and `dockyard-updater.path`, and writes the marker file the
panel reads to decide whether **Install update** can work. Re-running it is safe.

The updater works by pulling the deployed directory, so that directory has to be a **git checkout
with an `origin` remote**. A directory that was copied onto the host instead of cloned has nothing
to pull, so `install-updater.sh` checks for this and stops rather than installing a button that
cannot work. Give it a `.git` directory first:

```bash
git clone <repository> /tmp/dockyard-clone
mv /tmp/dockyard-clone/.git /opt/dockyard/.git
cd /opt/dockyard && git checkout -B main origin/main
```

A private repository also needs the host to authenticate the fetch, for **root**, because the path
unit runs as root: a deploy key via `GIT_SSH_COMMAND`, or a credential helper. The panel's own
`DOCKYARD_UPDATE_TOKEN` is only for the update *check*, which runs in the container.

From then on, pressing **Install update** on the panel's Settings page writes
`data/update/request.json`, the path unit fires, and `deploy/update.sh` runs:

1. fetch `origin/<branch>`, and refuse unless the move is a fast-forward of the running commit
2. `git reset --hard` the checkout (refuses first if it has local modifications; `--force` discards)
3. rebuild the panel image with `GIT_COMMIT` and `BUILD_TIME` set, then `docker compose up -d`
4. poll `http://127.0.0.1:${PANEL_PORT}/api/system/health` for up to 180s
5. on failure, reset to the previous commit, rebuild and restart that, and report `rolled-back`

Every step is written to `data/update/status.json` and `data/update/update.log`, which is what the
panel's update card renders. Watch a run with `systemctl status dockyard-updater` or
`tail -f data/update/update.log`.

No systemd on the host? `install-updater.sh` says so and leaves you a cron line instead. The
updater is also fine to run by hand at any time, with no panel involved.

## What the updater was verified against

Run against a real git remote with `docker` stubbed (33 assertions): the fast-forward guard, the
dirty-checkout refusal, the request handshake, the `--force` escape, and a **real rollback** where
the new build never answered its health endpoint and the previous commit was rebuilt and restarted.
A branch name from the request file that tries to reach a shell word is refused before it can.

Then on the deployment itself:

- the path unit fires when `request.json` appears, and `update.sh` runs to completion
- the fetch authenticates with a **read-only deploy key** on the host (not the panel's token), so a
  private repository updates without a credential in the panel
- the no-op path reports `success` / "Already at the tip" and writes `status.json` the card renders
- a real update pulls, rebuilds with the commit stamped in, restarts, and the panel reports the new
  version in `/api/system/info` and in the top bar

## What was verified

The config in this directory was run for real against a production-mode instance
(`NODE_ENV=production COOKIE_SECURE=true`) with a locally issued certificate, on
alternate ports. 19 of 19 server-side probes and 11 of 11 in a real browser:

- the chain verifies against the trust store with no `-k`, hostname included
- TLS 1.3 negotiated; TLS 1.0 and 1.1 refused
- plain HTTP returns `301` to the https origin
- `/.well-known/acme-challenge/` is served, not redirected
- HSTS and the four security headers present on the response
- the session cookie carries `Secure` and `HttpOnly`
- an authenticated call with that cookie returns `200`
- the events socket upgrades to `101` over TLS
- in Chrome: the certificate validates (TLS 1.3, correct SANs), the app renders
  with no interstitial, the socket connects over `wss`, and `document.cookie` is
  empty because the session cookie is httpOnly
- with `COOKIE_SECURE=false` under `NODE_ENV=production`, the process exits `1`
  and names the plaintext-cookie risk

## Known limits

- One process, one database. Nothing here assumes more than one replica.
- Migrations run on boot, which is correct for one instance and wrong for
  several: concurrent boots can collide. Move `npm run migrate` into the deploy
  step once there is more than one replica.
- The container healthcheck is in the `Dockerfile`; the updater's systemd units are in `deploy/`
  and installed by `deploy/install-updater.sh`. Nothing else assumes systemd.
- The updater rebuilds on the host, so a deployment with more than one replica needs the panel
  pinned to one before `Install update` means anything.
- The frontend's list views cap rendering at 250 rows per table
  (`useRowCap`); the audit log paginates instead.
- The live quick-tunnel test is opt-in (`npm run test:live`) because it needs a
  public hostname routed back to the machine, which CI usually cannot provide.
