// Dockyard — template logo coverage test.
//
// The templates page shows the real brand mark of whatever a template deploys.
// That only holds while every built-in template has one, so this fails when a
// template is added without a mark, rather than letting it quietly fall back to
// an emoji in production.
//
//   export PATH=/root/.hermes/node/bin:$PATH
//   node --test server/test/template-logos.test.ts

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { builtinTemplates } from '../src/templates/catalog.ts';
import { logoFor, TEMPLATE_LOGOS } from '../../web/src/components/templateLogos.ts';

describe('template logos', () => {
  it('has a real brand mark for every built-in template', () => {
    const missing: string[] = [];

    for (const spec of builtinTemplates()) {
      if (!logoFor({ slug: spec.slug, spec: { image: spec.image } })) {
        missing.push(`${spec.slug} (${spec.name}, image ${spec.image})`);
      }
    }

    assert.deepEqual(
      missing,
      [],
      `no brand mark for: ${missing.join(', ')}. Add the product to the generator's BRAND map and regenerate.`,
    );
  });

  it('does not carry marks for products the catalog no longer ships', () => {
    // Keeps the generated module from growing stale: every mark should still be
    // reachable from a template that exists.
    const reachable = new Set<string>();
    for (const spec of builtinTemplates()) {
      const logo = logoFor({ slug: spec.slug, spec: { image: spec.image } });
      if (logo) reachable.add(logo.title);
    }

    const orphans = Object.values(TEMPLATE_LOGOS)
      .map((l) => l.title)
      .filter((title) => !reachable.has(title));

    assert.deepEqual(orphans, [], `marks no template uses: ${orphans.join(', ')}`);
  });

  it('matches a template by its image, not only its slug', () => {
    // The built-ins are slug-matched, so check the image path explicitly with a
    // slug that means nothing.
    const logo = logoFor({ slug: 'not-a-real-slug', spec: { image: 'postgres' } });
    assert.equal(logo?.title, 'PostgreSQL');
  });
});
