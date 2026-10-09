// Dockyard — templates pulled from a public repository (owner: agent 4).
//
// This is the same idea as templates/files.ts with the directory supplied for you. The panel reads a
// public repository of `*.json` template files over the network, writes them into a local cache
// directory, and reconciles the `templates` table against that cache exactly as it does for the
// operator's own directory. The rows land with `source = 'remote'`.
//
// Why it exists: a template can be added or corrected once, centrally, instead of on every install.
//
// Three properties it has to have, and how they are met:
//
//   1. A failed fetch never removes a template. The download goes into a temporary directory and
//      only replaces the cache once every file is in hand, so the reconcile never sees a partial
//      set. A fetch that fails leaves the previous cache exactly as it was.
//   2. It cannot silently undo local work. The reconcile for this source may only overwrite
//      `builtin` and `remote` rows (see CLAIMABLE in files.ts), so a local file or a template
//      edited in the panel always wins, whichever order the reconciles run in.
//   3. It stays inside the anonymous rate limit. The file list is one API call and is only made
//      when the cache is older than `templatesRefreshMinutes`; the file bodies come from the raw
//      host, which is not rate limited the same way. An admin can force one from the panel.
//
// The repository is public and its contents are third-party input. A template chooses an image and
// a command, so anyone who can push to that repository can choose what the panel offers to deploy.
// Deploying still takes an explicit click by an operator, and the panel's own role rules are
// unchanged, but it is a real trust boundary and the settings are documented as one.

import fs from 'node:fs';
import path from 'node:path';

import { config } from '../config.ts';
import { logger } from '../logger.ts';
import {
  lastTemplateSync,
  maybeResyncTemplateSource,
  reloadTemplateSource,
  scanTemplateFiles,
  syncTemplateSource,
  isParked,
  MAX_FILES,
  MAX_FILE_BYTES,
  type TemplateFileSync,
} from './files.ts';

/** Total bytes of template files we are willing to hold in memory for one pull. */
const MAX_TOTAL_BYTES = 4 * 1024 * 1024;
const FETCH_TIMEOUT_MS = 15_000;

/**
 * Root-level files that are a project's own configuration, never a template.
 *
 * Only consulted when the repository has no `templates/` folder, so it is a short list of the names
 * that would otherwise turn up as a schema error on every pull.
 */
const ROOT_FILES_THAT_ARE_NOT_TEMPLATES = new Set([
  'package.json',
  'package-lock.json',
  'tsconfig.json',
  'jsconfig.json',
  'composer.json',
  'deno.json',
]);

export type TemplateRemotePull = {
  at: string;
  repo: string;
  branch: string;
  /** The commit the tree was read at, so the card can say what it is serving. */
  commit: string | null;
  /** Did this pull reach the network, or was it served from the cache. */
  fetched: boolean;
  /** True when the fetch failed and the previous cache is still what is being served. */
  stale: boolean;
  files: number;
  bytes: number;
  message: string | null;
  errors: Array<{ file: string; errors: string[] }>;
};

type TreeEntry = { path?: string; type?: string; sha?: string; size?: number };

/** The cache is only as good as its last pull, so remember when that was. */
let lastPull: TemplateRemotePull | null = null;
let inFlightPull: Promise<TemplateRemotePull> | null = null;

export function remoteTemplatesEnabled(): boolean {
  return config.templatesRepo.trim().length > 0;
}

export function remoteTemplatesConfig(): {
  enabled: boolean;
  repo: string;
  branch: string;
  dir: string;
  refreshMinutes: number;
  authenticated: boolean;
} {
  return {
    enabled: remoteTemplatesEnabled(),
    repo: config.templatesRepo,
    branch: config.templatesBranch,
    dir: config.templateRemoteDir,
    refreshMinutes: config.templatesRefreshMinutes,
    // Whether a token is present, never the token.
    authenticated: config.templatesToken.length > 0,
  };
}

function apiHeaders(): Record<string, string> {
  const headers: Record<string, string> = {
    Accept: 'application/vnd.github+json',
    'User-Agent': 'dockyard-panel',
    'X-GitHub-Api-Version': '2022-11-28',
  };
  if (config.templatesToken) headers.Authorization = `Bearer ${config.templatesToken}`;
  return headers;
}

/** A short, safe description of a failed response. Never includes headers or the token. */
async function describeFailure(res: Response): Promise<string> {
  let detail = '';
  try {
    const body = (await res.json()) as { message?: string };
    if (body?.message) detail = `: ${body.message}`;
  } catch {
    /* a non-JSON body is fine, the status is the useful part */
  }
  if (res.status === 404) {
    return `${res.status}${detail || ': not found'}. A private repository looks the same as a missing one to an anonymous fetch; the templates repository has to be public.`;
  }
  if (res.status === 403 || res.status === 429) {
    return `${res.status}${detail || ''}. The anonymous GitHub API limit is 60 requests an hour per address; set DOCKYARD_TEMPLATES_TOKEN to raise it.`;
  }
  return `${res.status}${detail}`;
}

