-- Dockyard — the template repository is the source of truth.
--
-- The catalog is no longer compiled into the image. It arrives from three places, in this order of
-- precedence:
--
--   user     a template authored in the panel (highest: the most recent explicit intent)
--   file     a *.json file dropped into DOCKYARD_TEMPLATE_DIR by the operator
--   remote   a *.json file pulled from DOCKYARD_TEMPLATES_REPO into a local cache
--
-- `builtin` rows are deleted rather than left alone. The source no longer exists, so a row claiming
-- it would be un-editable and un-deletable through the API, would answer a `source=builtin` filter
-- that the UI no longer offers, and would shadow the repository row of the same slug forever.
--
-- Deleting them costs nothing on an install that can reach the repository: the next reconcile pulls
-- the same templates back from the cache as `remote` rows. It is only visible on an install that
-- cannot, which starts with an empty catalog rather than a stale compiled copy. That is the trade the
-- repository exists to make.
--
-- The constraint is dropped by name rather than looked up, so a migration that silently did nothing
-- because it could not find it fails loudly instead.

delete from templates where source = 'builtin';

alter table templates drop constraint if exists templates_source_check;

alter table templates add constraint templates_source_check
  check (source in ('user', 'file', 'remote'));