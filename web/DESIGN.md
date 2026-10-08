---
version: alpha
name: Dockyard
description: Dense dark operator console for Docker containers, built on Linear's design system.
colors:
  primary: "#08090a"
  canvas: "#08090a"
  panel: "#0f1011"
  surface: "#191a1b"
  raised: "#28282c"
  text-primary: "#f7f8f8"
  text-secondary: "#d0d6e0"
  text-tertiary: "#8a8f98"
  text-quaternary: "#787c84"
  accent: "#5e6ad2"
  accent-press: "#4f5ac2"
  accent-violet: "#7170ff"
  accent-hover: "#828fff"
  border-subtle: "rgba(255, 255, 255, 0.05)"
  border-standard: "rgba(255, 255, 255, 0.08)"
  border-solid: "#23252a"
  success: "#10b981"
  state-running-bg: "#183029"
  state-running-fg: "#34d399"
  state-paused-bg: "#372f1e"
  state-paused-fg: "#f0b232"
  state-error-bg: "#372224"
  state-error-fg: "#f87171"
  state-neutral-bg: "#202124"
  state-neutral-fg: "#8a8f98"
typography:
  h1:
    fontFamily: Inter
    fontSize: 24px
    fontWeight: 590
    lineHeight: 1.33
    letterSpacing: "-0.288px"
  body:
    fontFamily: Inter
    fontSize: 15px
    fontWeight: 400
    lineHeight: 1.5
  label:
    fontFamily: Inter
    fontSize: 12px
    fontWeight: 510
    lineHeight: 1.4
  mono:
    fontFamily: JetBrains Mono
    fontSize: 13px
    fontWeight: 400
    lineHeight: 1.5
rounded:
  micro: 2px
  sm: 4px
  md: 6px
  lg: 8px
  panel: 12px
  pill: 9999px
spacing:
  xs: 4px
  sm: 8px
  md: 16px
  lg: 24px
  xl: 32px
components:
  page:
    backgroundColor: "{colors.primary}"
    textColor: "{colors.text-secondary}"
    typography: "{typography.body}"
  button-primary:
    backgroundColor: "{colors.accent}"
    textColor: "#ffffff"
    typography: "{typography.label}"
    rounded: "{rounded.md}"
    padding: 12px
  button-primary-hover:
    backgroundColor: "{colors.accent-press}"
    textColor: "#ffffff"
    rounded: "{rounded.md}"
  button-ghost:
    backgroundColor: "{colors.surface}"
    textColor: "{colors.text-secondary}"
    typography: "{typography.label}"
    rounded: "{rounded.md}"
    padding: 12px
  button-danger:
    backgroundColor: "{colors.state-error-bg}"
    textColor: "{colors.state-error-fg}"
    typography: "{typography.label}"
    rounded: "{rounded.md}"
    padding: 12px
  input:
    backgroundColor: "{colors.panel}"
    textColor: "{colors.text-primary}"
    typography: "{typography.body}"
    rounded: "{rounded.md}"
    padding: 12px
  card:
    backgroundColor: "{colors.surface}"
    textColor: "{colors.text-secondary}"
    typography: "{typography.body}"
    rounded: "{rounded.lg}"
    padding: 16px
  nav-item:
    backgroundColor: "{colors.panel}"
    textColor: "{colors.text-secondary}"
    typography: "{typography.label}"
    rounded: "{rounded.md}"
  nav-item-active:
    backgroundColor: "{colors.panel}"
    textColor: "{colors.text-primary}"
    typography: "{typography.label}"
    rounded: "{rounded.md}"
  link:
    backgroundColor: "{colors.canvas}"
    textColor: "{colors.accent-violet}"
    typography: "{typography.body}"
  link-hover:
    backgroundColor: "{colors.canvas}"
    textColor: "{colors.accent-hover}"
    typography: "{typography.body}"
  stat-value:
    backgroundColor: "{colors.surface}"
    textColor: "{colors.text-primary}"
    typography: "{typography.h1}"
  code-inline:
    backgroundColor: "{colors.canvas}"
    textColor: "{colors.text-secondary}"
    typography: "{typography.mono}"
  dim:
    backgroundColor: "{colors.canvas}"
    textColor: "{colors.text-quaternary}"
    typography: "{typography.body}"
  raised-panel:
    backgroundColor: "{colors.raised}"
    textColor: "{colors.text-primary}"
    rounded: "{rounded.lg}"
    padding: 16px
  # Borders are drawn as 1px backgrounds rather than a border sub-token: the
  # design.md schema has no border slot, and a hairline really is a filled 1px
  # box. This keeps the three border colours referenced instead of declared and
  # unused.
  divider:
    backgroundColor: "{colors.border-subtle}"
    height: 1px
  divider-strong:
    backgroundColor: "{colors.border-standard}"
    height: 1px
  divider-on-raised:
    backgroundColor: "{colors.border-solid}"
    height: 1px
  pill-running:
    backgroundColor: "{colors.state-running-bg}"
    textColor: "{colors.state-running-fg}"
    typography: "{typography.label}"
    rounded: "{rounded.pill}"
  pill-paused:
    backgroundColor: "{colors.state-paused-bg}"
    textColor: "{colors.state-paused-fg}"
    typography: "{typography.label}"
    rounded: "{rounded.pill}"
  pill-error:
    backgroundColor: "{colors.state-error-bg}"
    textColor: "{colors.state-error-fg}"
    typography: "{typography.label}"
    rounded: "{rounded.pill}"
  pill-neutral:
    backgroundColor: "{colors.state-neutral-bg}"
    textColor: "{colors.state-neutral-fg}"
    typography: "{typography.label}"
    rounded: "{rounded.pill}"
  badge-success:
    backgroundColor: "{colors.surface}"
    textColor: "{colors.success}"
    typography: "{typography.label}"
    rounded: "{rounded.pill}"
  meta-text:
    backgroundColor: "{colors.surface}"
    textColor: "{colors.text-tertiary}"
    typography: "{typography.label}"
  row-hover:
    backgroundColor: "{colors.raised}"
    textColor: "{colors.text-primary}"
    typography: "{typography.body}"
