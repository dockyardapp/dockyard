#!/usr/bin/env python3
"""Generate web/src/components/templateLogos.ts, the app's vendored brand marks.

The templates page shows each product's real logo. Vendoring only the marks the
built-in templates need keeps the app at zero runtime dependencies and puts ~33 KB
of path data in the bundle instead of a 3464-icon package.

  # 1. the geometry (once, or when a mark changes). Needs a browser on CDP :9333.
  node scripts/measure-logo-metrics.mjs      # writes scripts/logo-metrics.json

  # 2. the module
  npm install --no-save simple-icons@16      # anywhere, e.g. a scratch dir
  python3 scripts/gen-template-logos.py <path-to-node_modules/simple-icons>

Each mark is the vendor's own SVG path from their icons/<slug>.svg, unmodified.
Only the fill colour is adjusted, and only when the brand colour does not read on
the app's dark card.
"""
import colorsys
import json
import pathlib
import re
import sys

REPO = pathlib.Path(__file__).resolve().parent.parent
METRICS = pathlib.Path(__file__).resolve().parent / "logo-metrics.json"
OUT = REPO / "web/src/components/templateLogos.ts"

if len(sys.argv) != 2:
    sys.exit(__doc__)
SI = pathlib.Path(sys.argv[1])
VERSION = json.loads((SI / "package.json").read_text())["version"]

# simple-icons slug -> (what the dockyard catalogue calls it, display name)
BRAND = {
    "postgresql": ("postgres", "PostgreSQL"),
    "mysql": ("mysql", "MySQL"),
    "redis": ("redis", "Redis"),
    "mongodb": ("mongodb", "MongoDB"),
    "adminer": ("adminer", "Adminer"),
    "nginx": ("nginx", "NGINX"),
    "apache": ("httpd", "Apache httpd"),
    "wordpress": ("wordpress", "WordPress"),
    "nodedotjs": ("node-app", "Node.js"),
    "python": ("python-app", "Python"),
    "uptimekuma": ("uptime-kuma", "Uptime Kuma"),
    "grafana": ("grafana", "Grafana"),
    "prometheus": ("prometheus", "Prometheus"),
    "minio": ("minio", "MinIO"),
    "n8n": ("n8n", "n8n"),
    "rabbitmq": ("rabbitmq", "RabbitMQ"),
    "traefikproxy": ("whoami", "Traefik Proxy"),
    "mariadb": ("mariadb", "MariaDB"),
    "caddy": ("caddy", "Caddy"),
    "gitea": ("gitea", "Gitea"),
    "syncthing": ("syncthing", "Syncthing"),
    "vaultwarden": ("vaultwarden", "Vaultwarden"),
}

# Candidate string (a template slug, or the image name's last path segment)
# -> simple-icons slug. Both are lowercased before lookup.
ALIASES = {
    "postgres": "postgresql", "postgresql": "postgresql",
    "mysql": "mysql", "mariadb": "mysql",
    "redis": "redis",
    "mongo": "mongodb", "mongodb": "mongodb",
    "adminer": "adminer",
    "nginx": "nginx",
    "httpd": "apache", "apache": "apache",
    "wordpress": "wordpress",
    "node": "nodedotjs", "node-app": "nodedotjs", "nodedotjs": "nodedotjs",
    "python": "python", "python-app": "python",
    "uptime-kuma": "uptimekuma", "uptimekuma": "uptimekuma",
    "grafana": "grafana",
    "prometheus": "prometheus",
    "minio": "minio",
    "n8n": "n8n",
    "rabbitmq": "rabbitmq",
    "whoami": "traefikproxy", "traefik": "traefikproxy", "traefikproxy": "traefikproxy",
    # MariaDB keeps its own mark: it is a different product from MySQL, and the
    # seal is what an operator scanning the list is looking for.
    "mariadb": "mariadb",
    "caddy": "caddy",
    "gitea": "gitea",
    "syncthing": "syncthing",
    "vaultwarden": "vaultwarden",
}

