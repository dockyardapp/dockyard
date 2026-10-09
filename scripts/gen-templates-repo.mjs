// Generate the public templates repository from the panel's own catalog.
//
// The repository at github.com/EliasL-git/templates is what the panel pulls live, so its contents
// have to match what the panel ships. Generating them from `builtinTemplates()` is what guarantees
// that: there is one source of truth for a built-in template, and this script copies it out.
//
//   node --experimental-strip-types scripts/gen-templates-repo.mjs <output-dir>
//
// Writes one JSON file per template into <output-dir>/templates/, plus a README. It does not touch
// git: committing and pushing is a separate, deliberate step.
//
// The built-in catalog is the panel's starting point; the files in deploy/template-examples/ are
// templates the panel does not ship, and they go in the same folder so the repository is the whole
// set in one place.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, '..');

const outDir = process.argv[2];
if (!outDir) {
  console.error('usage: node --experimental-strip-types scripts/gen-templates-repo.mjs <output-dir>');
  process.exit(2);
}

const { builtinTemplates } = await import('../server/src/templates/catalog.ts');
const { validateSpec } = await import('../server/src/templates/schema.ts');

const examplesDir = path.join(repoRoot, 'deploy', 'template-examples');
const templatesDir = path.join(outDir, 'templates');

/** Every spec, built-in first, then whatever the examples add. */
function collect() {
  const specs = builtinTemplates().map((spec) => ({ spec, origin: 'built-in' }));

  for (const name of fs.readdirSync(examplesDir).filter((n) => n.endsWith('.json')).sort()) {
    const raw = JSON.parse(fs.readFileSync(path.join(examplesDir, name), 'utf8'));
    const items = Array.isArray(raw) ? raw : Array.isArray(raw.templates) ? raw.templates : [raw];
    for (const item of items) specs.push({ spec: item, origin: `deploy/template-examples/${name}` });
  }
  return specs;
}

const specs = collect();

// A duplicate slug would be a file that silently shadows another on the next pull, so refuse to
// write the repository at all rather than ship the ambiguity.
const seen = new Map();
for (const { spec, origin } of specs) {
  const existing = seen.get(spec.slug);
  if (existing) {
    console.error(`  duplicate slug "${spec.slug}" in ${origin} and ${existing}`);
    process.exit(1);
  }
  seen.set(spec.slug, origin);
}

// Same schema the panel validates with, so a template that lands in the repository is one the
// panel can actually load. Failing here is much cheaper than failing on every install.
let invalid = 0;
for (const { spec, origin } of specs) {
  const result = validateSpec(spec);
  if (!result.ok) {
    invalid += 1;
    console.error(`  invalid spec for "${spec.slug}" (${origin}): ${result.errors.join('; ')}`);
  }
}
if (invalid > 0) process.exit(1);

fs.rmSync(templatesDir, { recursive: true, force: true });
fs.mkdirSync(templatesDir, { recursive: true });

const written = [];
for (const { spec, origin } of specs) {
  // One file per template, named after the slug. The panel reads the slug from inside the file, so
  // the name is for humans: it makes "add a template" mean "add one file" and keeps diffs readable.
  const file = path.join(templatesDir, `${spec.slug}.json`);
  fs.writeFileSync(file, `${JSON.stringify(spec, null, 2)}\n`);
  written.push({ slug: spec.slug, name: spec.name, category: spec.category, image: `${spec.image}:${spec.tag}`, origin });
}

const builtins = written.filter((w) => w.origin === 'built-in');
const extras = written.filter((w) => w.origin !== 'built-in');

const table = (rows) =>
  rows.map((r) => `| \`${r.slug}\` | ${r.name} | ${r.category} | \`${r.image}\` |`).join('\n');