/**
 * Which files in the repository are templates.
 *
 * `templates/` is the layout this repository uses and the one its README documents, so when that
 * folder is there it is the whole answer. A repository that simply puts JSON at its root is read as
 * well, because that is the shape someone reaches for first. A JSON file somewhere else is not a
 * template: a project that keeps a folder called `templates` next to its own `tsconfig.json` must not
 * have the config read as one.
 */
export function selectTemplatePaths(paths: string[]): string[] {
  const candidates = paths
    .filter((p) => /\.json$/i.test(p))
    .filter((p) => !isParked(path.basename(p)))
    .filter((p) => !p.startsWith('node_modules/') && !p.includes('/node_modules/'));

  const inFolder = candidates.filter((p) => p.startsWith('templates/'));
  if (inFolder.length > 0) return inFolder;

  // At the root there is no folder to say what is a template, so a handful of filenames that are
  // never one are skipped. Inside `templates/` everything is a template, which is the layout to use
  // if the repository also happens to hold a project of its own.
  return candidates.filter((p) => !p.includes('/') && !ROOT_FILES_THAT_ARE_NOT_TEMPLATES.has(p));
}

/**
 * Fetch every template file from the repository into memory.
 *
 * Throws on any failure, having written nothing: the caller decides what to do with the cache.
 */
async function downloadTemplates(): Promise<{
  commit: string;
  files: Array<{ path: string; name: string; text: string }>;
  bytes: number;
}> {
  const repo = config.templatesRepo;
  const branch = config.templatesBranch;

  const treeRes = await fetch(
    `${config.templatesApiBase}/repos/${repo}/git/trees/${encodeURIComponent(branch)}?recursive=1`,
    { headers: apiHeaders(), signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) },
  );
  if (!treeRes.ok) throw new Error(await describeFailure(treeRes));

  const tree = (await treeRes.json()) as { tree?: TreeEntry[]; truncated?: boolean; sha?: string };
  if (tree.truncated) {
    throw new Error(
      `the repository tree is truncated, so it has more files than the GitHub API returns in one call; keep the templates repository to a single folder`,
    );
  }

  const blobs = (tree.tree ?? []).filter(
    (entry): entry is TreeEntry & { path: string } =>
      entry.type === 'blob' && typeof entry.path === 'string',
  );

  const wanted = selectTemplatePaths(blobs.map((entry) => entry.path)).sort((a, b) => a.localeCompare(b));

  if (wanted.length > MAX_FILES) {
    throw new Error(`${wanted.length} template files in the repository, over the ${MAX_FILES} limit`);
  }

  const files: Array<{ path: string; name: string; text: string }> = [];
  let bytes = 0;

  for (const filePath of wanted) {
    const res = await fetch(
      `${config.templatesRawBase}/${repo}/${encodeURIComponent(branch)}/${filePath}`,
      { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) },
    );
    if (!res.ok) throw new Error(`could not read ${filePath}: ${res.status}`);
    const text = await res.text();
    if (text.length > MAX_FILE_BYTES) {
      throw new Error(`${filePath} is ${text.length} bytes, over the ${MAX_FILE_BYTES} byte limit`);
    }
    bytes += text.length;
    if (bytes > MAX_TOTAL_BYTES) {
      throw new Error(`the repository holds more than ${MAX_TOTAL_BYTES} bytes of template files`);
    }
    // Flattened to a basename: the panel reads one directory, so a nested layout in the repository
    // is fine, but two files with the same name in different folders would collide.
    const name = path.basename(filePath);
    if (files.some((f) => f.name === name)) {
      throw new Error(`two files in the repository are both named ${name}; rename one of them`);
    }
    files.push({ path: filePath, name, text });
  }

  return { commit: tree.sha ?? '', files, bytes };
}

/**
 * Replace the cache directory with a fresh copy.
 *
 * Written to a temporary directory first and swapped in with two renames, so the reconcile that
 * follows either sees the whole previous cache or the whole new one, never a half-written mix.
 */
function writeCache(dir: string, files: Array<{ name: string; text: string }>): void {
  const tmp = `${dir}.tmp`;
  fs.rmSync(tmp, { recursive: true, force: true });
  fs.mkdirSync(tmp, { recursive: true });
  for (const file of files) {
    fs.writeFileSync(path.join(tmp, file.name), file.text);
  }
  // The old cache is moved aside rather than deleted first: if the second rename fails the
  // previous directory is still on disk and the next pull can recover.
  const old = `${dir}.old`;
  fs.rmSync(old, { recursive: true, force: true });
  if (fs.existsSync(dir)) fs.renameSync(dir, old);
  try {
    fs.renameSync(tmp, dir);
  } catch (err) {
    if (!fs.existsSync(dir) && fs.existsSync(old)) fs.renameSync(old, dir);
    throw err;
  }
  fs.rmSync(old, { recursive: true, force: true });
}

/**
 * Pull the repository into the cache.
 *
 * Never throws. A failure is reported and the previous cache is left untouched, which is what makes
 * "the network was down" a non-event rather than a reason for templates to disappear.
 */