CARD = (13, 14, 15)  # rgba(255,255,255,0.02) composited over the #08090a canvas
# Whether a brand colour needs lifting at all: the WCAG bar for non-text content.
MIN_CONTRAST = 3.0
# What a lifted mark is lifted *to*. Aiming at the bare minimum left lifted marks sitting at 3.2,
# visibly weaker than brands that never needed touching (PostgreSQL's own blue is 3.99), and a grey
# lifted only to 3.2 reads as a smudge on the card. 4.5 is the bar body text has to clear, so a mark
# we had to alter ends up reading at least as well as one we did not.
LIFT_TARGET = 4.5


def srgb_to_lin(c):
    c = c / 255
    return c / 12.92 if c <= 0.04045 else ((c + 0.055) / 1.055) ** 2.4


def luminance(rgb):
    r, g, b = (srgb_to_lin(x) for x in rgb)
    return 0.2126 * r + 0.7152 * g + 0.0722 * b


def contrast(a, b):
    la, lb = luminance(a), luminance(b)
    hi, lo = max(la, lb), min(la, lb)
    return (hi + 0.05) / (lo + 0.05)


def hex_rgb(value):
    value = value.lstrip("#")
    return tuple(int(value[i:i + 2], 16) for i in (0, 2, 4))


def readable(brand_hex):
    """The brand colour, or its own hue lifted until it reads on the dark card."""
    rgb = hex_rgb(brand_hex)
    if contrast(rgb, CARD) >= MIN_CONTRAST:
        return brand_hex, False
    h, l, s = colorsys.rgb_to_hls(*[c / 255 for c in rgb])
    lo, hi = l, 1.0
    for _ in range(60):
        mid = (lo + hi) / 2
        candidate = tuple(round(c * 255) for c in colorsys.hls_to_rgb(h, mid, s))
        if contrast(candidate, CARD) >= LIFT_TARGET + 0.2:
            hi = mid
        else:
            lo = mid
    # hls_to_rgb returns 0..1 floats; scale before formatting or every channel
    # rounds to 0 or 1 and the mark comes out black.
    lifted = "#" + "".join(f"{max(0, min(255, round(c * 255))):02x}"
                           for c in colorsys.hls_to_rgb(h, hi, s))
    return lifted, True


metrics = {r["tpl"]: r for r in json.loads(METRICS.read_text())}
catalogue = {i["slug"]: i for i in json.loads((SI / "data" / "simple-icons.json").read_text())}

entries = []
for si_slug, (tpl_slug, title) in BRAND.items():
    svg = (SI / "icons" / f"{si_slug}.svg").read_text()
    path = re.findall(r'<path[^>]*\sd="([^"]+)"', svg)
    assert len(path) == 1, f"{si_slug}: expected one path, got {len(path)}"
    m = metrics[tpl_slug]
    entries.append((si_slug, tpl_slug, title,
                    f"{m['x']} {m['y']} {m['w']} {m['h']}", path[0], m["aspect"]))

