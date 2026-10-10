#!/usr/bin/env bash
# Dockyard updater: pull the branch, rebuild the panel, restart it, roll back on failure.
#
# This runs ON THE HOST, not in the panel container. A container cannot replace its own image, so
# the panel never tries: it writes data/update/request.json and this script collects it.
#
#   ./deploy/update.sh                 update now, in the foreground
#   ./deploy/install-updater.sh        install a systemd path unit so the panel's
#                                      "Install update" button triggers this script
#   ./deploy/update.sh --force         proceed even with local modifications in the checkout
#
# Order of operations: read the request, fetch, check it fast-forwards, move the checkout,
# rebuild, restart, wait for the health endpoint. Any failure after the checkout moved puts the
# previous commit back and rebuilds it, so a bad commit costs one build rather than an outage.
set -Eeuo pipefail

REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SPOOL_DIR="${DOCKYARD_UPDATE_SPOOL:-$REPO_DIR/data/update}"
STATUS_FILE="$SPOOL_DIR/status.json"
REQUEST_FILE="$SPOOL_DIR/request.json"
LOCK_FILE="$SPOOL_DIR/.update.lock"
LOG_FILE="$SPOOL_DIR/update.log"
BRANCH="${DOCKYARD_UPDATE_BRANCH:-main}"
HEALTH_TIMEOUT="${DOCKYARD_UPDATE_HEALTH_TIMEOUT:-180}"
COMPOSE=(docker compose --project-directory "$REPO_DIR" -f "$REPO_DIR/docker-compose.yml")

FORCE=0
RESUME=0
case "${1:-}" in
  --force) FORCE=1 ;;
  --resume)
    # Set by this script when it re-execs after moving the checkout, so the newest copy of the
    # updater runs without repeating the fetch.
    RESUME=1
    FROM_COMMIT="$2"
    TARGET="$3"
    ;;
esac

# --------------------------------------------------------------------------- output

log() {
  mkdir -p "$SPOOL_DIR"
  printf '%s %s\n' "$(date -u +%FT%TZ)" "$*" | tee -a "$LOG_FILE" >&2
}

json_escape() {
  local s="${1:-}"
  s="${s//\\/\\\\}"
  s="${s//\"/\\\"}"
  s="${s//$'\r'/}"
  s="${s//$'\t'/\\t}"
  s="${s//$'\n'/\\n}"
  printf '%s' "$s"
}

json_or_null() {
  if [ -z "${1:-}" ]; then printf 'null'; else printf '"%s"' "$(json_escape "$1")"; fi
}

# status <state> <step> <message> <to-commit> <to-version>
#
# Written by hand rather than with jq or python: neither is guaranteed on a host that only needs
# Docker, and a status file that fails to write leaves the panel spinning.
write_status() {
  local state="$1" step="${2:-}" message="${3:-}" to_commit="${4:-}" to_version="${5:-}"
  local tmp="$STATUS_FILE.$$.tmp"
  local tail_log=""
  [ -f "$LOG_FILE" ] && tail_log="$(tail -n 40 "$LOG_FILE" 2>/dev/null || true)"
  mkdir -p "$SPOOL_DIR"
  {
    printf '{\n'
    printf '  "id": "%s",\n' "$(json_escape "${REQ_ID:-manual}")"
    printf '  "state": "%s",\n' "$(json_escape "$state")"
    printf '  "step": %s,\n' "$(json_or_null "$step")"
    printf '  "message": %s,\n' "$(json_or_null "$message")"
    printf '  "requestedAt": %s,\n' "$(json_or_null "${REQ_AT:-}")"
    printf '  "requestedBy": %s,\n' "$(json_or_null "${REQ_BY:-}")"
    printf '  "startedAt": %s,\n' "$(json_or_null "${STARTED_AT:-}")"
    printf '  "finishedAt": %s,\n' "$(json_or_null "${FINISHED_AT:-}")"
    printf '  "from": { "version": %s, "commit": %s },\n' \
      "$(json_or_null "${FROM_VERSION:-}")" "$(json_or_null "${FROM_COMMIT:-}")"
    printf '  "to": { "version": %s, "commit": %s },\n' "$(json_or_null "$to_version")" "$(json_or_null "$to_commit")"
    printf '  "log": %s\n' "$(json_or_null "$tail_log")"
    printf '}\n'
  } > "$tmp"
  mv -f "$tmp" "$STATUS_FILE"
  chmod 0644 "$STATUS_FILE" 2>/dev/null || true
}

# --------------------------------------------------------------------------- helpers

