# Troubleshooting

The failure modes that actually happen, mostly around the reverse proxy and TLS. Each entry gives
the symptom, what it means, how to confirm it, and the fix.

## The site returns 502 and nginx looks like it is running

**Symptom.** The public address or the tunnel returns 502. `docker compose ps` reports nginx as `Up`.

**What it means.** nginx never joined the Compose network, so it cannot resolve the `panel` service
name and crash-loops. It is restarted on every crash, so `Up` is briefly true and the container looks
healthy in a listing.

**Confirm it.**

```bash
cd /opt/dockyard
docker inspect -f '{{range $k,$v := .NetworkSettings.Networks}}{{$k}} {{end}}' dockyard-nginx-1
docker logs dockyard-nginx-1 --tail 20
```

An empty network list is the tell. `host not found in upstream "panel"` in the log names it.

**Cause.** Usually a failed port bind. Compose aborts after it has already recreated the panel,
leaving nginx created but never attached to the network.

**Fix.**

```bash
docker compose up -d --force-recreate nginx
```

A plain `up -d` does not fix this. Compose considers the existing container correct, reports success,
and reuses it, so the broken container stays broken. Only `--force-recreate` re-resolves the network.

**Prevention.** The installer moves the panel off any port nginx publishes, and waits for nginx
itself to answer before it reports success, failing with nginx's own log if it does not.

## Bind for 127.0.0.1:80 failed: port is already allocated

**What it means.** The panel and nginx want the same loopback port. This happens on a host where
`PANEL_PORT` is 80, which is the tunnel configuration, because turning the proxy on moves the panel
to `127.0.0.1` while leaving its port alone.

**Confirm it.**

```bash
grep -E '^PANEL_PORT|^PANEL_BIND|^PROXY_HTTP_PORT' /opt/dockyard/.env
```

**Fix.** Move the panel:

```bash
cd /opt/dockyard
sed -i 's/^PANEL_PORT=.*/PANEL_PORT=8000/' .env
docker compose up -d
```

**Prevention.** Current versions of the installer detect the collision, move the panel to 8000 or the
next free port, apply the new value to an existing `.env`, and say so. It also refuses to leave the
half-created nginx container behind, which is what produces the 502 above.

## The certificate did not change after re-running with a different name

**Symptom.** You re-run with a new `--domain`, the rendered config on disk points at the new
certificate, but the browser still gets the old one and reports a hostname mismatch.

**What it means.** The config is written by rename, which swaps the inode, and `dockyard.conf` is
bind-mounted as a **single file**. A single-file bind mount resolves to an inode, so the container
keeps reading the old file. `nginx -s reload` reports success and changes nothing, because the
container cannot see the new file at all.

**Confirm what is actually being served**, rather than what is on disk:

```bash
openssl s_client -connect 127.0.0.1:443 </dev/null 2>/dev/null | openssl x509 -noout -subject
```

**Fix.** Recreate the container, which re-resolves the mount:

```bash
cd /opt/dockyard && docker compose up -d --force-recreate --no-deps nginx
```

**Prevention.** The installer does this itself after rendering the config, on every path that
renders one.

## Sign-in does not stick, but curl works

**Symptom.** Signing in appears to succeed and then the session is gone. The same credentials work
from `curl`.

**What it means.** The site is on plain HTTP while the session cookie is marked `Secure`. A browser
will not send a `Secure` cookie back over http, so the session never comes back. `curl` ignores that
rule, which is why it keeps working.

**Confirm it.**

```bash
grep -E '^NODE_ENV|^COOKIE_SECURE' /opt/dockyard/.env
curl -s -D - -o /dev/null -X POST -H 'content-type: application/json' \
  -d '{"email":"you@example.com","password":"wrong"}' http://127.0.0.1/api/auth/login | grep -i set-cookie
```

`HttpOnly; Secure` on an http response is the mismatch.

**The pairing.** These two settings move together and are not a preference:

| Deployment | `NODE_ENV` | `COOKIE_SECURE` |
|---|---|---|
| Behind TLS | `production` | `true` |
| Plain HTTP | `development` | `false` |

