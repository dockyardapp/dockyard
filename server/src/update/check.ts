// Dockyard — is there a newer build upstream? (owner: agent 1).
//
// Asks GitHub for the relationship between the running commit and the branch tip using the
// compare endpoint, not "is the sha different". A build made from a local commit ahead of origin
// would otherwise be reported as an available update, and applying it would be a downgrade.
//
// Every failure comes back as `error` with the rest of the payload intact, because the caller
// still needs `build` to draw the version it is running.

import { config } from '../config.ts';
import { buildInfo } from '../version.ts';

const API = 'https://api.github.com';
const TIMEOUT_MS = 8000;
const CACHE_MS = 60_000;

export type UpstreamCommit = {
  sha: string;
  commitShort: string;
  subject: string;
  author: string;
  date: string;
  url: string;
};

export type UpdateCheck = {
  checkedAt: string;
  repo: string;
  branch: string;
  /** True when a token was sent, which is what a private repository needs. */
  authenticated: boolean;
  status: 'current' | 'behind' | 'ahead' | 'diverged' | 'unknown';
  behindBy: number;
  aheadBy: number;
  latest: {
    version: string | null;
    commit: string;
    commitShort: string;
    subject: string;
    author: string;
    date: string;
    url: string;
  } | null;
  /** The commits an update would bring in, newest first. */
  commits: UpstreamCommit[];
  rateLimit: { remaining: number | null; limit: number | null; resetAt: string | null };
  error: string | null;
};

type GhResponse = {
  ok: boolean;
  status: number;
  body: unknown;
  headers: Headers;
  transportError?: string;
};

async function gh(pathname: string, accept = 'application/vnd.github+json'): Promise<GhResponse> {
  const headers: Record<string, string> = {
    Accept: accept,
    'User-Agent': 'dockyard-panel',
    'X-GitHub-Api-Version': '2022-11-28',
  };
  if (config.updateToken) headers.Authorization = `Bearer ${config.updateToken}`;
  try {
    const res = await fetch(`${API}${pathname}`, { headers, signal: AbortSignal.timeout(TIMEOUT_MS) });
    const text = await res.text();
    let body: unknown = null;
    try {
      body = text ? JSON.parse(text) : null;
    } catch {
      body = text;
    }
    return { ok: res.ok, status: res.status, body, headers: res.headers };
  } catch (err) {
    return {
      ok: false,
      status: 0,
      body: null,
      headers: new Headers(),
      transportError: err instanceof Error ? err.message : String(err),
    };
  }
}

function describeError(res: GhResponse): string {
  if (res.transportError) return `could not reach GitHub: ${res.transportError}`;
  if (res.status === 404) {
    return (
      `GitHub has no ${config.updateRepo}@${config.updateBranch}, or it is private and the token ` +
      'was rejected. A private repository needs DOCKYARD_UPDATE_TOKEN.'
    );
  }
  if (res.status === 403 || res.status === 429) {
    return 'GitHub rate limit reached. The check succeeds again once the window resets.';
  }
  const message = (res.body as { message?: string } | null)?.message;
  return `GitHub returned ${res.status}${message ? `: ${message}` : ''}.`;
}

function rateLimit(headers: Headers): UpdateCheck['rateLimit'] {
  const num = (key: string): number | null => {
    const raw = headers.get(key);
    if (raw === null) return null;
    const n = Number(raw);
    return Number.isFinite(n) ? n : null;
  };
  const reset = num('x-ratelimit-reset');
  return {
    remaining: num('x-ratelimit-remaining'),
    limit: num('x-ratelimit-limit'),
    resetAt: reset === null ? null : new Date(reset * 1000).toISOString(),
  };
}

type RawCommit = {
  sha?: string;
  html_url?: string;
  commit?: { message?: string; author?: { name?: string; date?: string } };
};

function toUpstreamCommit(raw: RawCommit): UpstreamCommit {
  const sha = String(raw.sha ?? '');
  const message = String(raw.commit?.message ?? '');
  return {
    sha,
    commitShort: sha.slice(0, 7),
    subject: message.split('\n')[0] ?? '',
    author: String(raw.commit?.author?.name ?? ''),
    date: String(raw.commit?.author?.date ?? ''),
    url: String(raw.html_url ?? ''),
  };
}

export type CompareSummary = {
  status: UpdateCheck['status'];
  behindBy: number;
  aheadBy: number;
  commits: UpstreamCommit[];
};

/**
 * Map the compare endpoint's payload onto the status the UI renders.
 *
 * The direction is the trap: GitHub's `compare/{base}...{head}` describes the **head** relative to
 * the base, and we always ask with the running commit as the base and the branch as the head. So
 * the payload's `ahead_by` counts the commits the branch has that this build does not, which is how
 * far *we* are behind; `behind_by` is the reverse. Its `commits` array lists only the head side,
 * which is exactly the side carrying the update, oldest first.
 *
 * Split out and exported because it is the one piece of the check that carries a decision: a local
 * commit ahead of origin must not read as an available update, and an unrecognised status string
 * must fall to 'unknown' rather than to 'behind'. Pure, so it is covered without a network.
 */
