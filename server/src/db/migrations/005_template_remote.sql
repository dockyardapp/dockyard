-- Dockyard — allow templates that come from a repository over the network.
--
-- The catalog can now arrive from four places, in this order of precedence:
--
--   user     a template authored in the panel (highest: the most recent explicit intent)
--   file     a *.json file dropped into DOCKYARD_TEMPLATE_DIR by the operator
--   remote   a *.json file pulled from DOCKYARD_TEMPLATES_REPO into a local cache
--   builtin  the catalog compiled into the image (templates/catalog.ts)
--
-- `remote` is the same idea as `file` with the directory supplied for you: the panel fetches a
-- public repository of template files, caches them, and reconciles the table against the cache. It
-- exists so a template can be added or corrected centrally, once, instead of on every install.
--
-- The precedence matters more here than anywhere else, because `remote` sits below `file` and
-- `user`: an operator's own file or a template they edited in the panel always wins over the
-- central copy, so pulling can never silently undo local work.
--
-- 004 narrowed the constraint to ('builtin','user','file'), so a remote row could not be stored.
-- The constraint is dropped by name rather than looked up: a migration that silently did nothing
-- because it could not find the constraint would be worse than one that fails loudly.

alter table templates drop constraint if exists templates_source_check;

alter table templates add constraint templates_source_check
  check (source in ('builtin', 'user', 'file', 'remote'));
