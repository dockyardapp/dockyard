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
  login-aside:
    backgroundColor: "{colors.canvas}"
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
- **table:** dense rows divided by `border-subtle` hairlines, header text in `text-tertiary`. Cells
  carry `overflow-wrap: anywhere`, which is what stops a single long unbreakable value (a 64-char
  volume id, a UUID, an email) from setting the column's min-content width and pushing the table
  past its container. `break-word` would not do this: only `anywhere` lowers the min-content width.
  Values that are identifiers rather than prose still opt into `.truncate` with a `title`, so a row
  stays one line instead of wrapping a hash across three.
- **dim / muted:** the two quiet text tiers. `dim` is `text-quaternary`, `muted` is `text-tertiary`;
  both stay at or above 4.5:1 on every surface they appear on.
- **raised-control:** a control sitting on the raised surface uses the solid `border-solid` hairline,
  because a translucent border disappears against a lighter background.
- **nav-item / nav-item-active:** sidebar entries. The active one gets an accent-tinted background
  and brighter text. Only the nav list scrolls: the brand and the account block are pinned, so a short
  window cannot push the account row off the bottom. Below 720px of viewport height the vertical
  rhythm tightens (group-label and item padding) so all ten entries fit without a scrollbar, and below
  620px it tightens again; under that the list scrolls, and the footer stays visible.
- **stat-value:** the large tabular number in a dashboard tile.
- **version-badge:** the running build, in the top bar of every page. Monospace `v0.2.1 · 01638e1`,
  because it is an identifier an operator reads back over the phone rather than prose. It is a link
  to Settings, where the full card lives, and it carries `has-update` (accent-hover text plus a
  violet dot) when the build is behind its branch. It draws from the same payload the update card
  uses, so the version stays on screen when the upstream check fails.
- **update-log:** the updater's own output, inside a banner. Same monospace and near-black as
  `log-view`, but capped at 240px with its own border, because it is a footnote to a status line
  rather than a page of its own.
- **code-inline:** monospace on canvas, for ids and ports inside prose.
- **link / link-hover:** accent violet, brightening to `accent-hover` on hover.
- **pill-*:** status badges. One pill per state, never two.
- **empty:** the no-data state. Its title is a real `h2`, so a screen reader can jump straight to it.
- **error-boundary:** what replaces a view that threw while rendering. It reuses `empty` rather than
  inventing a crash page, so a broken view looks like the app with nothing to show, plus the
  message in `mono` and one button. Mounted twice: around the routed page inside `AppShell`, so a
  broken view keeps its nav and the operator can click away from it, and around the whole app. With
  no boundary at all React unmounts everything it rendered and the operator gets a blank page with
  no way back, which is the one failure a console cannot afford.
- **row-cap:** the footer under a capped table. Names the visible count, the true total and the way
  to see everything.
- **pick-list / pick-row:** the tick-a-resource list in the access dialog. Scrolls past 264px inside
  a `border-subtle` frame at 6px radius, and deliberately borrows `table.data`'s row treatment rather
  than inventing one: 13px cells, 12px padding, the resource name in `text-primary` at weight 510,
  its descriptor (image, state, driver) right-aligned in `text-tertiary` at 13px mono, hairline
  dividers and a `--bg-card` hover. The checkbox keeps the shared `checkbox` sizing.