export function summariseCompare(cmp: {
  status?: string;
  ahead_by?: number;
  behind_by?: number;
  total_commits?: number;
  commits?: RawCommit[];
}): CompareSummary {
  const raw = String(cmp.status ?? '');
  const status: UpdateCheck['status'] =
    raw === 'identical'
      ? 'current'
      : raw === 'ahead'
        ? 'behind'
        : raw === 'behind'
          ? 'ahead'
          : raw === 'diverged'
            ? 'diverged'
            : 'unknown';

  const incoming = (cmp.commits ?? []).map(toUpstreamCommit);
  return {
    status,
    behindBy: Number(cmp.ahead_by ?? 0),
    aheadBy: Number(cmp.behind_by ?? 0),
    // Oldest first upstream; the UI reads newest first.
    commits: status === 'behind' ? [...incoming].reverse() : [],
  };
}

/** The `version` field of package.json at the branch tip, or null when it cannot be read. */
async function upstreamVersion(): Promise<string | null> {
  const res = await gh(
    `/repos/${config.updateRepo}/contents/package.json?ref=${encodeURIComponent(config.updateBranch)}`,
    'application/vnd.github.raw',
  );
  if (!res.ok) return null;
  try {
    const pkg = JSON.parse(String(res.body)) as { version?: string };
    return pkg.version ? String(pkg.version) : null;
  } catch {
    return null;
  }
}

let cache: { at: number; value: UpdateCheck } | null = null;

export async function checkForUpdate(force = false): Promise<UpdateCheck> {
  if (!force && cache && Date.now() - cache.at < CACHE_MS) return cache.value;

  const base = {
    checkedAt: new Date().toISOString(),
    repo: config.updateRepo,
    branch: config.updateBranch,
    authenticated: config.updateToken.length > 0,
  };

  // An unpinned build (no commit baked in) cannot be compared, but the branch tip is still a
  // useful fact to show, so fall through with status 'unknown' rather than bailing out.
  const compare = buildInfo.pinned
    ? await gh(
        `/repos/${config.updateRepo}/compare/${buildInfo.commit}...${encodeURIComponent(config.updateBranch)}`,
      )
    : null;

  if (compare && !compare.ok) {
    const value: UpdateCheck = {
      ...base,
      status: 'unknown',
      behindBy: 0,
      aheadBy: 0,
      latest: null,
      commits: [],
      rateLimit: rateLimit(compare.headers),
      error: describeError(compare),
    };
    cache = { at: Date.now(), value };
    return value;
  }

  const tip = await gh(`/repos/${config.updateRepo}/commits/${encodeURIComponent(config.updateBranch)}`);
  if (!tip.ok) {
    const value: UpdateCheck = {
      ...base,
      status: 'unknown',
      behindBy: 0,
      aheadBy: 0,
      latest: null,
      commits: [],
      rateLimit: rateLimit(tip.headers),
      error: describeError(tip),
    };
    cache = { at: Date.now(), value };
    return value;
  }

  const tipRaw = tip.body as RawCommit;
  const tipCommit = toUpstreamCommit(tipRaw);
  const version = await upstreamVersion();
  const latest: UpdateCheck['latest'] = {
    version,
    commit: tipCommit.sha,
    commitShort: tipCommit.commitShort,
    subject: tipCommit.subject,
    author: tipCommit.author,
    date: tipCommit.date,
    url: tipCommit.url,
  };

  if (!compare) {
    const value: UpdateCheck = {
      ...base,
      status: 'unknown',
      behindBy: 0,
      aheadBy: 0,
      latest,
      commits: [],
      rateLimit: rateLimit(tip.headers),
      error: null,
    };
    cache = { at: Date.now(), value };
    return value;
  }

  const cmp = compare.body as {
    status?: string;
    ahead_by?: number;
    behind_by?: number;
    total_commits?: number;
    commits?: RawCommit[];
  };
  const summary = summariseCompare(cmp);

  const value: UpdateCheck = {
    ...base,
    status: summary.status,
    behindBy: summary.behindBy,
    aheadBy: summary.aheadBy,
    latest,
    commits: summary.commits,
    rateLimit: rateLimit(tip.headers),
    error: null,
  };
  cache = { at: Date.now(), value };
  return value;
}

/** Drop the memoised check so the next call hits GitHub. Used by tests. */
export function resetUpdateCache(): void {
  cache = null;
}

/**
 * A check without making the caller wait on GitHub whenever one is already known.
 *
 * The panel's chrome draws the running version from this payload, and that version is local: a
 * slow or unreachable upstream must not delay it. Only the very first call after a restart waits;
 * after that the previous answer is served immediately and refreshed behind the caller.
 */
export async function getCheck(): Promise<UpdateCheck> {
  if (cache && Date.now() - cache.at < CACHE_MS) return cache.value;
  if (!cache) return checkForUpdate();
  void checkForUpdate().catch(() => undefined);
  return cache.value;
}