export async function pullRemoteTemplates(): Promise<TemplateRemotePull> {
  const base: TemplateRemotePull = {
    at: new Date().toISOString(),
    repo: config.templatesRepo,
    branch: config.templatesBranch,
    commit: lastPull?.commit ?? null,
    fetched: false,
    stale: false,
    files: 0,
    bytes: 0,
    message: null,
    errors: [],
  };

  if (!remoteTemplatesEnabled()) {
    return { ...base, message: 'No template repository is configured.' };
  }

  try {
    const { commit, files, bytes } = await downloadTemplates();
    writeCache(config.templateRemoteDir, files);
    lastPull = { ...base, commit, fetched: true, files: files.length, bytes };
    return lastPull;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    // Keep the commit we last saw, so the card can still say what the cached files came from.
    lastPull = { ...base, stale: true, message };
    logger.warn('templates: could not pull the template repository', {
      repo: config.templatesRepo,
      branch: config.templatesBranch,
      error: message,
    });
    return lastPull;
  }
}

/**
 * Pull if the cache is older than the refresh window, then reconcile.
 *
 * A single in-flight promise, because the list request and the status request fire together on a
 * page load and two simultaneous pulls would both spend an API call.
 */
export function pullRemoteTemplatesOnce(): Promise<TemplateRemotePull> {
  if (!inFlightPull) {
    inFlightPull = pullRemoteTemplates().finally(() => {
      inFlightPull = null;
    });
  }
  return inFlightPull;
}

function pullIsDue(): boolean {
  if (!lastPull || !lastPull.fetched) return true;
  const age = Date.now() - Date.parse(lastPull.at);
  return !Number.isFinite(age) || age > config.templatesRefreshMinutes * 60_000;
}

export type TemplateRemoteState = {
  pull: TemplateRemotePull | null;
  reconcile: TemplateFileSync | null;
  /** Template files sitting in the cache right now. */
  cached: number;
};

/**
 * Bring the remote source up to date, as far as the refresh window allows.
 *
 * Called from the read routes. Cheap when nothing is due: one `readdir` on the cache.
 */
export async function maybeSyncRemoteTemplates(force = false): Promise<TemplateRemoteState | null> {
  if (!remoteTemplatesEnabled()) return null;

  if (pullIsDue()) {
    // A failed pull is not fatal: the reconcile below still runs against whatever the cache holds,
    // so the table stays consistent with the files on disk.
    await pullRemoteTemplatesOnce();
  }

  // The one case that must not reconcile: the pull failed and there is no cache at all. Reconciling
  // against a directory that does not exist reads as "every remote template was deleted" and would
  // wipe the rows, which is exactly the wrong answer to "the network was down".
  if (lastPull?.stale && !fs.existsSync(config.templateRemoteDir)) {
    return { pull: lastPull, reconcile: null, cached: 0 };
  }

  // `force` skips the directory stamp. A read uses it when a higher-precedence source just removed a
  // row, because that row may be one this source still defines: removing a local override has to let
  // the repository version back in, and the cache has not changed, so the stamp would say there is
  // nothing to do.
  const report = force
    ? await reloadTemplateSource(config.templateRemoteDir, 'remote')
    : await maybeResyncTemplateSource(config.templateRemoteDir, 'remote');

  return {
    pull: lastPull,
    reconcile: report ?? lastTemplateSync('remote', config.templateRemoteDir),
    cached: scanTemplateFiles(config.templateRemoteDir).specs.length,
  };
}

/** Force a pull and a reconcile, whatever the refresh window says. Used by the admin action. */
export async function syncRemoteTemplates(): Promise<{
  pull: TemplateRemotePull;
  reconcile: TemplateFileSync;
  cached: number;
}> {
  const pull = await pullRemoteTemplates();
  const reconcile = await syncTemplateSource(config.templateRemoteDir, 'remote');
  return { pull, reconcile, cached: scanTemplateFiles(config.templateRemoteDir).specs.length };
}

/** What the diagnostics route reports about the remote source. */
export function remoteStatus(): {
  enabled: boolean;
  repo: string;
  branch: string;
  dir: string;
  refreshMinutes: number;
  authenticated: boolean;
  exists: boolean;
  cached: number;
  pull: TemplateRemotePull | null;
  lastSync: TemplateFileSync | null;
  errors: Array<{ file: string; errors: string[] }>;
} {
  const scan = scanTemplateFiles(config.templateRemoteDir);
  return {
    ...remoteTemplatesConfig(),
    exists: scan.exists,
    cached: scan.specs.length,
    pull: lastPull,
    lastSync: lastTemplateSync('remote', config.templateRemoteDir),
    errors: scan.entries.filter((e) => e.errors.length > 0).map((e) => ({ file: e.file, errors: e.errors })),
  };
}

/** Test hook: forget the last pull and let the next call fetch again. */
export function resetRemoteTemplates(): void {
  lastPull = null;
  inFlightPull = null;
}
