# Template examples

Files in this folder are **not** loaded. They are here to copy from. The panel reads
`data/templates/` next to the compose file, so:

```sh
mkdir -p data/templates
cp deploy/template-examples/gitea.json data/templates/
```

The new template appears in the panel on the next page load. No rebuild, no restart.

## The three shapes

**One template per file.** `gitea.json` and `vaultwarden.json` are bare spec objects.

**An array.** `two-services.json` holds `[ {...}, {...} ]`. Same thing as a pack, without the
wrapper.

**A pack.** `pack-homelab.json` is `{ "templates": [ ... ] }`. Use this when a group of
templates belongs together, since it is one file to add or remove.

A file that holds more than one template is indexed in the panel's file list, so an error
points at `pack-homelab.json[1]` rather than at the whole file.

## Rules

- The file name does not matter, only the `slug` inside it. Two files claiming the same slug
  is an error, and the first file in name order wins.
- A leading `.` or `_` on the file name parks it. The panel ignores it and lists it as parked,
  which is how you switch a template off without deleting it.
- A file wins over a built-in template with the same slug, so you can retag `postgres` or
  change its environment without touching the code. Removing the file brings the built-in back.
- A file never overwrites a template you edited in the panel. The panel's version stays, and
  the file is reported as skipped.
- Removing a file removes the template it defined.
- One malformed file is reported and skipped. The rest still load, and the panel still starts.
- Specs are validated with the same schema the API uses. An unknown field is an error, not a
  silent no-op, so a typo in `restartPolicy` shows up in the panel instead of being ignored.
- The `schemaVersion` field is required and must be `1`.

## Where to look when a file is rejected

The Templates page has a **Template files** card. It lists every file, the templates that came
out of it, and the validation error for any that failed. Administrators get a **Reload files**
button that re-reads the directory immediately instead of waiting for the next page load.

## Field reference

`TemplateSpec`, as defined in `server/src/templates/schema.ts`:

| Field | Required | Notes |
| --- | --- | --- |
| `schemaVersion` | yes | `1` |
| `slug` | yes | lowercase kebab-case, unique across the whole catalog |
| `name` | yes | shown in the list |
| `category` | yes | `database`, `web`, `monitoring`, `storage`, `devtools`, `messaging`, `other` |
| `icon` | yes | a glyph used when no brand logo matches the slug |
| `description` | yes | one line |
| `image` | yes | the real upstream image, without the tag |
| `tag` | yes | a real published tag. Pin it rather than using `latest` |
| `ports[]` | no | `{ container, label?, defaultHost? }` |
| `env[]` | no | `{ key, label?, default?, required?, secret?, description? }` |
| `volumes[]` | no | `{ container, label?, named? }`. `named: true` makes Dockyard create a named volume |
| `restartPolicy` | yes | `no`, `always`, `unless-stopped`, `on-failure` |
| `healthcheck` | no | `{ test: string[], intervalSec, timeoutSec, retries }` |
| `command` / `entrypoint` | no | string arrays, passed through to Docker |
| `notes` | no | shown under the deploy form |
| `docsUrl` | no | linked from the deploy form |

A `secret: true` value is masked in the deploy preview and replaced with `***` before the
stack's values are stored, so it never lands in the database in the clear.
