-- Dockyard — allow templates that come from a JSON file on disk.
--
-- The catalog can now arrive from three places, in this order of precedence:
--
--   user     a template authored in the panel (highest: the most recent explicit intent)
--   file     a *.json file dropped into DOCKYARD_TEMPLATE_DIR by the operator
--   builtin  the catalog compiled into the image (templates/catalog.ts)
--
-- The `file` source is what lets a new template appear without rebuilding the image, which is the
-- point: the template directory is a bind mount, so the operator adds a file and refreshes.
--
-- The original CHECK admitted only ('builtin','user'), so a file-sourced row could not be stored
-- at all. The constraint is dropped by name rather than looked up: Postgres named it
-- templates_source_check when 001_init.sql created it inline on the column, and a migration that
-- silently did nothing because it could not find the constraint would be worse than one that
-- fails loudly.

alter table templates drop constraint if exists templates_source_check;

alter table templates add constraint templates_source_check
  check (source in ('builtin', 'user', 'file'));

-- The sync compares the set of file-sourced slugs against the files on disk on every scan, and
-- the delete side of that is a `where source = 'file'` sweep, so the source column wants an index
-- once a catalog is large enough that a sequential scan is not free.
create index if not exists templates_source_idx on templates (source);