---

## Overview

Dockyard is an **operate** surface: the operator is taking action on things (containers, stacks,
tunnels, images). Selection state and action affordances dominate, so a centered hero or a grid of
equal feature cards would be the wrong composition. The layout is a fixed sidebar plus a working
area of tables, stat tiles and drawers.

The visual language comes from the **Linear** design system (via the `popular-web-designs` skill,
`templates/linear.app.md`). Every neutral, accent, border and elevation value below is Linear's,
not invented: near-black canvases, whisper-thin translucent borders, one chromatic family
(indigo-violet), and a three-weight type scale where 510 is the workhorse and 590 the maximum.

The status colours (`state-*`) are the one extension. Linear ships a single success green and no
warning or danger hue, which a container console cannot do without. They are solid, hand-checked
dark tints of standard accessible reds, ambers and greens, and they only ever appear inside a
status pill.

## Colors

- **Canvas (#08090a):** the app background. Linear's "marketing black" with a cool undertone.
- **Panel (#0f1011):** sidebar, inputs and recessed areas. One luminance step up from canvas.
- **Surface (#191a1b):** cards, dialogs, dropdowns.
- **Raised (#28282c):** hover and elevated rows.
- **Text primary (#f7f8f8):** headings and primary values. Not pure white, to avoid glare.
- **Text secondary (#d0d6e0):** body copy and table cells.
- **Text tertiary (#8a8f98):** metadata and de-emphasised text.
- **Text quaternary (#787c84):** micro-labels only (table headers, nav group labels, timestamps),
  on the canvas, panel and card backgrounds. It clears 4.5:1 there and keeps a visible step below
  tertiary. Linear's own quaternary (#62666d) measures 3.45:1 on this canvas, so it was lifted; the
  dim tier is not used for readable text on the lighter surface tier, where dialogs live.
- **Accent (#5e6ad2):** primary button backgrounds only.
- **Accent violet (#7170ff):** links, active nav items, focus rings.
- **Accent hover (#828fff):** hover state for links and other accent elements.
- **Success (#10b981):** emerald, for verified and healthy states.
- **state-running / paused / error / neutral:** status pill pairs, each a tinted background with a
  brighter foreground of the same hue.

Borders are always translucent white (`border-subtle` at 5%, `border-standard` at 8%), never solid
grey on dark. Solid borders (`border-solid`) are reserved for controls that sit on a raised surface.

## Typography

Inter for everything, JetBrains Mono for ids, ports, image references, logs and JSON. Weight 400
reads, 510 labels and UI, 590 headings. The 300 weight is deliberately absent: this is a console,
not editorial. Numeric output (counts, CPU, memory, byte sizes) uses `font-variant-numeric:
tabular-nums` so columns line up while values change live.

## Layout

A fixed 224px sidebar, a 52px top bar and a content column capped at 1320px. Spacing is an 8px grid
(4, 8, 12, 16, 24, 32). Tables carry the density: 13px cells, sticky uppercase headers at 11px,
compact row padding. Below 760px the sidebar becomes an overlay drawer, and below 620px every table
becomes a stack of labelled cards, so the console works at 390px.

## Elevation & Depth

On dark surfaces shadow reads as nothing, so depth comes from luminance stepping and translucent
borders. Flat canvas, panel at +5% white, surface at +8%, raised at +12%. Dialogs and drawers get a
single soft shadow stack on top of the step, and a `rgba(0,0,0,0.85)` backdrop isolates focus.

## Shapes

Linear's radius scale: 2px for inline tags, 4px for small list items, 6px for buttons and inputs,
8px for cards, 12px for dialogs and drawers, and a full pill for status and filter chips. Radius
signals element size rather than adding decoration.

## Components

- **button-primary:** the single high-emphasis action on a view (Deploy, Create, Pull). White on
  brand indigo, darkening to `accent-press` on hover so the label stays above 4.5:1.
- **button-ghost:** every other action. Near-transparent background, translucent border.
- **button-danger:** stop, kill, remove, prune. Red foreground on a red-tinted background, always
  paired with a confirm step and, for destructive deletes, a typed-name confirmation.
- **input:** panel-coloured field with a `border-standard` border that turns accent violet on focus.
- **card:** surface background, a `border-subtle` border, 8px radius. The container for every table and
  form group.
- **table:** dense rows divided by `border-subtle` hairlines, header text in `text-tertiary`.
- **dim / muted:** the two quiet text tiers. `dim` is `text-quaternary`, `muted` is `text-tertiary`;
  both stay at or above 4.5:1 on every surface they appear on.
- **raised-control:** a control sitting on the raised surface uses the solid `border-solid` hairline,
  because a translucent border disappears against a lighter background.
- **nav-item / nav-item-active:** sidebar entries. The active one gets an accent-tinted background
  and brighter text.
- **stat-value:** the large tabular number in a dashboard tile.
- **code-inline:** monospace on canvas, for ids and ports inside prose.
- **link / link-hover:** accent violet, brightening to `accent-hover` on hover.
- **pill-*:** status badges. One pill per state, never two.
- **empty:** the no-data state. Its title is a real `h2`, so a screen reader can jump straight to it.
- **row-cap:** the footer under a capped table. Names the visible count, the true total and the way
  to see everything.

## Long lists

A Docker host can hold thousands of containers, and rendering all of them costs a DOM node per cell
per poll. Every table renders at most **250 rows** by default (`useRowCap`), with a footer that names
the real total and offers a **Show all** escape hatch.

- The cap applies after filtering, so search reaches the whole list rather than just the visible window.
- The footer is never omitted while rows are hidden. A silently truncated table reads as "this host
  has 250 containers", which is a worse failure than the cap it is hiding.
- The audit log paginates instead (`limit`/`offset`, 50 to 500 rows). It is append-only and the
  operator usually wants a window of history, not the newest N.

Measured on a host with 261 volumes: 250 rows rendered, the footer reported "Showing 250 of 261", and
**Show all** revealed all 261.

## Do's and Don'ts

- Do reserve the accent for interactive elements. Never use it as decoration.
- Do use monospace for anything the operator might copy: ids, image tags, ports, URLs, log lines.
- Do pair every destructive control with a confirm dialog and a disabled or busy state.
- Don't use gradients as decoration, glassmorphism, or emoji in UI chrome. Template icons are data
  and are the one exception.
- Don't use pure white as body text. `#f7f8f8` is the ceiling.
- Don't introduce warm greys into the chrome.

## Surface and slop self-audit

Scored against the ten tells in `claude-design`. Result: 0/10.

1. Tech gradient: none. Flat dark surfaces only.
2. Generic tech hue: the accent is Linear's indigo-violet, taken from the source system rather than
   chosen by default.
3. Feature-tile grid: absent. The dashboard is stat tiles plus live tables, not three equal cards.
4. Accent rail: absent. No coloured left strips on cards.
5. Unearned blur: absent. No backdrop blur anywhere.
6. Monument stat: bounded. Tiles are one row of small numbers, not oversized display figures.
7. Icon topper: absent. Icons appear in nav and buttons only, never centred above a heading.
8. Center stack: absent. The composition is a left rail plus a dense work column.
9. Default type: Inter and JetBrains Mono are the source system's fonts, declared deliberately with
   system fallbacks.
10. Wrong surface: the brief named this an **operate** surface and the composition matches it.
