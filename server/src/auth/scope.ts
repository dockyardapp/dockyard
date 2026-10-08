// Dockyard — resource scoping (allocation).
//
// The role ladder (`auth/rbac.ts`) decides what a user may *do*. This module
// decides what they may *see*, which is a separate question: an operator whose
// admin allocated them three containers should not be shown the other forty.
//
// The model is deliberately small:
//
//   scope 'all'      every resource on the host (the default, unchanged)
//   scope 'granted'  exactly the resources a grant matches, nothing else
//
// A grant matches either an explicit resource (id, name or slug) or a label
// pair. Labels are the durable form: they survive a container being deleted and
// recreated, which an explicit id does not.
//
// Enforcement lives at the route boundary: list endpoints filter, per-id
// endpoints 404. Scoped-out resources answer 404 rather than 403 on purpose — a
// 403 confirms the resource exists, which lets a restricted user enumerate the
// host by probing ids.
//
// Admins are never scoped. That is enforced in `loadScope` as well as in the
// users API, so no combination of settings can lock an administrator out of the
// panel.

import type { FastifyReply } from 'fastify';
import { many } from '../db/pool.ts';
import { sendError } from './rbac.ts';
import type { PublicUser } from './rbac.ts';

export type ResourceKind =
  | 'container'
  | 'stack'
  | 'volume'
  | 'network'
  | 'image'
  | 'template'
  | 'tunnel';

export const RESOURCE_KINDS: readonly ResourceKind[] = [
  'container',
  'stack',
  'volume',
  'network',
  'image',
  'template',
  'tunnel',
];

export type Grant = {
  id: string;
  resource_kind: ResourceKind;
  resource_id: string | null;
  label_key: string | null;
  label_value: string | null;
};

export type Scope = {
  mode: 'all' | 'granted';
  grants: Grant[];
};

/** The unrestricted scope, for admins and for callers with no user. */
export const ALL_SCOPE: Scope = { mode: 'all', grants: [] };

export function isUnrestricted(scope: Scope | null | undefined): boolean {
  return !scope || scope.mode === 'all';
}

export function grantsFor(scope: Scope | null | undefined, kind: ResourceKind): Grant[] {
  if (!scope) return [];
  return scope.grants.filter((g) => g.resource_kind === kind);
}

/**
 * A resource as far as matching is concerned. Only the fields a grant could
 * reasonably name: an id, a name, a slug, labels, and image repo tags.
 */
export type ScopeTarget = {
  id?: string | null;
  name?: string | null;
  slug?: string | null;
  labels?: Record<string, string> | null;
  repoTags?: string[] | null;
};

/** Short ids are common in the UI; a prefix counts as naming the same resource. */
const MIN_ID_PREFIX = 12;

export function matchesGrant(grant: Grant, target: ScopeTarget): boolean {
  if (grant.resource_id) {
    const wanted = grant.resource_id;
    const id = target.id ?? null;
    if (id) {
      if (id === wanted) return true;
      // A truncated id from the UI should still resolve, but only once it is
      // long enough to be unambiguous.
      if (wanted.length >= MIN_ID_PREFIX && id.startsWith(wanted)) return true;
    }
    if (target.name && target.name === wanted) return true;
    if (target.slug && target.slug === wanted) return true;
    if (target.repoTags?.includes(wanted)) return true;
    return false;
  }

  if (grant.label_key) {
    const labels = target.labels;
    if (!labels) return false;
    return labels[grant.label_key] === grant.label_value;
  }

  return false;
}

/** True when `scope` may see this specific resource. */
export function canSee(
  scope: Scope | null | undefined,
  kind: ResourceKind,
  target: ScopeTarget,
): boolean {
  if (isUnrestricted(scope)) return true;
  return grantsFor(scope, kind).some((g) => matchesGrant(g, target));
}

/** Filter a list down to what `scope` may see. */
export function filterVisible<T>(
  scope: Scope | null | undefined,
  kind: ResourceKind,
  items: T[],
  pick: (item: T) => ScopeTarget,
): T[] {
  if (isUnrestricted(scope)) return items;
  return items.filter((item) => canSee(scope, kind, pick(item)));
}

/**
 * The label a scoped user's new resources should inherit, so that anything they
 * create stays visible to them. Null for unrestricted users, who need nothing.
 *
 * Without this a scoped user could create a container and immediately lose sight
 * of it, which reads as a bug rather than as a policy.
 */
export function grantLabel(
  scope: Scope | null | undefined,
  kind: ResourceKind,
): Record<string, string> | null {
  if (isUnrestricted(scope) || !scope) return null;
  const grant = grantsFor(scope, kind).find((g) => g.label_key && g.label_value !== null);
  if (!grant?.label_key) return null;
  return { [grant.label_key]: grant.label_value ?? '' };
}

/**
 * Load a user's scope. Unrestricted users cost no query at all: their
 * `scope_mode` already arrived on the session join.
 */
export async function loadScope(user: PublicUser | null | undefined): Promise<Scope> {
  if (!user) return ALL_SCOPE;
  // Belt and braces: an admin is never scoped, whatever the row says.
  if (user.role === 'admin') return ALL_SCOPE;
  if (user.scope_mode !== 'granted') return ALL_SCOPE;

  const rows = await many<Grant>(
    `select id, resource_kind, resource_id, label_key, label_value
       from user_grants
      where user_id = $1
      order by resource_kind asc, created_at asc`,
    [user.id],
  );
  return { mode: 'granted', grants: rows };
}

/** Whether this user may exec into containers at all. Admins always may. */
export function canExec(user: PublicUser | null | undefined): boolean {
  if (!user) return false;
  if (user.role === 'admin') return true;
  // The flag is only meaningful for an operator: the exec route requires that
  // role anyway, so granting it to a viewer would have no effect.
  return user.role === 'operator' && user.can_exec === true;
}

/**
 * Answer 404 for a resource the caller may not see, worded exactly like a real
 * miss so it cannot be told apart from one.
 */
export function denyScoped(reply: FastifyReply, kind: ResourceKind, id: string): FastifyReply {
  return sendError(reply, 404, 'not_found', `no ${kind} matches '${id}'`);
}