const readme = `# Dockyard templates

Template files for [Dockyard](https://github.com/EliasL-git/dockyard), the Docker panel. The panel
pulls this repository live and serves what it finds here, so a template added in this repository
appears in every install on the next refresh. No release, no rebuild, no restart.

${written.length} templates: ${builtins.length} that ship with the panel, and ${extras.length} extras.

## Adding a template

Add a \`*.json\` file to \`templates/\`. Name it after the template's \`slug\`. That is the whole
process.

\`\`\`json
{
  "schemaVersion": 1,
  "slug": "my-service",
  "name": "My Service",
  "category": "other",
  "icon": "📦",
  "description": "One line, shown on the card.",
  "image": "vendor/image",
  "tag": "1.2.3",
  "ports": [{ "container": 8080, "label": "Web UI", "defaultHost": 8080 }],
  "env": [
    {
      "key": "ADMIN_PASSWORD",
      "label": "Admin password",
      "required": true,
      "secret": true,
      "description": "Required. Set before deploying."
    }
  ],
  "volumes": [{ "container": "/data", "label": "Data", "named": true }],
  "restartPolicy": "unless-stopped"
}
\`\`\`

Rules worth knowing:

- The \`slug\` is the identity. Two files claiming one slug is an error, and the panel reports it
  rather than picking one.
- \`image\` and \`tag\` must be real and published. Pin a tag; do not use \`latest\`.
- A file whose name starts with \`.\` or \`_\` is ignored by the panel, which is how you park a
  template without deleting it.
- Unknown fields are rejected, not ignored, so a typo in \`restartPolicy\` is reported instead of
  quietly doing nothing.
- \`secret: true\` masks the value in the deploy preview and stores \`***\` instead of the value, so a
  password never lands in the panel's database in the clear.

### Field reference

| Field | Required | Notes |
| --- | --- | --- |
| \`schemaVersion\` | yes | \`1\` |
| \`slug\` | yes | lowercase kebab-case, unique across the catalog |
| \`name\` | yes | shown on the card |
| \`category\` | yes | \`database\`, \`web\`, \`monitoring\`, \`storage\`, \`devtools\`, \`messaging\`, \`other\` |
| \`icon\` | yes | used when the panel has no brand mark for the slug |
| \`description\` | yes | one line |
| \`image\` | yes | the upstream image, without the tag |
| \`tag\` | yes | a real published tag |
| \`ports[]\` | no | \`{ container, label?, defaultHost? }\` |
| \`env[]\` | no | \`{ key, label?, default?, required?, secret?, description? }\` |
| \`volumes[]\` | no | \`{ container, label?, named? }\` |
| \`restartPolicy\` | yes | \`no\`, \`always\`, \`unless-stopped\`, \`on-failure\` |
| \`healthcheck\` | no | \`{ test: string[], intervalSec, timeoutSec, retries }\` |
| \`command\` / \`entrypoint\` | no | string arrays, passed through to Docker |
| \`notes\` | no | shown under the deploy form |
| \`docsUrl\` | no | linked from the deploy form |

## What is in here

These ${builtins.length} match the catalog the panel ships. Editing one here changes what every
install offers, which is the point, but it also means the panel's own copy is no longer what you
see: a change here is a deliberate override, not a patch.

| Slug | Name | Category | Image |
| --- | --- | --- | --- |
${table(builtins)}

Extras, which the panel does not ship on its own:

| Slug | Name | Category | Image |
| --- | --- | --- | --- |
${table(extras)}

## Precedence

A panel resolves a template from the highest source that offers it:

1. a template someone edited in the panel
2. a \`*.json\` file on that install's own host
3. this repository
4. the catalog compiled into the panel

So an install can override anything here with a local file, and pulling can never undo that. See
\`deploy/template-examples/\` in the Dockyard repository for the local-file form of the same thing.

## Generated, mostly

The files here are produced from the panel's own catalog by
\`scripts/gen-templates-repo.mjs\`, so a built-in template and its file cannot drift apart. Extras
are copied from \`deploy/template-examples/\`. Editing a file here by hand is fine, but the next
run of the generator will overwrite it: make the change in the panel's catalog instead if it is a
template the panel ships.
`;

fs.writeFileSync(path.join(outDir, 'README.md'), readme);

console.log(`  wrote ${written.length} templates to ${templatesDir}`);
for (const w of written) console.log(`    ${w.slug.padEnd(16)} ${w.image.padEnd(38)} ${w.origin}`);
console.log(`  wrote ${path.join(outDir, 'README.md')}`);
