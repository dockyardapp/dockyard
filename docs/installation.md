# Installation

## What you need

- A Linux host you have root on. The installer handles `apt` (Debian, Ubuntu), `dnf`/`yum` (RHEL,
  Fedora, Rocky, Alma) and `zypper` (openSUSE).
- Docker Engine with the Compose plugin. The installer installs both if they are missing.
- Ports 80 and 443 free, if you want nginx in front of the panel.
- For a certificate every browser trusts: a domain you control, with DNS pointing at the host and
  port 80 reachable from the internet. Nothing else on this list needs either.

The panel mounts the Docker socket, so it has root-equivalent power over the host. Read
[security.md](security.md) before you put it on a public address.

## Install

From the network:

```bash
curl -fsSL https://raw.githubusercontent.com/dockyardapp/dockyard/main/install.sh | sudo bash
```

From a checkout you already have, which installs in place:

```bash
sudo ./install.sh
```

Installing in place matters if you want the update feature. It pulls from an `origin` remote, so a
directory copied onto the host rather than cloned has nothing to pull, and
`deploy/install-updater.sh` refuses rather than installing a button that cannot work.

## The interactive setup

Run on a terminal, the installer asks the questions it cannot answer for you. It writes nothing
until the last screen, so you can back out at any point.

1. **How should the panel be reached?** Behind nginx with TLS (the recommended choice on a host with
   a public address), behind nginx with plain HTTP (for a host where something else terminates TLS,
   or one only reached over a tunnel), or directly with no proxy.
2. **What certificate?** Self-signed, which works immediately, or Let's Encrypt, which needs a domain
   and port 80.
3. **The name.** For Let's Encrypt it asks for the domain, and prints the DNS record to create. For a
   self-signed certificate it asks for the name on the certificate, pre-filled with the host's own
   detected address, so an IP is a valid answer.
4. **Which address should it listen on?** All interfaces, loopback only, or a specific address. This
   is the address the public door is published on: nginx when there is one, the panel otherwise.
