// Dockyard — templates that come from JSON files on disk (owner: agent 4).
//
// The catalog can arrive from three places, in this order of precedence:
//
//   user     a template authored in the panel. This module never touches one.
//   file     a `*.json` file the operator dropped into `config.templateDir`.
//   builtin  the catalog compiled into the image (`catalog.ts`).
//
// The `file` source is the point of this module: the directory is a bind mount, so adding a
// template is dropping a file on the host and refreshing the page, with no rebuild and no
// redeploy. A file wins over a builtin of the same slug, because the file is the more recent
// explicit intent and changing a builtin's tag without a redeploy is a real use for it. It loses
// to a `user` row, because editing a template in the panel and then having a file silently revert
// it would be worse than the reverse. Removing a file removes the template it defined, and a
// builtin it had shadowed comes back.
//
// Nothing here is trusted. Every spec is validated with the same zod schema the API uses, and a
// file that fails is reported and skipped rather than thrown: one bad file must not take the
// catalog down or stop the panel from booting.
//
// Files whose name begins with `.` or `_` are ignored, which is how an operator parks a template
// without deleting it.

import fs from 'node:fs';
import path from 'node:path';
import { config } from '../config.ts';
import { logger } from '../logger.ts';
import { many, query } from '../db/pool.ts';
import type { TemplateSpec } from './schema.ts';
import { validateSpec } from './schema.ts';
import { builtinTemplates, syncBuiltinTemplates } from './catalog.ts';

/** One `*.json` file and what came out of it. */
export type TemplateFileEntry = {
  file: string;
  /** Slugs that loaded from this file, in file order. */
  templates: string[];
  /** Validation failures, empty when the file is clean. */
  errors: string[];
};

export type TemplateFileScan = {
  dir: string;
  exists: boolean;
  /** Valid specs, paired with the file they came from. */
  specs: Array<{ spec: TemplateSpec; file: string }>;
  entries: TemplateFileEntry[];
  /** Files ignored because of a leading `.` or `_`. */
  parked: string[];
};

export type TemplateFileSync = {
  at: string;
  /** Which source this reconcile was for. */
  source: TemplateFileSource;
  dir: string;
  files: number;
  templates: number;
  inserted: number;
  updated: number;
  /** Slugs that shadow a builtin of the same slug. */
  overrides: string[];
  /** Slugs whose row is authored in the panel, so this source was ignored for them. */
  skippedUser: string[];
  /** Rows deleted because their file is gone. */
  removed: string[];
  /** Builtins that came back after the file shadowing them went away. */
  restored: string[];
  /** Per-file failures. A file listed here contributed nothing. */
  errors: Array<{ file: string; errors: string[] }>;
};

/** The two sources that arrive as files on disk, local or fetched. */
export type TemplateFileSource = 'file' | 'remote';

/**
 * Which sources a reconcile is allowed to overwrite.
 *
 * This is what makes the precedence `user > file > remote > builtin` hold no matter which order the
 * reconciles happen to run in: a reconcile overwrites everything below it and never touches
 * anything above. Without it, a pull would silently undo a local file or a panel edit.
 */
const CLAIMABLE: Record<TemplateFileSource, string[]> = {
  file: ['builtin', 'remote', 'file'],
  remote: ['builtin', 'remote'],
};

const JSON_RE = /\.json$/i;
export const MAX_FILES = 500;
export const MAX_FILE_BYTES = 256 * 1024;

export function isParked(name: string): boolean {
  return name.startsWith('.') || name.startsWith('_');
}

function isTemplateFile(name: string): boolean {
  return JSON_RE.test(name) && !isParked(name);
}

/**
 * Turn one file's parsed JSON into a list of candidate specs.
 *
 * Three shapes are accepted, so a single template and a pack of them are both one file:
 *   { ...spec }                    a single template
 *   [ {...}, {...} ]               an array of templates
 *   { "templates": [ {...} ] }     a pack, with room for file-level metadata later
 */
