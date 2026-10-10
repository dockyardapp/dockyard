import { describe, expect, it } from 'vitest';
import { render } from '@testing-library/react';

import { TemplateLogo } from './TemplateLogo';
import { logoFor, TEMPLATE_LOGOS } from './templateLogos';

describe('TemplateLogo', () => {
  it('draws the real brand mark for a known template', () => {
    const { container } = render(<TemplateLogo slug="postgres" spec={{ image: 'postgres' }} />);

    const svg = container.querySelector('svg');
    expect(svg).not.toBeNull();
    // PostgreSQL's own blue, not a theme token.
    expect(svg!.getAttribute('fill')).toBe('#4169E1');
    expect(svg!.querySelector('path')!.getAttribute('d')).toMatch(/^M/);
  });

  it('marks the logo decorative, because the template name sits beside it', () => {
    const { container } = render(<TemplateLogo slug="grafana" />);

    expect(container.querySelector('svg')!.getAttribute('aria-hidden')).toBe('true');
    expect(container.querySelector('svg')!.getAttribute('focusable')).toBe('false');
  });

  it('resolves a user template from its image name', () => {
    // A user template has a slug we have never seen, but it deploys a product we
    // know, so the mark is still the right one.
    const { container } = render(
      <TemplateLogo slug="my-own-cache" spec={{ image: 'redis:7-alpine' }} />,
    );

    expect(container.querySelector('svg')!.getAttribute('fill')).toBe('#FF4438');
  });

  it('ignores a registry host and a digest when matching an image', () => {
    const { container } = render(
      <TemplateLogo slug="private-thing" spec={{ image: 'registry.example.com:5000/prom/prometheus@sha256:abc' }} />,
    );

    expect(container.querySelector('svg')!.getAttribute('fill')).toBe('#E6522C');
  });

  it('falls back to the app glyph rather than another product mark', () => {
    const { container } = render(
      <TemplateLogo slug="totally-unknown" spec={{ image: 'someone/unknown-thing' }} />,
    );

    // No brand mark, and never someone else's: the slot holds one of the app's own glyphs.
    expect(container.querySelector('svg.tpl-icon')).toBeNull();
    expect(container.querySelector('.tpl-icon-glyph svg')).not.toBeNull();
  });

  it('uses the glyph a template names when it is one of ours', () => {
    const generic = render(<TemplateLogo slug="x" spec={{ image: 'x/y' }} />);
    const chosen = render(<TemplateLogo slug="x" spec={{ image: 'x/y' }} fallback="file" />);

    expect(chosen.container.querySelector('path')!.getAttribute('d')).not.toBe(
      generic.container.querySelector('path')!.getAttribute('d'),
    );
  });

  it('never renders a pictograph, even when the template carries one', () => {
    // `icon` names one of the app's glyphs. The pictograph below is deliberate test data: it stands
    // for the emoji an older template carried, and the assertion is that it never reaches the page.
    const generic = render(<TemplateLogo slug="x" spec={{ image: 'x/y' }} fallback="template" />);
    const legacy = render(<TemplateLogo slug="x" spec={{ image: 'x/y' }} fallback="🪪" />);

    expect(legacy.container.textContent).toBe('');
    expect(legacy.container.querySelector('path')!.getAttribute('d')).toBe(
      generic.container.querySelector('path')!.getAttribute('d'),
    );
  });

  it('does not throw on a template with nothing to match on', () => {
    const { container } = render(<TemplateLogo />);
    expect(container.querySelector('.tpl-icon-glyph')).not.toBeNull();
  });
});

describe('templateLogos', () => {
  it('gives every mark a brand fill that reads on the dark card', () => {
    // The card is rgba(255,255,255,0.02) over the #08090a canvas. A mark below 3:1
    // there is a logo nobody can see, which is the whole point of the change.
    const card = [13, 14, 15];
    const linear = (c: number) => {
      const v = c / 255;
      return v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
    };
    const luminance = (rgb: number[]) => {
      const [r, g, b] = rgb.map(linear);
      return 0.2126 * r + 0.7152 * g + 0.0722 * b;
    };
    const contrast = (a: number[], b: number[]) => {
      const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
      return (hi + 0.05) / (lo + 0.05);
    };

    for (const [key, logo] of Object.entries(TEMPLATE_LOGOS)) {
      const hex = logo.fill.replace('#', '');
      const rgb = [0, 2, 4].map((i) => parseInt(hex.slice(i, i + 2), 16));
      expect(contrast(rgb, card), `${key} (${logo.title}) is too dark on the card`).toBeGreaterThanOrEqual(3);
    }
  });

  it('ships a real path and a title for every mark', () => {
    for (const [key, logo] of Object.entries(TEMPLATE_LOGOS)) {
      expect(logo.path.length, `${key} has no path data`).toBeGreaterThan(50);
      expect(logo.title, `${key} has no product title`).toBeTruthy();
      // A tight box, not the vendor's full 24x24 one: four numbers, and never a
      // box that is wider and taller than the mark it is supposed to frame.
      const parts = logo.viewBox.split(' ').map(Number);
      expect(parts, `${key} has a malformed viewBox`).toHaveLength(4);
      expect(parts.every((n) => Number.isFinite(n)), `${key} viewBox is not numeric`).toBe(true);
      expect(logo.aspect, `${key} has no aspect`).toBeGreaterThan(0);
      expect(parts[2] / parts[3], `${key} viewBox disagrees with its aspect`).toBeCloseTo(logo.aspect, 1);
    }
  });

  it('returns null instead of guessing when nothing matches', () => {
    expect(logoFor({ slug: 'nope', spec: { image: 'nope/nope' } })).toBeNull();
    expect(logoFor({})).toBeNull();
  });
});
