// Dockyard — roles, the public user shape and the API error envelope (owner: agent 2).
//
// Role ladder (contract §6): viewer (read) < operator (write, no delete, no users/settings)
// < admin (all). Enforcement is centralised in `requireRole`, used as a Fastify preHandler,
// never as ad-hoc checks inside handlers.
//
// This module is also the home of the small `sendError` helper so every route file can emit
// the frozen error envelope without importing the Fastify instance itself.

import type { FastifyReply, FastifyRequest } from 'fastify';
import { authenticate } from './sessions.ts';

export type Role = 'admin' | 'operator' | 'viewer';

/** Whether the user sees the whole host, or only what has been allocated. */
export type ScopeMode = 'all' | 'granted';

export type PublicUser = {
  id: string;
  email: string;
  role: Role;
  /** 'granted' means only allocated resources are visible. Admins are never scoped. */
  scope_mode: ScopeMode;
  /** May POST /containers/:id/exec. Separate from the role: exec is root-equivalent. */
  can_exec: boolean;
  created_at: string;
  last_login_at: string | null;
};

const RANK: Record<Role, number> = { viewer: 1, operator: 2, admin: 3 };

export function isRole(value: unknown): value is Role {
  return value === 'admin' || value === 'operator' || value === 'viewer';
}

/** True when `role` is at least `required` on the ladder. */
export function can(role: Role | null | undefined, required: Role): boolean {
  if (!role || !isRole(role)) return false;
  return RANK[role] >= RANK[required];
}

function toIso(value: unknown): string {
  if (value instanceof Date) return value.toISOString();
  if (typeof value === 'string') {
    const d = new Date(value);
    return Number.isNaN(d.getTime()) ? value : d.toISOString();
  }
  if (value == null) return '';
  return String(value);
}

/** Project a `users` row onto the wire shape — never leaks password_hash. */
export function publicUser(row: {
  id: unknown;
  email: unknown;
  role: unknown;
  scope_mode?: unknown;
  can_exec?: unknown;
  created_at?: unknown;
  last_login_at?: unknown;
}): PublicUser {
  return {
    id: String(row.id),
    email: String(row.email),
    role: (isRole(row.role) ? row.role : 'viewer') as Role,
    scope_mode: row.scope_mode === 'granted' ? 'granted' : 'all',
    can_exec: row.can_exec === true,
    created_at: toIso(row.created_at),
    last_login_at: row.last_login_at == null ? null : toIso(row.last_login_at),
  };
}

// ---------------------------------------------------------------------------
// Error envelope (contract §6)
// ---------------------------------------------------------------------------

export type ErrorCode =
  | 'unauthorized'
  | 'forbidden'
  | 'not_found'
  | 'validation_error'
  | 'conflict'
  | 'docker_error'
  | 'docker_unavailable'
  | 'internal';

export function errorBody(code: string, message: string, details?: unknown): { error: { code: string; message: string; details?: unknown } } {
  return details === undefined ? { error: { code, message } } : { error: { code, message, details } };
}

/** Send the frozen error envelope and return the reply (so hooks can `return sendError(...)`). */
export function sendError(
  reply: FastifyReply,
  status: number,
  code: ErrorCode,
  message: string,
  details?: unknown,
): FastifyReply {
  return reply.code(status).send(errorBody(code, message, details));
}

// ---------------------------------------------------------------------------
// Role enforcement
// ---------------------------------------------------------------------------

/**
 * preHandler factory: populates `request.user` from the session cookie, then
 * requires the caller to hold at least `min` on the role ladder.
 *   401 unauthorized  — no valid session
 *   403 forbidden     — session valid but the role is too low
 */
export function requireRole(min: Role) {
  return async function roleGuard(req: FastifyRequest, reply: FastifyReply): Promise<FastifyReply | void> {
    await authenticate(req);
    if (!req.user) {
      return sendError(reply, 401, 'unauthorized', 'authentication required');
    }
    if (!can(req.user.role, min)) {
      return sendError(reply, 403, 'forbidden', `this action requires the ${min} role`);
    }
  };
}

/** Convenience alias: any authenticated user. */
export function requireAuth() {
  return requireRole('viewer');
}