function candidatesOf(parsed: unknown): { items: unknown[]; error?: string } {
  if (Array.isArray(parsed)) return { items: parsed };
  if (parsed !== null && typeof parsed === 'object' && 'templates' in parsed) {
    const packed = (parsed as { templates: unknown }).templates;
    if (!Array.isArray(packed)) {
      return { items: [], error: '"templates" must be an array' };
    }
    return { items: packed };
  }
  return { items: [parsed] };
}

/** Read and validate every template file in `dir`. Never throws: fs and JSON failures are reported. */
export function scanTemplateFiles(dir: string = config.templateDir): TemplateFileScan {
  const scan: TemplateFileScan = { dir, exists: false, specs: [], entries: [], parked: [] };

  let names: string[];
  try {
    scan.exists = fs.statSync(dir).isDirectory();
    names = fs.readdirSync(dir);
  } catch {
    return scan; // no directory is the normal case on a fresh install, not an error
  }

  scan.parked = names.filter(isParked).sort();
  const files = names.filter(isTemplateFile).sort();

  if (files.length > MAX_FILES) {
    scan.entries.push({
      file: '(directory)',
      templates: [],
      errors: [`${files.length} template files found, only the first ${MAX_FILES} are read`],
    });
  }

  const seen = new Map<string, string>(); // slug -> the file that claimed it

  for (const file of files.slice(0, MAX_FILES)) {
    const entry: TemplateFileEntry = { file, templates: [], errors: [] };
    scan.entries.push(entry);

    const full = path.join(dir, file);
    let text: string;
    try {
      const stat = fs.statSync(full);
      if (!stat.isFile()) {
        entry.errors.push('not a regular file');
        continue;
      }
      if (stat.size > MAX_FILE_BYTES) {
        entry.errors.push(`file is ${stat.size} bytes, over the ${MAX_FILE_BYTES} byte limit`);
        continue;
      }
      text = fs.readFileSync(full, 'utf8');
    } catch (err) {
      entry.errors.push(`cannot read: ${err instanceof Error ? err.message : String(err)}`);
      continue;
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch (err) {
      entry.errors.push(`invalid JSON: ${err instanceof Error ? err.message : String(err)}`);
      continue;
    }

    const { items, error } = candidatesOf(parsed);
    if (error) {
      entry.errors.push(error);
      continue;
    }
    if (items.length === 0) {
      entry.errors.push('no templates in this file');
      continue;
    }

    items.forEach((item, index) => {
      const where = items.length > 1 ? `${file}[${index}]` : file;
      const result = validateSpec(item);
      if (!result.ok) {
        entry.errors.push(...result.errors.map((e) => (items.length > 1 ? `[${index}] ${e}` : e)));
        return;
      }
      const slug = result.spec.slug;
      const owner = seen.get(slug);
      if (owner !== undefined) {
        entry.errors.push(
          owner === file
            ? `slug "${slug}" appears twice in this file`
            : `slug "${slug}" is already defined in ${owner}`,
        );
        return;
      }
      seen.set(slug, file);
      entry.templates.push(slug);
      scan.specs.push({ spec: result.spec, file: where });
    });
  }

  return scan;
}

function errorList(scan: TemplateFileScan): Array<{ file: string; errors: string[] }> {
  return scan.entries
    .filter((e) => e.errors.length > 0)
    .map((e) => ({ file: e.file, errors: e.errors }));
}

/**
 * Reconcile the `templates` table with the files on disk.
 *
 * Upserts every valid spec with the given `source`, deletes rows of that source whose file has
 * gone, and re-seeds the builtins so anything a removed file had shadowed comes back.
 */
export async function syncTemplateSource(
  dir: string,
  source: TemplateFileSource,
): Promise<TemplateFileSync> {
  const scan = scanTemplateFiles(dir);
  const builtinSlugs = new Set(builtinTemplates().map((s) => s.slug));
  const claimable = CLAIMABLE[source];

  const report: TemplateFileSync = {
    at: new Date().toISOString(),
    source,
    dir,
    files: scan.entries.filter((e) => e.errors.length === 0).length,
    templates: scan.specs.length,
    inserted: 0,
    updated: 0,
    overrides: scan.specs.filter((s) => builtinSlugs.has(s.spec.slug)).map((s) => s.spec.slug),
    skippedUser: [],
    removed: [],
    restored: [],
    errors: errorList(scan),
  };

  for (const { spec } of scan.specs) {
    try {
      // The `where templates.source = any(...)` is what protects a template authored in the panel:
      // the conflict target matches, the update is skipped, and rowCount comes back 0.
      const res = await query<{ inserted: boolean }>(
        `insert into templates (slug, name, category, icon, description, spec, source)
         values ($1, $2, $3, $4, $5, $6::jsonb, $7)
         on conflict (slug) do update
           set name = excluded.name,
               category = excluded.category,
               icon = excluded.icon,
               description = excluded.description,
               spec = excluded.spec,
               source = excluded.source,
               updated_at = now()
           where templates.source = any($8::text[])
         returning (xmax = 0) as inserted`,
        [
          spec.slug,
          spec.name,
          spec.category,
          spec.icon,
          spec.description,
          JSON.stringify(spec),
          source,
          claimable,
        ],
      );
      if (res.rowCount === 0) {
        report.skippedUser.push(spec.slug);
      } else if (res.rows[0]?.inserted) {
        report.inserted += 1;
      } else {
        report.updated += 1;
      }
    } catch (err) {
      report.errors.push({
        file: scan.specs.find((s) => s.spec.slug === spec.slug)?.file ?? spec.slug,
        errors: [`could not store: ${err instanceof Error ? err.message : String(err)}`],
      });
    }
  }

  // A row of this source whose file is gone has to go with it, otherwise deleting a file would
  // leave the template behind forever. An empty slug list means "no files", so every row goes.
  const slugs = scan.specs.map((s) => s.spec.slug);
  const stale = await many<{ slug: string }>(
    `select slug from templates
      where source = $2 and not (slug = any($1::text[]))`,
    [slugs, source],
  );
  if (stale.length > 0) {
    const gone = stale.map((r) => r.slug);
    await query(`delete from templates where source = $2 and slug = any($1::text[])`, [gone, source]);
    report.removed = gone;
    // Re-seeding restores a builtin that a now-removed file had taken over. The rows are gone, so
    // the insert has nothing to conflict with and the builtin is recreated.
    await syncBuiltinTemplates();
    report.restored = gone.filter((slug) => builtinSlugs.has(slug));
  }

  return report;
}

/** Reconcile the operator's own template directory. */
export function syncTemplateFiles(dir: string = config.templateDir): Promise<TemplateFileSync> {
  return syncTemplateSource(dir, 'file');
}

// The directory is re-stamped on every list request. A `statSync` per file is cheap for a handful
// of files and it is the only way to notice an edit in place: a directory's own mtime does not
// change when the contents of a file inside it do. The stamp is per directory so a test can point
// at its own without disturbing the panel's.
const stamps = new Map<string, string>();
/** In-flight reconciles, so concurrent reads share one sync instead of racing. */
const inFlight = new Map<string, Promise<TemplateFileSync>>();
/** The last reconcile per source, for the diagnostics route. */
const lastSync = new Map<TemplateFileSource, TemplateFileSync>();

function stampOf(dir: string): string {
  try {
    const parts: string[] = [];
    for (const name of fs.readdirSync(dir).sort()) {
      if (isParked(name)) continue;
      try {
        const stat = fs.statSync(path.join(dir, name));
        parts.push(`${name}:${stat.mtimeMs}:${stat.size}`);
      } catch {
        parts.push(`${name}:?`);
      }
    }
    return parts.join('|');
  } catch {
    return '';
  }
}

/**
 * Re-sync only if the directory changed since the last scan.
 *
 * Returns the report when a sync ran, `null` when nothing had changed. This is what makes a new
 * file appear on a page refresh without a restart.
 */
export async function maybeResyncTemplateSource(
  dir: string,
  source: TemplateFileSource,
): Promise<TemplateFileSync | null> {
  const key = `${source}:${dir}`;
  const stamp = stampOf(dir);
  if (stamps.get(key) === stamp) {
    // The stamp is current, but another request may still be reconciling this directory (two reads
    // fire together on a first page load). Wait for it, so a caller never builds a response from a
    // half-applied catalog or reports "no reconcile yet" while one is in flight.
    const pending = inFlight.get(key);
    if (pending) await pending.catch(() => undefined);
    return null;
  }
  stamps.set(key, stamp); // set first, so two concurrent requests do not both sync
  const run = syncTemplateSource(dir, source);
  inFlight.set(key, run);
  try {
    return await run;
  } finally {
    inFlight.delete(key);
  }
}

export function maybeResyncTemplateFiles(dir: string = config.templateDir) {
  return maybeResyncTemplateSource(dir, 'file');
}

/** Force a scan even if nothing changed, and remember it for the diagnostics route. */
export async function reloadTemplateSource(
  dir: string,
  source: TemplateFileSource,
): Promise<TemplateFileSync> {
  const report = await syncTemplateSource(dir, source);
  stamps.set(`${source}:${dir}`, stampOf(dir));
  return report;
}

export function reloadTemplateFiles(dir: string = config.templateDir) {
  return reloadTemplateSource(dir, 'file');
}

/**
 * What the diagnostics route reports: the current scan plus the last sync's result, so an operator
 * can see both "what is on disk right now" and "what the last reconcile actually did".
 */
export function templateFilesStatus(dir: string = config.templateDir): {
  dir: string;
  exists: boolean;
  entries: TemplateFileEntry[];
  parked: string[];
  errors: Array<{ file: string; errors: string[] }>;
  lastSync: TemplateFileSync | null;
} {
  const scan = scanTemplateFiles(dir);
  return {
    dir: scan.dir,
    exists: scan.exists,
    entries: scan.entries,
    parked: scan.parked,
    errors: errorList(scan),
    lastSync: lastSync.get('file')?.dir === dir ? (lastSync.get('file') ?? null) : null,
  };
}

/** Record a sync for the diagnostics route. Called by the routes after a resync. */
export function rememberTemplateFileSync(report: TemplateFileSync): void {
  lastSync.set(report.source, report);
}

/** The last reconcile for a source, if it was for the directory being asked about. */
export function lastTemplateSync(source: TemplateFileSource, dir: string): TemplateFileSync | null {
  const report = lastSync.get(source);
  return report && report.dir === dir ? report : null;
}

/** Test hook: forget the change stamps and the last report. */
export function resetTemplateFileCache(): void {
  stamps.clear();
  inFlight.clear();
  lastSync.clear();
}

export function logTemplateFileSync(report: TemplateFileSync): void {
  const summary = {
    source: report.source,
    dir: report.dir,
    files: report.files,
    templates: report.templates,
    inserted: report.inserted,
    updated: report.updated,
    removed: report.removed.length,
    overrides: report.overrides.length,
    skippedUser: report.skippedUser.length,
  };
  if (report.errors.length > 0) {
    // The file names and the reasons, never the spec contents: a template's env defaults can hold
    // a password, and a log line is not the place for one.
    logger.warn('templates: some template files could not be read', {
      ...summary,
      errors: report.errors.map((e) => `${e.file}: ${e.errors.join('; ')}`),
    });
    return;
  }
  // Named by source: the same reconcile serves the local directory and the repository cache, and
  // an operator reading the log needs to know which one moved.
  const from = report.source === 'remote' ? 'the template repository' : 'files';
  logger.info(`templates: synced from ${from}`, summary);
}
