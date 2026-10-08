-- Dockyard — add the LocalTunnel exposure mode.
--
-- tunnels.mode was constrained to the two Cloudflare modes. LocalTunnel is a third
-- way to reach a container from outside: no Cloudflare account, no DNS, no public
-- IP. The constraint has to admit it or the insert fails.
--
-- The constraint is dropped by name rather than by looking it up: Postgres named it
-- tunnels_mode_check when 001_init.sql created it inline on the column, and a
-- migration that silently does nothing because it could not find the constraint
-- would be worse than one that fails loudly.

alter table tunnels drop constraint if exists tunnels_mode_check;

alter table tunnels add constraint tunnels_mode_check
  check (mode in ('quick', 'named', 'localtunnel'));
