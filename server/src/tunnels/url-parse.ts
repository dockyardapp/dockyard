// Dockyard — cloudflared output parsing (owner: agent 3).
//
// cloudflared writes its log to stderr. The quick-tunnel URL is printed inside an ASCII
// banner box, e.g.:
//
//   2026-10-08T11:33:52Z INF +------------------------------------------------------------+
//   2026-10-08T11:33:52Z INF |  Your quick Tunnel has been created! Visit it at ...       |
//   2026-10-08T11:33:52Z INF |  https://planets-conscious-...trycloudflare.com          |
//   2026-10-08T11:33:52Z INF +------------------------------------------------------------+
//
// Lines may carry ANSI colour codes when cloudflared has a TTY, and a single URL may be
// split across two stdout/stderr chunks. parseQuickTunnelUrl is a pure function; use
// createQuickUrlScanner when the input arrives in fragments (it keeps a rolling buffer).

// Standard ANSI escape matcher (CSI/OSC/other escape sequences).
const ANSI_RE =
  // eslint-disable-next-line no-control-regex
  /[\u001B\u009B][[\]()#;?]*(?:(?:(?:[a-zA-Z\d]*(?:;[-a-zA-Z\d/#&.:=?%@~_]*)*)?\u0007)|(?:(?:\d{1,4}(?:;\d{0,4})*)?[\dA-PR-TZcf-nq-uy=><~]))/g;

// A quick tunnel host: lowercase words joined by dashes, dot, trycloudflare.com.
const QUICK_URL_RE = /https:\/\/[a-z0-9]+(?:-[a-z0-9]+)*\.trycloudflare\.com/i;

// A leading cloudflared log timestamp, e.g. `2026-10-08T11:33:52Z `.
const LOG_TS_RE = /^\d{4}-\d{2}-\d{2}T[\d:.]+(?:Z|[+-]\d{2}:\d{2})\s+/;

/** Strip ANSI escape sequences from a chunk of terminal output. */
export function stripAnsi(input: string): string {
  if (!input) return '';
  return input.replace(ANSI_RE, '');
}

/**
 * Find the first assigned `https://<words>.trycloudflare.com` URL in a chunk.
 * ANSI codes and surrounding banner-box characters are ignored. Returns null when absent.
 */
export function parseQuickTunnelUrl(chunk: string): string | null {
  if (!chunk) return null;
  const clean = stripAnsi(chunk);
  const match = clean.match(QUICK_URL_RE);
  return match ? match[0] : null;
}

/**
 * Rolling-buffer scanner for chunked input. Feed each raw chunk to push(); it returns the
 * quick-tunnel URL as soon as it has been seen, even when the URL was split across chunks.
 */
export function createQuickUrlScanner(limit = 65_536): {
  push(chunk: string): string | null;
  reset(): void;
  buffer(): string;
} {
  let buf = '';
  return {
    push(chunk: string): string | null {
      if (!chunk) return null;
      buf += chunk;
      if (buf.length > limit) buf = buf.slice(-limit);
      return parseQuickTunnelUrl(buf);
    },
    reset(): void {
      buf = '';
    },
    buffer(): string {
      return buf;
    },
  };
}

// cloudflared failure signatures. Order matters: a line is only an error when it is
// ERR-level or contains an explicit "failed to ..."; a bare `error=` on a WRN/INF line
// (e.g. the ICMP-proxy warning) must NOT be treated as fatal.
const ERR_LEVEL_RE = /(^|\s)ERR(\s|$)/;
const WRN_LEVEL_RE = /(^|\s)WRN(\s|$)/;
const INF_LEVEL_RE = /(^|\s)INF(\s|$)/;
const FAILED_TO_RE = /failed to [^\n]+/i;
const ERROR_KV_RE = /error=(?:"[^"]*"|\S+)/i;

/**
 * Recognise a cloudflared failure line. Returns the message with the log timestamp and
 * ANSI codes removed, or null. Handles the real signatures:
 *   - `ERR Failed to request quick Tunnel: ...`
 *   - `ERR Couldn't start tunnel error="unknown protocol ..."`
 *   - `ERR Failed to dial a quic connection error="..."`
 *   - any `failed to ...`
 */
export function parseCloudflaredError(chunk: string): string | null {
  if (!chunk) return null;
  const clean = stripAnsi(chunk);
  for (const rawLine of clean.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line) continue;

    let hit: string | null = null;
    if (ERR_LEVEL_RE.test(line)) {
      hit = line;
    } else if (FAILED_TO_RE.test(line)) {
      hit = line;
    } else if (
      ERROR_KV_RE.test(line) &&
      !WRN_LEVEL_RE.test(line) &&
      !INF_LEVEL_RE.test(line)
    ) {
      hit = line;
    }
    if (hit) return hit.replace(LOG_TS_RE, '').trim();
  }
  return null;
}
