/**
 * The real brand mark for a template.
 *
 * The templates deploy software that has a logo of its own, and a card that shows
 * PostgreSQL's elephant or Grafana's flame is scannable in a way that an emoji
 * stand-in is not. Marks come from `templateLogos.ts`, matched on the template's
 * slug or its image name. A product with no mark falls back to the template's own
 * icon.
 *
 * Marks are fitted to a slot rather than drawn in a square box. The vendor
 * normalises every mark to fill either the width or the height of a 24x24 box,
 * so drawing that box square renders a wide mark short: MySQL's wordmark came out
 * 13.6px tall and n8n's 10.5px beside marks that filled the whole box. Fitting the
 * mark's own tight box to the slot gives every one of them the same height, and
 * the ones that are wider than the slot is wide are the only ones that give it up.
 *
 * Falls back to the template's own `icon` when we have no mark for it, which is
 * the case for anything a user wrote: showing no logo is better than showing the
 * wrong product's logo.
 */

import { Icon } from './Icons';
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
  /** The template's own icon, shown when there is no brand mark. */
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
    return (
      <span className="tpl-icon tpl-icon-text" aria-hidden="true" style={{ height }}>
        {fallback || <Icon name="template" size={height} />}
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
