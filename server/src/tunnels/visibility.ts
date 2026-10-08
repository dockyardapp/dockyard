// Dockyard — which tunnels a scoped user may see.
//
// Lives in its own module because two callers need it: the tunnel routes (list,
// get, start/stop) and the dashboard counts in `routes/system.ts`. Keeping it in
// one place means the number on the dashboard cannot drift from the length of
// the list.

import { listContainers } from '../docker/index.ts';
import { canSee, isUnrestricted } from '../auth/scope.ts';
import type { Scope } from '../auth/scope.ts';
import type { Tunnel } from './manager.ts';

/**
 * A tunnel is visible when it is granted directly, or when the container it
 * exposes is. A tunnel publishes a port to the internet, so inheriting it from
 * the container is the sensible default: allocating someone a container should
 * not silently leave its public URL off their list.
 */
export async function canSeeTunnel(scope: Scope, tunnel: Tunnel): Promise<boolean> {
  if (isUnrestricted(scope)) return true;
  if (canSee(scope, 'tunnel', { id: tunnel.id, name: tunnel.name })) return true;
  if (!tunnel.container_id && !tunnel.container_name) return false;

  const containers = await listContainers({ all: true }).catch(() => []);
  const match = containers.find(
    (c) =>
      (tunnel.container_id != null &&
        (c.id === tunnel.container_id || c.id.startsWith(tunnel.container_id))) ||
      (tunnel.container_name != null && c.name === tunnel.container_name),
  );
  return match
    ? canSee(scope, 'container', { id: match.id, name: match.name, labels: match.labels })
    : false;
}

/** Filter a tunnel list down to what `scope` may see. */
export async function filterTunnels(scope: Scope, tunnels: Tunnel[]): Promise<Tunnel[]> {
  if (isUnrestricted(scope)) return tunnels;
  const visible: Tunnel[] = [];
  for (const tunnel of tunnels) {
    if (await canSeeTunnel(scope, tunnel)) visible.push(tunnel);
  }
  return visible;
}