5. **Which ports should nginx use?** The standard 80 and 443, or your own. This screen also tells you
   if the panel is about to move (see [Ports](#ports) below).
6. **The first account.** An email, then a password. Leave the password blank and one is generated
   and shown once at the end.
7. **A summary**, then confirmation.

**Flags pre-fill these screens, they do not skip them.** `--proxy` opens the reach question on nginx,
`--cert letsencrypt` opens the certificate question on Let's Encrypt, and so on, so every decision is
still shown before anything is written. `--no-tui` is what makes a run fully unattended. A piped
install with no terminal is unattended anyway, so `curl | bash` still installs with no prompts, and
`--dry-run` never stops for input.

## Flags

| Flag | Effect |
|---|---|
| `--dir PATH` | Install into `PATH` rather than the checkout or `/opt/dockyard`. |
| `--port N` | The panel's own port. Default 8000. |
| `--bind ADDR` | The address the public door is published on. With `--proxy` this names where **nginx** publishes, and the panel is forced to loopback. |
| `--public-url URL` | What the panel calls itself in the links it shows. |
| `--email ADDR` | The first account, and the Let's Encrypt contact address. |
| `--password VALUE` | The first account's password. Without it one is generated and shown once. |
| `--repo URL`, `--branch NAME` | Where to clone from. Defaults to the public repository and `main`. |
| `--no-admin` | Leave the admin account unset. See the bootstrap race in [security.md](security.md). |
| `--no-updater` | Skip the host updater, which leaves **Install update** disabled in the UI. |
| `--no-firewall` | Never touch the firewall, only report what it would need. |
| `--proxy` / `--no-proxy` | Put nginx in front of the panel, or do not. Off by default. |
| `--cert MODE` | `self-signed`, `letsencrypt` or `none`. Defaults to `none`, or `self-signed` with `--proxy`. |
| `--domain NAME` | The name or IP the panel is reached at, used for nginx and the certificate. |
| `--http-port N`, `--https-port N` | The host ports nginx is published on. Default 80 and 443. |
| `--tui` / `--no-tui` | Force the interactive setup, or never run it. |
| `--dry-run` | Print what would happen and change nothing. |
| `-h`, `--help` | The header comment of the script, which carries the reasoning for each flag. |

## Deployment modes

### Directly, with no proxy

The panel is the door, on `PANEL_BIND:PANEL_PORT`. It is plain HTTP, and the port it is published on
is a root-equivalent door because of the Docker socket. Use this on a trusted network, or with
`--bind 127.0.0.1` and something else in front.

### Behind nginx

`--proxy` adds an nginx service and stops publishing the panel on every interface: the panel moves to
`127.0.0.1:8000` and nginx becomes the only public door. That matters more than it sounds, because
the panel's published port controls Docker.

```bash
sudo ./install.sh --proxy --cert self-signed
```

With no `--domain`, the certificate is issued for the host's own detected address. A browser matches
an IP in a certificate the same way it matches a name, so this works on a host with no DNS at all.
The browser warns once until you accept the certificate, which is the whole of the tradeoff.

### With a Let's Encrypt certificate

This is the one mode that needs preparation, because the certificate authority has to confirm you own
the name. The installer asks for the domain and tells you the record to create:

```
type: A      name: <the name>      value: <this host's address>
```

Create that at your DNS provider, allow a few minutes for it to propagate, and make sure port 80 is
reachable from the internet. The contact address given as `--email` has to be one the authority will
accept: it refuses reserved domains such as `.local`, so no account can be registered and no
certificate will be issued. The installer checks this before writing anything rather than failing
later.

If issuance fails anyway, the installer falls back to a self-signed certificate for the same name
instead of leaving the panel on plain HTTP. That keeps TLS, the session cookie and the panel's own
links consistent, and you replace it by re-running once DNS is right.

### Behind a tunnel

A quick or named Cloudflare tunnel that targets `http://127.0.0.1:80` sits in front of nginx
automatically once the proxy is on. Cloudflare terminates TLS for a quick tunnel, so the correct
configuration behind one is `--cert none`:

```bash
sudo ./install.sh --proxy --cert none
```

Do not use the TLS template behind a quick tunnel. nginx would answer the tunnel's plain HTTP with a
redirect to `https://<host>`, the tunnel would forward that back to nginx on port 80, and it would
redirect again. See [troubleshooting.md](troubleshooting.md#the-site-loops-or-redirects-forever).

## Ports

The panel listens on 8000 inside its container. `PANEL_PORT` is the host port mapped to it.

With the proxy on, the panel must not want a port nginx publishes. On loopback those are the same
address, so a panel on 80 and nginx on 80 collide, and Compose aborts with `Bind for 127.0.0.1:80
failed: port is already allocated` after it has already recreated the panel. What that leaves behind
is worse than the error, and is described in
[troubleshooting.md](troubleshooting.md#the-site-returns-502-and-nginx-looks-like-it-is-running).

The installer avoids it: if `PANEL_PORT` is a port nginx is about to take, it moves the panel to
8000 (or the next free port) and says so, and it writes the new value into an existing `.env` so the
collision does not come back on the next `docker compose up`.

## Re-running

The installer is safe to re-run, and it is how you change a deployment's shape.

- An existing checkout is reused, and an existing `.env` is never rewritten.
- The proxy settings are the exception: a run that mentions nginx (`--proxy`, `--cert`, `--domain`,
  `--http-port`, `--https-port`) applies those keys to an existing `.env`, because they are what turn
  the nginx service on and off.
- `deploy/nginx/gen-cert.sh` leaves an existing, unexpired certificate alone unless you pass
  `--force`.
- nginx is recreated after the config is rendered, so the config it serves is the one just written.
  A reload cannot do this: the config is bind-mounted as a single file, so the container keeps the
  inode it started with.
- If the proxy is on, the install waits for nginx to answer before reporting success, and fails with
  nginx's own log if it does not.

## Verifying an install

From the host:

```bash
cd /opt/dockyard
docker compose ps                                   # db, nginx and panel should be up
docker exec dockyard-nginx-1 nginx -t               # the rendered config loads
curl -fsS http://127.0.0.1:8000/api/system/health   # the panel itself
curl -fsS http://127.0.0.1:80/api/system/health     # through nginx
```

To confirm the certificate nginx is actually serving, rather than the one on disk:

```bash
openssl s_client -connect 127.0.0.1:443 </dev/null 2>/dev/null | openssl x509 -noout -subject
```

## Next

- [configuration.md](configuration.md) for every environment variable.
- [troubleshooting.md](troubleshooting.md) for the failure modes worth knowing.
- [security.md](security.md) before exposing the panel.
