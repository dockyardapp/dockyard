/**
 * The real brand mark for a template.
 *
 * Every template shows the product's own mark: `templateLogos.ts` matches on the template's slug or
 * its image name, so a card reads as PostgreSQL's elephant or Grafana's flame rather than as a
 * generic pictograph. There are no emoji in the product, chrome or content.
 *
 * Marks are fitted to a slot rather than drawn in a square box. The vendor
 * normalises every mark to fill either the width or the height of a 24x24 box,
 * so drawing that box square renders a wide mark short: MySQL's wordmark came out
 * 13.6px tall and n8n's 10.5px beside marks that filled the whole box. Fitting the
 * mark's own tight box to the slot gives every one of them the same height, and
 * the ones that are wider than the slot is wide are the only ones that give it up.
 *
 * A product we have no mark for falls back to the template's own `icon`, which names one of the
 * app's glyphs (see Icons.tsx) rather than carrying a pictograph. A neutral glyph is better than
 * showing the wrong product's logo, and a value that is not one of our glyphs falls back again to
 * the generic template glyph rather than rendering an empty slot.
 */

import { Icon, ICON_NAMES } from './Icons';
import type { IconName } from './Icons';
import { logoFor } from './templateLogos';

/**
 * The slot every mark is fitted to.
 *
 * 28px tall, not the 20px the emoji used. At 20px the detailed marks were not
 * legible: rasterised at that size and magnified, PostgreSQL's elephant, MySQL's
 * wordmark, Adminer's cylinder and Traefik's interlocking mark all read as
 * coloured smudges. At 28px they resolve, and it still fits the card head without
 * making it taller. The width covers the widest mark we ship (n8n, 1.9:1).
 */
export const LOGO_SLOT_WIDTH = 56;
export const LOGO_SLOT_HEIGHT = 28;

type Props = {
  slug?: string | null;
  spec?: { image?: string | null } | null;
  /**
   * The template's own icon: the name of one of the app's glyphs, not a pictograph. Shown when
   * there is no brand mark for the product.
   */
  fallback?: string | null;
  height?: number;
  width?: number;
};

export function TemplateLogo({
  slug,
  spec,
  fallback,
  height = LOGO_SLOT_HEIGHT,
  width = LOGO_SLOT_WIDTH,
}: Props) {
  const logo = logoFor({ slug, spec });

  // Decorative either way: the template's name sits beside it, so announcing the
  // mark as well would just make a screen reader say the product twice.
  if (!logo) {
    // The template's `icon` names one of the app's glyphs. A value that is not one of them, such as
    // a pictograph an older template carried, falls back to the generic template glyph rather than
    // rendering an empty slot.
    const glyph: IconName =
      fallback && ICON_NAMES.has(fallback) ? (fallback as IconName) : 'template';
    return (
      <span className="tpl-icon tpl-icon-glyph" aria-hidden="true" style={{ height }}>
        <Icon name={glyph} size={height} />
      </span>
    );
  }

  return (
    <svg
      className="tpl-icon"
      aria-hidden="true"
      focusable="false"
      width={width}
      height={height}
      viewBox={logo.viewBox}
      // Left-aligned, so the marks form a clean edge with the names beside them.
      preserveAspectRatio="xMinYMid meet"
      fill={logo.fill}
    >
      <path d={logo.path} />
    </svg>
  );
}
