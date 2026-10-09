// Dockyard — template fixtures and on-disk template readers for the server test suite.
//
// The panel does not ship a catalog any more. A template arrives from the repository, from a local
// directory, or from the panel itself, and none of them are compiled into the code, so there is
// nothing for a test to import. Two things replace that:
//
//   * `fixtures/templates/*.json` — concrete specs to render and deploy. They are copies of the
//     repository's own files, which is what the panel would have pulled.
//   * `readTemplateDir()` — reads templates where they actually live now, so the integrity check
//     still looks at the real specs rather than at a fixture.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { query } from '../../src/db/pool.ts';

/** Mirrors the route's own union; the server does not export it. */
type TemplateSource = 'user' | 'file' | 'remote';

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, '..', '..', '..');

const FIXTURE_DIR = path.join(here, 'templates');

/** Templates the panel does not ship but the repository does: in this repo, always readable. */
export const EXAMPLES_DIR = path.join(repoRoot, 'deploy', 'template-examples');

/** A checkout of the templates repository, when one sits next to this repo. */
export const CHECKOUT_DIR = path.join(repoRoot, '..', 'dockyard-templates', 'templates');

type RawSpec = Record<string, unknown>;

/**
 * Every template in a directory, flattened out of any of the three accepted file shapes.
 *
 * A file that will not parse contributes nothing rather than throwing: whether a malformed file is
 * reported and skipped is `template-files.test.ts`'s business, not this reader's.
 */
export function readTemplateDir(dir: string): RawSpec[] {
  if (!fs.existsSync(dir)) return [];
  const out: RawSpec[] = [];
  for (const entry of fs.readdirSync(dir).sort()) {
    if (!/\.json$/i.test(entry) || entry.startsWith('.') || entry.startsWith('_')) continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(fs.readFileSync(path.join(dir, entry), 'utf8'));
    } catch {
      continue;
    }
    const list = Array.isArray(parsed)
      ? parsed
      : Array.isArray((parsed as { templates?: unknown }).templates)
        ? (parsed as { templates: unknown[] }).templates
        : [parsed];
    for (const candidate of list) {
      if (candidate && typeof (candidate as RawSpec).slug === 'string') out.push(candidate as RawSpec);
    }
  }
  return out;
}

/** Every fixture spec, sorted by slug so the tests are deterministic. */
export function fixtureSpecs(): RawSpec[] {
  return readTemplateDir(FIXTURE_DIR).sort((a, b) => String(a.slug).localeCompare(String(b.slug)));
}

/** One fixture by slug. A missing fixture is a mistake in the test, so it throws. */
export function fixtureSpec(slug: string): RawSpec {
  const found = fixtureSpecs().find((s) => s.slug === slug);
  if (!found) throw new Error(`no fixture template for slug ${slug}`);
  return found;
}

/**
 * Put the fixtures in the `templates` table, the way a pull or a file would.
 *
 * `remote` is the lowest-precedence source, so a fixture never outranks a row a test wrote on
 * purpose. Pass a different source when a test needs the fixtures to sit at another level.
 */
export async function seedFixtureTemplates(source: TemplateSource = 'remote'): Promise<void> {
  for (const spec of fixtureSpecs()) {
    await query(
      `insert into templates (slug, name, category, icon, description, spec, source)
       values ($1, $2, $3, $4, $5, $6::jsonb, $7)
       on conflict (slug) do update set spec = excluded.spec, source = excluded.source`,
      [
        spec.slug,
        spec.name ?? spec.slug,
        spec.category ?? 'other',
        spec.icon ?? '',
        spec.description ?? '',
        JSON.stringify(spec),
        source,
      ],
    );
  }
}

/** Remove every fixture row, whichever source it currently carries. */
export async function clearFixtureTemplates(): Promise<void> {
  const slugs = fixtureSpecs().map((s) => String(s.slug));
  if (slugs.length === 0) return;
  await query('delete from templates where slug = any($1::text[])', [slugs]);
}
