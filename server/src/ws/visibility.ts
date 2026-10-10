// Dockyard — which WebSocket frames a scoped user may receive.
//
// `auth/scope.ts` decides what a user may *see* and the routes enforce it at the
// boundary. The three WebSocket routes are a second door onto the same
// resources, and they only authenticated: a user allocated three containers
// could read the logs and stats of the other forty over the socket while the
// REST route for the same container answered 404, and `/ws/events` handed them
// every container, tunnel and stack event on the host.
//
// This module is the single answer to "may this socket carry this resource", so
// the three handlers cannot drift from each other or from the routes.
//
// Two rules, both inherited from the route boundary:
//
//   - A resource outside the caller's allocation is refused exactly the way a
//     resource that does not exist is, so a scoped user cannot enumerate the
//     host by probing ids over a socket any more than over a route.
//   - An event that cannot be attributed to a visible resource is not delivered.
//     Failing closed is the only safe direction for a stream.

import { canSee, isUnrestricted } from '../auth/scope.ts';
import type { ResourceKind, Scope, ScopeTarget } from '../auth/scope.ts';
import type { BusEvent } from '../events.ts';

/**
 * A container as far as matching is concerned. The same fields the container
 * routes pass to `canSee` (`asTarget` in `routes/containers.ts`), so a socket
 * and a route cannot disagree about whether a container is visible.
 */
export function containerTarget(container: {
  id: string;
  name: string;
  labels?: Record<string, string> | null;
}): ScopeTarget {
  return { id: container.id, name: container.name, labels: container.labels ?? null };
}

/** May `scope` see this container? */
export function canSeeContainer(
  scope: Scope | null | undefined,
  container: { id: string; name: string; labels?: Record<string, string> | null },
): boolean {
  return canSee(scope, 'container', containerTarget(container));
}

/** Which allocation kind each bus event type belongs to. */
const KIND_BY_TYPE: Record<string, ResourceKind> = {
  container: 'container',
  tunnel: 'tunnel',
  stack: 'stack',
};

function text(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * The resource an event is about, or null when its payload does not say.
 *
 * Publishers are not obliged to send a whole resource (a start event carries an
 * id and a name, a status event an id and a status), so this reads defensively
 * and returns null rather than guessing at one.
 */
function eventTarget(data: unknown): ScopeTarget | null {
  if (!isPlainObject(data)) return null;
  const target: ScopeTarget = {
    id: text(data.id),
    name: text(data.name),
    slug: text(data.slug),
  };
  if (isPlainObject(data.labels)) target.labels = data.labels as Record<string, string>;
  if (Array.isArray(data.repoTags)) target.repoTags = data.repoTags as string[];

  const identified = Boolean(
    target.id || target.name || target.slug || target.labels || target.repoTags,
  );
  return identified ? target : null;
}

/**
 * The container a tunnel event exposes, when the payload names one.
 *
 * A tunnel is visible when it is granted directly *or* when the container it
 * exposes is (`tunnels/visibility.ts`), so a container-granted user keeps seeing
 * their tunnels. The event carries the container's id and name but not its
 * labels, so a label-only container grant cannot be evaluated from the payload
 * and the event is withheld rather than guessed at.
 */
function tunnelContainerTarget(data: unknown): ScopeTarget | null {
  if (!isPlainObject(data)) return null;
  const id = text(data.container_id);
  const name = text(data.container_name);
  if (!id && !name) return null;
  return { id, name };
}

/**
 * May this socket forward this event?
 *
 * Unrestricted subscribers (admins, and any user the panel has not allocated
 * anything to) take every event, which is the unchanged behaviour. A scoped
 * subscriber gets an event only when it matches their grants by the same rules
 * the REST routes use.
 */
export function eventVisible(scope: Scope | null | undefined, ev: BusEvent): boolean {
  if (isUnrestricted(scope)) return true;
  const kind = KIND_BY_TYPE[ev.type];
  if (!kind) return false;

  const target = eventTarget(ev.data);
  if (!target) return false;
  if (canSee(scope, kind, target)) return true;

  if (kind === 'tunnel') {
    const exposed = tunnelContainerTarget(ev.data);
    if (exposed && canSee(scope, 'container', exposed)) return true;
  }
  return false;
}
