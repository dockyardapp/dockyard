// Dockyard — template logo tests.
//
// The templates page shows the deployed product's real brand mark where one is vendored, and falls
// back to the template's own `icon` where one is not. The panel compiles no catalog in any more: the
// templates come from the repository at github.com/dockyardapp/dockyard-templates, which carries
// products beyond the ones with a mark (gitea, caddy, syncthing and friends deliberately have none).
// So there is no longer any such thing as "every shipped template must have a mark".
//
// What is still worth holding down:
//
//   * the generated module is well-formed, so a bad regeneration cannot ship a broken mark
//   * a mark resolves by slug and by image, so the same product is decorated whichever source served
//     it
//   * no mark is left behind for a product the repository no longer ships. That needs the repository
//     itself, so it runs against a checkout sitting next to this one and says so when it cannot.
//
//   export PATH=/root/.hermes/node/bin:$PATH
//   node --test server/test/template-logos.test.ts

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { logoFor, TEMPLATE_LOGOS } from '../../web/src/components/templateLogos.ts';

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, '..', '..');

type Spec = { slug: string; image: string };

/** Every template in a directory, flattened out of any of the three accepted file shapes. A file
 *  that will not parse contributes nothing: a malformed template is template-files.test.ts's
 *  business. */
function specsIn(dir: string): Spec[] {
  if (!fs.existsSync(dir)) return [];
  const out: Spec[] = [];
  for (const entry of fs.readdirSync(dir)) {
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
      const s = candidate as Partial<Spec>;
      if (s && typeof s.slug === 'string' && typeof s.image === 'string') out.push(s as Spec);
    }
  }
  return out;
}

const examples = specsIn(path.join(repoRoot, 'deploy', 'template-examples'));
const checkout = specsIn(path.join(repoRoot, '..', 'dockyard-templates', 'templates'));

/**
 * Products the repository ships that have no mark we can render, and why. Anything else in the
 * repository must resolve to its own mark, so a template added without one fails here rather than
 * quietly showing the neutral glyph.
 *
 *   filebrowser  its mark is a full-colour tile illustration that collapses into a blob at 28px
 *   memcached    no vector mark exists; the project ships a JPEG banner and nothing else
 */
const NO_MARK = ['filebrowser', 'memcached'];

describe('template logos', () => {
  it('carries a well-formed mark for every product it knows', () => {
    const keys = Object.keys(TEMPLATE_LOGOS);
    assert.ok(keys.length > 0, 'the logo map is empty');

    for (const [key, logo] of Object.entries(TEMPLATE_LOGOS)) {
      assert.ok(logo.title.length > 0, `${key}: mark has no title`);
      assert.match(logo.path, /^[Mm]/, `${key}: path does not look like SVG path data`);
      assert.match(logo.fill, /^#[0-9a-fA-F]{6}$/, `${key}: fill is not a six-digit hex colour`);
      assert.match(
        logo.viewBox,
        /^-?[\d.]+ -?[\d.]+ [\d.]+ [\d.]+$/,
        `${key}: viewBox is not four numbers`,
      );
      assert.ok(logo.aspect > 0, `${key}: aspect must be positive`);
    }
  });

  it('has a mark for every template the repository ships, bar the two that have none', () => {
    const specs = [...examples, ...checkout];
    assert.ok(specs.length > 0, 'no template files found to check');

    const missing = specs
      .filter((s) => !logoFor({ slug: s.slug, spec: { image: s.image } }))
      .map((s) => s.slug);

    assert.deepEqual(
      [...new Set(missing)].sort(),
      [...NO_MARK].sort(),
      `unexpected products without a mark: ${missing.join(', ')}. Add the product to ` +
        `scripts/gen-template-logos.py and regenerate.`,
    );
  });

  it('matches a template by its slug and by its image', () => {
    assert.equal(logoFor({ slug: 'postgres', spec: { image: 'postgres' } })?.title, 'PostgreSQL');
    // A slug that means nothing still matches on the image path, which is what decorates a template
    // that came from the repository under a slug the map has never heard of.
    assert.equal(logoFor({ slug: 'not-a-real-slug', spec: { image: 'postgres' } })?.title, 'PostgreSQL');
  });

  it('does not carry marks for products no template uses', () => {
    if (checkout.length === 0) {
      assert.ok(
        true,
        'no templates-repository checkout next to this one; skipping the staleness check',
      );
      return;
    }

    // Keeps the generated module from growing stale: every mark should still be reachable from a
    // template that exists.
    const reachable = new Set<string>();
    for (const s of [...examples, ...checkout]) {
      const logo = logoFor({ slug: s.slug, spec: { image: s.image } });
      if (logo) reachable.add(logo.title);
    }

    const orphans = Object.values(TEMPLATE_LOGOS)
      .map((l) => l.title)
      .filter((title) => !reachable.has(title));

    assert.deepEqual(orphans, [], `marks no template uses: ${orphans.join(', ')}`);
  });
});