lines = []
lines.append("// Real brand marks for the products Dockyard's templates deploy.")
lines.append("//")
lines.append("// GENERATED FILE - do not edit by hand.")
lines.append("//   python3 scripts/gen-template-logos.py <path-to-node_modules/simple-icons>")
lines.append("//")
lines.append("// Source: simple-icons (CC0-1.0); each mark is the vendor's own SVG path,")
lines.append("// unmodified. The product names and logos remain the trademarks of their")
lines.append("// owners and identify the software the template deploys.")
lines.append("//")
lines.append("// `fill` is the brand colour, except where that colour does not read on the")
lines.append("// app's dark card (rgba(255,255,255,0.02) over #08090a). Those are lifted")
lines.append("// within their own hue until they clear 4.5:1, and marked `adjusted: true`.")
lines.append("")
lines.append("export type TemplateLogo = {")
lines.append("  /** Human name of the product the mark belongs to. */")
lines.append("  title: string;")
lines.append("  /**")
lines.append("   * A tight box around the mark's own artwork, in the vendor's 24x24 space,")
lines.append("   * not the vendor's full 24x24 box.")
lines.append("   *")
lines.append("   * The vendor normalises each mark to fill either the width or the height of")
lines.append("   * that box, so drawing the box itself into a square slot renders a wide mark")
lines.append("   * short: MySQL's wordmark came out 13.6px tall and n8n's 10.5px next to marks")
lines.append("   * that filled the whole slot. Fitting this box to the slot instead gives every")
lines.append("   * mark the same optical height.")
lines.append("   */")
lines.append("  viewBox: string;")
lines.append("  /** SVG path data, exactly as the vendor ships it. */")
lines.append("  path: string;")
lines.append("  /** Brand hex, or the brand hue lifted to read on the dark card. */")
lines.append("  fill: string;")
lines.append("  /** Width divided by height, for anything that needs the mark's proportions. */")
lines.append("  aspect: number;")
lines.append("  /** True when `fill` is a lifted variant rather than the official colour. */")
lines.append("  adjusted?: true;")
lines.append("};")
lines.append("")
lines.append("export const TEMPLATE_LOGOS: Record<string, TemplateLogo> = {")
for si_slug, tpl_slug, title, view_box, path, aspect in entries:
    brand = "#" + catalogue[si_slug]["hex"]
    fill, adjusted = readable(brand)
    if adjusted:
        lines.append(
            f"  // {brand} is {contrast(hex_rgb(brand), CARD):.2f}:1 on the card; lifted to clear 4.5:1"
        )
    lines.append(f"  {si_slug}: {{")
    lines.append(f"    title: {json.dumps(title)},")
    lines.append(f"    viewBox: {json.dumps(view_box)},")
    lines.append(f"    path: {json.dumps(path)},")
    lines.append(f"    fill: {json.dumps(fill)},")
    lines.append(f"    aspect: {aspect},")
    if adjusted:
        lines.append("    adjusted: true,")
    lines.append("  },")
lines.append("};")
lines.append("")
lines.append("/**")
lines.append(" * Candidate string -> key in TEMPLATE_LOGOS.")
lines.append(" *")
lines.append(" * The candidates are a template's slug and the last segment of its image name,")
lines.append(" * both lowercased, so a user template deploying `redis:7` gets the Redis mark")
lines.append(" * without anyone maintaining a list of their slugs.")
lines.append(" */")
lines.append("const ALIASES: Record<string, string> = {")
for alias in sorted(ALIASES):
    lines.append(f"  {json.dumps(alias)}: {json.dumps(ALIASES[alias])},")
lines.append("};")
lines.append("")
lines.append("/**")
lines.append(" * The mark for a template, or null when we have none for it.")
lines.append(" *")
lines.append(" * Tries the template's slug first, then the image name. Returns null rather")
lines.append(" * than guessing, so an unknown template falls back to its own icon instead of")
lines.append(" * wearing some other product's logo.")
lines.append(" */")
lines.append("export function logoFor(template: {")
lines.append("  slug?: string | null;")
lines.append("  spec?: { image?: string | null } | null;")
lines.append("}): TemplateLogo | null {")
lines.append("  const candidates: string[] = [];")
lines.append("  if (template.slug) candidates.push(template.slug.toLowerCase());")
lines.append("  const image = template.spec?.image;")
lines.append("  if (image) {")
lines.append("    // Drop the digest, then take the last path segment, then drop the tag. In")
lines.append("    // that order: a registry host carries its own colon (`host:5000/team/app`),")
lines.append("    // so splitting the tag off first would throw the repository away with it.")
lines.append("    const withoutDigest = image.split('@')[0];")
lines.append("    const repo = withoutDigest.split('/').pop() ?? '';")
lines.append("    const name = repo.split(':')[0];")
lines.append("    if (name) candidates.push(name.toLowerCase());")
lines.append("  }")
lines.append("")
lines.append("  for (const candidate of candidates) {")
lines.append("    const key = ALIASES[candidate] ?? candidate;")
lines.append("    const logo = TEMPLATE_LOGOS[key];")
lines.append("    if (logo) return logo;")
lines.append("  }")
lines.append("  return null;")
lines.append("}")

OUT.write_text("\n".join(lines) + "\n")
print(f"  wrote {OUT.relative_to(REPO)} ({OUT.stat().st_size} bytes, "
      f"{len(entries)} marks, simple-icons {VERSION})")
