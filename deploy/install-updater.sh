#!/usr/bin/env bash
# Wire the panel's "Install update" button to this host, once.
#
# Installs a systemd path unit that runs deploy/update.sh whenever the panel writes an update
# request, and marks the spool directory as watched so the panel stops saying no updater is
# installed. Run it as root, from the checkout that is actually deployed:
#
#   sudo ./deploy/install-updater.sh
#
# Nothing here needs the panel to be reachable, and it is safe to re-run.
set -Eeuo pipefail

REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SPOOL_DIR="${DOCKYARD_UPDATE_SPOOL:-$REPO_DIR/data/update}"
UNIT_DIR="${DOCKYARD_UPDATE_UNIT_DIR:-/etc/systemd/system}"
# The panel image runs as uid/gid 1001 and writes request.json into the spool, which is a bind
# mount from this host directory. Root owns the files it writes back.
PANEL_UID="${DOCKYARD_PANEL_UID:-1001}"

say() { printf '  %s\n' "$*"; }

if [ "$(id -u)" != "0" ]; then
  say "this needs root: it installs a systemd unit. Re-run with sudo."
  exit 1
fi

if [ ! -f "$REPO_DIR/docker-compose.yml" ]; then
  say "$REPO_DIR does not look like the Dockyard checkout (no docker-compose.yml)."
  exit 1
fi

say "checkout:  $REPO_DIR"
say "spool:     $SPOOL_DIR"

mkdir -p "$SPOOL_DIR"
if id -u "$PANEL_UID" >/dev/null 2>&1 || getent passwd "$PANEL_UID" >/dev/null 2>&1; then
  chown "$PANEL_UID:$PANEL_UID" "$SPOOL_DIR" 2>/dev/null || true
else
  # No such local user: the uid only exists inside the image, so fall back to group write.
  chmod 0777 "$SPOOL_DIR"
fi
chmod 0775 "$SPOOL_DIR" 2>/dev/null || true

chmod 0755 "$REPO_DIR/deploy/update.sh"

if ! command -v systemctl >/dev/null 2>&1; then
  say "no systemd on this host. Schedule the updater yourself, for example:"
  say "  */5 * * * * $REPO_DIR/deploy/update.sh"
  exit 0
fi

render() {
  sed -e "s|@REPO_DIR@|$REPO_DIR|g" -e "s|@SPOOL_DIR@|$SPOOL_DIR|g" "$1"
}

render "$REPO_DIR/deploy/dockyard-updater.service.in" > "$UNIT_DIR/dockyard-updater.service"
render "$REPO_DIR/deploy/dockyard-updater.path.in" > "$UNIT_DIR/dockyard-updater.path"
chmod 0644 "$UNIT_DIR/dockyard-updater.service" "$UNIT_DIR/dockyard-updater.path"
say "installed $UNIT_DIR/dockyard-updater.{service,path}"

# The marker the panel reads to know the button is wired up. Written last, so a failure above
# leaves the panel still saying no updater is installed rather than promising one that is not there.
printf '{"installedAt":"%s","repoDir":"%s","spoolDir":"%s"}\n' \
  "$(date -u +%FT%TZ)" "$REPO_DIR" "$SPOOL_DIR" > "$SPOOL_DIR/updater.json"
chmod 0644 "$SPOOL_DIR/updater.json"

systemctl daemon-reload
systemctl enable --now dockyard-updater.path

say ""
say "updater path unit: $(systemctl is-active dockyard-updater.path)"
say "watch it work:     systemctl status dockyard-updater"
say "run it by hand:    $REPO_DIR/deploy/update.sh"
say ""
say "The panel now shows a working Install update button."