- **template-logo:** the brand mark on a template card, fitted to a 56x28 slot in `.tpl-head` to
  the left of the template name. Each mark is the product's own SVG path in its own brand colour,
  not a theme token, so a grid of cards stays scannable. Two details are load-bearing:
  - The mark is fitted to the slot through its own tight `viewBox` with
    `preserveAspectRatio="xMinYMid meet"`, not drawn in the vendor's square 24x24 box. The vendor
    normalises each mark to fill either the width or the height of that box, so drawing it square
    renders a wide mark short: MySQL's wordmark came out 13.6px tall and n8n's 10.5px beside marks
    that filled the box. Fitting the tight box gives every mark the same 28px height, and only the
    ones wider than the slot give any up.
  - 28px, not the 20px the emoji used. Rasterised at 20px and magnified, 8 of the 17 marks were not
    legible. At 28px, 14 of them are. 28px also fits the existing 41px card head, so the card layout
    is unchanged. The three that stay abstract at any small size are the ones whose logos are
    abstract to begin with (Uptime Kuma's ring, MinIO's swoosh, Traefik's interlocking lines); that
    is the mark, not a rendering fault.
  A mark whose brand colour falls below 3:1 on the card is lifted within its own hue until it clears
  (Adminer `#34567C` to `#3d6692`, MariaDB `#003545` to `#006b8c`, Vaultwarden `#000000` to
  `#636363`) and flagged `adjusted` in `templateLogos.ts`. A product with no mark falls back to the
  template's own `icon`, which names a glyph in the app's own set, and the mark is `aria-hidden`
  because the name beside it already says which product it is.
- **tunnel-guide:** the reference tab on the Tunnels page, beside the list. It explains what a tunnel
  does, compares the three exposure modes and says which to reach for. Reference material is the
  easiest place to import furniture from somewhere else, so it uses only what the page already owns:
  `card` sections, `table.data` for the mode comparison, and `kv` rows for the when-to-use, status and
  caveat lists. The app has no bullet-list style, so the caveats are `dt`/`dd` rows rather than a `ul`.
  Two details are load-bearing:
  - The comparison is keyed by `TunnelMode` in code, not positional and not by the modes the
    guide happens to render, so adding an exposure mode to the API fails the build until the guide
    answers for it. A guide that silently omits a mode is worse than no guide.
  - The tab lives in the URL (`?tab=how`), like the container detail tabs, so it survives a reload and
    can be linked to.
- **login-aside:** the decorative right half of the login screen, and the one place in the product
  where colour is the point rather than a signal. It replaces a host-status block that used to be
  there: before anyone has signed in, a list of the host's container and image counts is not
  information the reader can act on, and it put the panel's own version on a page reachable by
  anyone who finds the URL. Four details are load-bearing:
  - It is a `div` with `aria-hidden="true"`, not an `aside`. A labelled landmark wrapping no content
    is announced to a screen reader as an empty region, which is worse than no landmark.
  - It carries no text, so it has no contrast budget to spend, and the gradient may be as dim as the
    design wants without a ratio to defend.
  - The grid's mask is centred on the same point and sized to the same extent as the indigo bloom, so
    the lattice is legible where the panel is lit and gone where it is dark. The mask holds full
    strength for the first 55% before falling away: a straight ramp from the centre drops the
    hairlines below the visible threshold long before the light runs out, and the lit area then
    resolves into a small disc sitting inside a larger glow.
  - Both masks reach full transparency before the panel's edges. A gradient still visible where the
    container cuts it reads as a cropped image rather than as light.
  Below 960px the panel is hidden and the page keeps the wash instead, so the phone is not a flat
  void: the same idea at one glow, sized so it too ends before the edges.

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
- Don't use gradients in the working chrome: no gradient buttons, headers, rails or chart fills.
  The single exception is the login screen's decorative half (`login-aside`), which is the only
  surface in the product with no control on it, so it is the only place colour may be the point
  rather than a signal. It draws from the brand indigo family and nothing else.
- Don't use glassmorphism, and don't use emoji anywhere. There is no exception: chrome draws from
  the app's own line-icon set, and a template shows the deployed product's real brand mark. A
  product with no mark shows a glyph from that same set, never a pictograph.
- Don't use pure white as body text. `#f7f8f8` is the ceiling.
- Don't introduce warm greys into the chrome.

## Surface and slop self-audit

Scored against the ten tells in `claude-design`. Result: **1/10**, and the tell that fires is the
exception the brief asked for.

1. Tech gradient: **fires once, deliberately.** The login screen's right half is a gradient. It is
   confined to that one panel; every other surface in the product is flat. It is built from the
   brand's own indigo rather than an invented blue: the lit point measures hue 233 deg against
   `accent`'s 234 deg, held at 26% lightness and 33% saturation, so it reads as the accent emerging
   from darkness instead of a second palette. It is static, so there is nothing to gate behind
   `prefers-reduced-motion`.
2. Generic tech hue: the accent is Linear's indigo-violet, taken from the source system rather than
   chosen by default.
3. Feature-tile grid: absent. The dashboard is stat tiles plus live tables, not three equal cards.
4. Accent rail: absent. No coloured left strips on cards.
5. Unearned blur: absent. No backdrop blur anywhere.
6. Monument stat: bounded. Tiles are one row of small numbers, not oversized display figures. The
   login screen previously showed a host-status block; it now shows nothing at all, so no figure is
   displayed before anyone has signed in.
7. Icon topper: absent. Icons appear in nav and buttons only, never centred above a heading.
8. Center stack: absent from the console. The login form is centred inside its own column, which is
   ordinary for a surface that is one field set, and the page itself is a committed two-column
   split rather than a stack.
9. Default type: Inter and JetBrains Mono are the source system's fonts, declared deliberately with
   system fallbacks.
10. Wrong surface: the brief named this an **operate** surface and the composition matches it. The
    login screen is a **configure** surface, so it keeps one quiet field set and puts the only
    expressive element on the half nobody interacts with.