package_version() {
  sed -n 's/.*"version"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' "$REPO_DIR/package.json" | head -1
}

panel_port() {
  local p
  p="$(sed -n 's/^PANEL_PORT=\(.*\)$/\1/p' "$REPO_DIR/.env" 2>/dev/null | tail -1 | tr -d '"'"'"' ')"
  printf '%s' "${p:-8000}"
}

wait_for_health() {
  local port="$1" deadline=$((SECONDS + HEALTH_TIMEOUT))
  while [ "$SECONDS" -lt "$deadline" ]; do
    if curl -fsS --max-time 5 "http://127.0.0.1:${port}/api/system/health" >/dev/null 2>&1; then
      return 0
    fi
    sleep 3
  done
  return 1
}

build_and_restart() {
  local commit="$1"
  # Declare then export: `export X="$(cmd)"` masks cmd's exit status from shellcheck, and here a
  # failing date would silently stamp the image with an empty build time.
  GIT_COMMIT="$commit"
  BUILD_TIME="$(date -u +%FT%TZ)"
  export GIT_COMMIT BUILD_TIME
  log "building the panel image at $commit"
  # Every step is checked by hand, and that is not belt-and-braces: this function is called from an
  # `if !`, and bash suspends `set -e` for the whole body of a function invoked in a condition. A
  # failing build would otherwise fall straight through to the restart, the function would return
  # the restart's status, and the caller would call a stale image a successful update.
  if ! "${COMPOSE[@]}" build panel 2>&1 | tee -a "$LOG_FILE" >&2; then
    log "the panel image failed to build"
    return 1
  fi
  log "recreating the panel container"
  if ! "${COMPOSE[@]}" up -d 2>&1 | tee -a "$LOG_FILE" >&2; then
    log "the panel container failed to start"
    return 1
  fi
}

# --------------------------------------------------------------------------- request

read_request() {
  REQ_ID=""; REQ_AT=""; REQ_BY=""; REQ_BRANCH=""
  [ -f "$REQUEST_FILE" ] || return 0
  REQ_ID="$(sed -n 's/.*"id"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' "$REQUEST_FILE" | head -1)"
  REQ_AT="$(sed -n 's/.*"requestedAt"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' "$REQUEST_FILE" | head -1)"
  REQ_BY="$(sed -n 's/.*"requestedBy"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' "$REQUEST_FILE" | head -1)"
  REQ_BRANCH="$(sed -n 's/.*"branch"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' "$REQUEST_FILE" | head -1)"
}

# --------------------------------------------------------------------------- rollback

rollback() {
  log "rolling back to ${FROM_COMMIT}"
  write_status running "rollback" "The new build did not come up. Restoring ${FROM_COMMIT}." "$TARGET" "${TO_VERSION:-}"
  git -C "$REPO_DIR" reset --hard "$FROM_COMMIT" >/dev/null
  if build_and_restart "$FROM_COMMIT" && wait_for_health "$(panel_port)"; then
    FINISHED_AT="$(date -u +%FT%TZ)"
    write_status rolled-back "done" "The update failed and ${FROM_COMMIT} is running again. See the log." "$TARGET" "${TO_VERSION:-}"
    log "rollback complete; ${FROM_COMMIT} is serving"
  else
    FINISHED_AT="$(date -u +%FT%TZ)"
    write_status failed "rollback" "The update failed and the rollback did not come up either. Fix it on the host." "$TARGET" "${TO_VERSION:-}"
    log "ROLLBACK FAILED; the panel may be down"
  fi
  exit 1
}

# --------------------------------------------------------------------------- main

# The panel writes request.json into the spool and runs as uid 1001 inside its container. Docker
# creates a bind-mount source directory owned by root, which the panel cannot write, so the update
# button fails with EACCES and the panel has no way to repair itself. install.sh does this at install
# time; doing it here as well heals a deployment that predates install.sh, on its next run.
ensure_spool_owner() {
  mkdir -p "$SPOOL_DIR"
  [ "$(id -u)" = "0" ] || return 0
  chown "${DOCKYARD_PANEL_UID:-1001}:${DOCKYARD_PANEL_UID:-1001}" "$SPOOL_DIR" 2>/dev/null || true
}

ensure_spool_owner
# A resume is the same run continuing after the checkout moved, so it must not wait on itself.
if [ "$RESUME" != "1" ] && command -v flock >/dev/null 2>&1; then
  exec 9>"$LOCK_FILE"
  if ! flock -n 9; then
    log "another update is already running; nothing to do"
    exit 0
  fi
