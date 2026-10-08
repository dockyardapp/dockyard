/** Formatting helpers. All numeric output uses tabular numerals via CSS. */

export function formatBytes(bytes: number, digits = 1): string {
  if (!Number.isFinite(bytes) || bytes < 0) return '-';
  if (bytes === 0) return '0 B';
  const units = ['B', 'KiB', 'MiB', 'GiB', 'TiB', 'PiB'];
  const i = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length - 1);
  const value = bytes / Math.pow(1024, i);
  return `${value.toFixed(i === 0 ? 0 : digits)} ${units[i]}`;
}

export function formatPercent(value: number, digits = 1): string {
  if (!Number.isFinite(value)) return '-';
  return `${value.toFixed(digits)}%`;
}

export function formatCount(value: number): string {
  if (!Number.isFinite(value)) return '-';
  return new Intl.NumberFormat('en-US').format(value);
}

/** Short container/image id, e.g. 12 hex chars. */
export function shortId(id: string, len = 12): string {
  if (!id) return '-';
  const clean = id.startsWith('sha256:') ? id.slice(7) : id;
  return clean.length > len ? clean.slice(0, len) : clean;
}

export function stripDigest(ref: string): string {
  const at = ref.indexOf('@sha256:');
  return at >= 0 ? ref.slice(0, at) : ref;
}

/** Docker's created/started timestamps come as unix seconds. */
export function fromUnixSeconds(sec: number | null | undefined): Date | null {
  if (sec === null || sec === undefined || !Number.isFinite(sec) || sec <= 0) return null;
  return new Date(sec * 1000);
}

/** Docker may send RFC3339 strings (startedAt/finishedAt) or Go zero-time. */
export function parseDockerTime(value: string | null | undefined): Date | null {
  if (!value) return null;
  if (value.startsWith('0001-01-01')) return null;
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? null : d;
}

export function formatDateTime(value: string | number | Date | null | undefined): string {
  let d: Date | null = null;
  if (value instanceof Date) d = value;
  else if (typeof value === 'number') d = fromUnixSeconds(value);
  else if (typeof value === 'string') {
    // parseDockerTime already handles every string form AND rejects Go's zero
    // time. A `?? new Date(value)` fallback here would resurrect that zero time
    // as year 1, which is why there is no fallback.
    d = parseDockerTime(value);
  }
  if (!d) return '-';
  return d.toLocaleString(undefined, {
    year: 'numeric',
    month: 'short',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  });
}

export function relativeTime(value: string | number | Date | null | undefined): string {
  let d: Date | null = null;
  if (value instanceof Date) d = value;
  else if (typeof value === 'number') d = fromUnixSeconds(value);
  else if (typeof value === 'string') {
    // See formatDateTime: no `??` fallback, or Go's zero time reads as year 1
    // and a running container shows "2027y ago".
    d = parseDockerTime(value);
  }
  if (!d) return '-';
  const diff = Date.now() - d.getTime();
  const abs = Math.abs(diff);
  const future = diff < 0;
  const units: Array<[number, string]> = [
    [1000, 's'],
    [60_000, 'm'],
    [3_600_000, 'h'],
    [86_400_000, 'd'],
    [2_592_000_000, 'mo'],
    [31_536_000_000, 'y'],
  ];
  let chosen: [number, string] = units[0];
  for (const u of units) if (abs >= u[0]) chosen = u;
  const n = Math.round(abs / chosen[0]);
  const label = `${n}${chosen[1]}`;
  return future ? `in ${label}` : `${label} ago`;
}

export function formatDuration(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds < 0) return '-';
  const s = Math.floor(seconds % 60);
  const m = Math.floor((seconds / 60) % 60);
  const h = Math.floor((seconds / 3600) % 24);
  const d = Math.floor(seconds / 86400);
  const parts: string[] = [];
  if (d) parts.push(`${d}d`);
  if (h) parts.push(`${h}h`);
  if (m) parts.push(`${m}m`);
  if (!d && !h) parts.push(`${s}s`);
  return parts.join(' ');
}

/** Docker port list -> "0.0.0.0:8080->80/tcp" style, one line each. */
export function formatPorts(ports: Array<{ ip?: string; privatePort: number; publicPort?: number; type: string }>): string[] {
  if (!ports || ports.length === 0) return [];
  return ports.map((p) => {
    if (p.publicPort) return `${p.ip ?? '0.0.0.0'}:${p.publicPort}->${p.privatePort}/${p.type}`;
    return `${p.privatePort}/${p.type}`;
  });
}

/** Short human label for a port mapping, used in tunnels. */
export function formatPort(ports: Array<{ privatePort: number; publicPort?: number; type: string }>): string {
  const mapped = ports.filter((p) => p.publicPort);
  if (mapped.length === 0) return '-';
  return mapped.map((p) => `${p.publicPort}->${p.privatePort}/${p.type}`).join(', ');
}

export function splitImageRef(image: string): { repo: string; tag: string } {
  const clean = stripDigest(image);
  const lastColon = clean.lastIndexOf(':');
  const lastSlash = clean.lastIndexOf('/');
  if (lastColon > lastSlash && lastColon >= 0) {
    return { repo: clean.slice(0, lastColon), tag: clean.slice(lastColon + 1) };
  }
  return { repo: clean, tag: 'latest' };
}

/** Minimal command-line splitter that respects single and double quotes. */
export function splitCommandLine(input: string): string[] {
  const out: string[] = [];
  let cur = '';
  let quote: '"' | "'" | null = null;
  let started = false;
  for (let i = 0; i < input.length; i++) {
    const ch = input[i];
    if (quote) {
      if (ch === quote) quote = null;
      else cur += ch;
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      started = true;
      continue;
    }
    if (ch === ' ' || ch === '\t') {
      if (started || cur) out.push(cur);
      cur = '';
      started = false;
      continue;
    }
    cur += ch;
    started = true;
  }
  if (started || cur) out.push(cur);
  return out;
}

export function pluralize(n: number, one: string, many?: string): string {
  return `${n} ${n === 1 ? one : many ?? `${one}s`}`;
}

/** Case-insensitive "does this record match the free-text query". */
export function matchesQuery(query: string, ...values: Array<string | null | undefined>): boolean {
  const q = query.trim().toLowerCase();
  if (!q) return true;
  return values.some((v) => (v ?? '').toLowerCase().includes(q));
}
