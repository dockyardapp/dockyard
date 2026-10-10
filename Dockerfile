# syntax=docker/dockerfile:1.7
# Dockyard panel image. Multi-stage: web build -> prod deps -> cloudflared -> runtime.

FROM node:26-alpine AS web
WORKDIR /build
COPY package.json package-lock.json ./
COPY server/package.json server/
COPY web/package.json web/
RUN npm ci --workspace web --include-workspace-root
COPY web/ web/
RUN npm --workspace web run build

FROM node:26-alpine AS deps
WORKDIR /build
COPY package.json package-lock.json ./
COPY server/package.json server/
COPY web/package.json web/
RUN npm ci --omit=dev --workspace server --include-workspace-root

FROM alpine:3.20 AS cloudflared
ARG TARGETARCH
RUN apk add --no-cache curl ca-certificates \
 && curl -fsSL -o /usr/local/bin/cloudflared \
      "https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-linux-${TARGETARCH}" \
 && chmod 0755 /usr/local/bin/cloudflared

FROM node:26-alpine AS runtime
# Baked in so the panel can report which commit it is running. `deploy/update.sh` passes these;
# a bare `docker compose build` leaves them empty and the panel says the commit is unknown rather
# than claiming it is current.
ARG GIT_COMMIT=
ARG BUILD_TIME=
RUN apk add --no-cache ca-certificates tini \
 && addgroup -g 1001 -S dockyard \
 && adduser -u 1001 -S dockyard -G dockyard

WORKDIR /app
COPY --from=deps  /build/node_modules ./node_modules
COPY --from=deps  /build/package.json ./package.json
COPY --from=deps  /build/server/package.json ./server/package.json
COPY server/src ./server/src
# The generated migrations and Drizzle's journal. `migrate()` reads this directory at boot, so an
# image without it starts and then dies on the first run; drizzle-kit itself is a dev dependency and
# deliberately absent here, because generating migrations is a development act, not a runtime one.
COPY server/drizzle ./server/drizzle
COPY server/tsconfig.json ./server/tsconfig.json
COPY --from=web   /build/web/dist ./web/dist
COPY --from=cloudflared /usr/local/bin/cloudflared /usr/local/bin/cloudflared

RUN mkdir -p /app/data/tunnels /app/data/templates /app/data/templates-remote && chown -R dockyard:dockyard /app

ENV NODE_ENV=production \
    PORT=8000 \
    HOST=0.0.0.0 \
    TUNNEL_DATA_DIR=/app/data/tunnels \
    DOCKYARD_TEMPLATE_DIR=/app/data/templates \
    DOCKYARD_TEMPLATES_DIR=/app/data/templates-remote \
    CLOUDFLARED_BIN=/usr/local/bin/cloudflared \
    DOCKYARD_COMMIT=$GIT_COMMIT \
    DOCKYARD_BUILD_TIME=$BUILD_TIME

# The panel must reach the Docker socket; mounting /var/run/docker.sock is the
# expected deployment. It runs as a non-root user, so the socket needs to be
# reachable by gid 1001 (or run with --group-add $(getent group docker | cut -d: -f3)).
USER dockyard
EXPOSE 8000

HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||8000)+'/api/system/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

ENTRYPOINT ["/sbin/tini", "--"]
CMD ["node", "server/src/index.ts"]