fi

if [ "$RESUME" != "1" ]; then
  : > "$LOG_FILE"
  read_request
  BRANCH="${REQ_BRANCH:-$BRANCH}"
  STARTED_AT="$(date -u +%FT%TZ)"

  # The branch comes from a file the panel wrote, so treat it as untrusted input and never let it
  # reach a path or a shell word.
  case "$BRANCH" in
    ''|*[!A-Za-z0-9._/-]*)
      log "refusing branch '${BRANCH}': unexpected characters"
      write_status failed "fetch" "The requested branch name is not usable." "" ""
      exit 2
      ;;
  esac

  # The updater works by pulling this checkout, so a directory that was copied onto the host rather
  # than cloned cannot be updated. Say that plainly instead of letting git emit a raw error.
  if ! git -C "$REPO_DIR" rev-parse --git-dir >/dev/null 2>&1; then
    log "refusing: $REPO_DIR is not a git checkout"
    write_status failed "fetch" "The deployed directory is not a git checkout, so there is nothing to pull. Clone the repository into it, then run deploy/install-updater.sh again." "" ""
    exit 5
  fi

  if ! git -C "$REPO_DIR" remote get-url origin >/dev/null 2>&1; then
    log "refusing: $REPO_DIR has no origin remote"
    write_status failed "fetch" "The deployed checkout has no origin remote, so there is nothing to pull. Add one, then try again." "" ""
    exit 5
  fi

  cd "$REPO_DIR"

  if [ "$FORCE" != "1" ] && [ -n "$(git status --porcelain --untracked-files=no)" ]; then
    log "refusing: the checkout has local modifications (pass --force to discard them)"
    write_status failed "fetch" "The checkout has local modifications. Commit or discard them, or run with --force." "" ""
    exit 3
  fi

  FROM_COMMIT="$(git rev-parse HEAD)"
  FROM_VERSION="$(package_version)"
  write_status running "fetch" "Fetching ${BRANCH} from origin." "" ""

  log "fetching origin/$BRANCH"
  git fetch --prune origin "$BRANCH" 2>&1 | tee -a "$LOG_FILE" >&2
  TARGET="$(git rev-parse "origin/${BRANCH}")"

  if [ "$TARGET" = "$FROM_COMMIT" ]; then
    log "already at the tip of ${BRANCH} (${TARGET})"
    FINISHED_AT="$(date -u +%FT%TZ)"
    write_status success "done" "Already at the tip of ${BRANCH}." "$TARGET" "$FROM_VERSION"
    exit 0
  fi

  if ! git merge-base --is-ancestor "$FROM_COMMIT" "$TARGET"; then
    log "refusing: ${TARGET} is not a fast-forward of ${FROM_COMMIT}"
    FINISHED_AT="$(date -u +%FT%TZ)"
    write_status failed "fetch" "The branch tip is not a fast-forward of the running commit, so the update was refused." "$TARGET" ""
    exit 4
  fi

  log "moving ${FROM_COMMIT} -> ${TARGET}"
  git reset --hard "$TARGET" >/dev/null

  # The checkout just changed, so this file may have changed with it. Re-exec so the newest
  # updater logic runs. `exec` replaces this process, so everything the status file needs has to
  # be exported first or the resumed run reports a manual, anonymous request.
  if [ "${DOCKYARD_UPDATE_REEXEC:-}" != "1" ]; then
    export DOCKYARD_UPDATE_REEXEC=1
    export REQ_ID REQ_AT REQ_BY STARTED_AT FROM_VERSION
    log "re-executing the updater from the new checkout"
    exec "$REPO_DIR/deploy/update.sh" --resume "$FROM_COMMIT" "$TARGET"
  fi
fi

TO_VERSION="$(package_version)"
write_status running "build" "Building the panel image at ${TARGET}." "$TARGET" "$TO_VERSION"

if ! build_and_restart "$TARGET"; then
  log "the build or the restart failed"
  rollback
fi

write_status running "health" "Waiting for the health endpoint." "$TARGET" "$TO_VERSION"
if ! wait_for_health "$(panel_port)"; then
  log "the panel did not answer its health endpoint within ${HEALTH_TIMEOUT}s"
  rollback
fi

FINISHED_AT="$(date -u +%FT%TZ)"
write_status success "done" "Updated to ${TO_VERSION} (${TARGET})." "$TARGET" "$TO_VERSION"
log "update complete: ${FROM_COMMIT} -> ${TARGET} (v${TO_VERSION})"