The server refuses to boot in production with an insecure cookie, and it refuses to work in a browser
with a secure cookie over http. So an install without TLS runs in development mode, which is the only
thing that mode changes.

**Fix.** Put TLS in front of the panel, or let the installer do it:

```bash
cd /opt/dockyard && sudo ./install.sh --proxy --cert self-signed
```

## Let's Encrypt did not issue a certificate

The installer prints certbot's own reason, and falls back to a self-signed certificate so the panel
stays usable. The three causes, in the order worth checking:

**The contact address was refused.** The ACME server rejects addresses on reserved domains, so the
installer's own default (`admin@dockyard.local`) cannot register an account. Pass a real one:

```bash
sudo ./install.sh --proxy --cert letsencrypt --domain panel.example.com --email you@example.com
```

**DNS does not point here.** The domain needs an `A` record for the host's public address, and it
needs to have propagated. Check from outside the host:

```bash
dig +short panel.example.com
curl -sS -o /dev/null -w '%{http_code}\n' http://panel.example.com/.well-known/acme-challenge/x
```

The second command should not return a redirect. nginx serves the challenge path over plain HTTP on
purpose, so a redirect there means the TLS config is already in place.

**Port 80 is not reachable from the internet.** The certificate authority validates over HTTP on port
80, so a firewall or a closed port blocks issuance even when DNS is right.

## The certificate was issued for an address nothing can reach

**Symptom.** The certificate's subject is something like `172.17.0.1`, which is a Docker bridge.

**What it means.** The installer detects the host's own address for a bare-IP certificate. The
preferred method uses `ip route get`, but `ip` ships in iproute2 and minimal images do not have it, so
the fallback runs. On a host that runs Docker, a naive "first address" pick can return a bridge
address, and a certificate for a bridge matches nothing outside the host.

**Confirm it.**

```bash
openssl x509 -noout -subject -ext subjectAltName \
  -in /opt/dockyard/data/nginx/certs/*/fullchain.pem
```

**Fix.** Give the name explicitly, or override the public URL:

```bash
sudo ./install.sh --proxy --cert self-signed --domain 203.0.113.9
```

Current versions match the address against the default route's gateway, which a Docker bridge is not,
and install `iproute2` with the base packages so the reliable method is available next time.

## The site loops or redirects forever

**What it means.** nginx is running the TLS template behind something that speaks plain HTTP to it,
usually a quick Cloudflare tunnel. The tunnel targets `http://127.0.0.1:80`; nginx answers with a
redirect to `https://<host>`; the tunnel forwards that back to nginx on port 80; it redirects again.

**Confirm it.**

```bash
curl -s -o /dev/null -w '%{http_code}\n' http://127.0.0.1:80/
grep -c ssl_certificate /opt/dockyard/data/nginx/dockyard.conf
```

A 301 from the loopback address with `ssl_certificate` present is the loop.

**Fix.** Behind a quick tunnel, use the plain HTTP config, because Cloudflare already terminates TLS:

```bash
cd /opt/dockyard && sudo ./install.sh --proxy --cert none
```

Real TLS on nginx needs a real domain, not a `trycloudflare.com` hostname.

## Nothing answers and I do not know where to look

Work outward, one layer at a time.

```bash
cd /opt/dockyard

# 1. Are the containers up?
docker compose ps -a

# 2. Is the panel itself answering, on its own port?
curl -sS -o /dev/null -w '%{http_code}\n' http://127.0.0.1:8000/api/system/health

# 3. Is nginx answering on the host?
curl -sS -o /dev/null -w '%{http_code}\n' http://127.0.0.1:80/api/system/health

# 4. Does the config load, and what does nginx say?
docker exec dockyard-nginx-1 nginx -t
docker logs dockyard-nginx-1 --tail 30
docker compose logs --tail 30 panel
```

If step 2 works and step 3 does not, the problem is nginx: see the 502 entry above. If step 3 works
and the public address does not, the problem is outside the stack, so check the firewall and whatever
sits in front.

The installer records what it did at the end of a run, and `deploy/update.sh` writes its own log, so
`/tmp/dy-deploy.log` and the compose logs are the first places to look after a change.
