// Dockyard — sessions and the session cookie (owner: agent 2).
//
// A session token is 32 random bytes, base64url. Only sha256(token) is stored
// (sessions.token_hash) so a database leak cannot be replayed. The cookie is
// `dockyard_session`, httpOnly, sameSite=lax, path=/ — see contract §6.

import crypto from 'node:crypto';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { config } from '../config.ts';
import { one, query } from '../db/pool.ts';
import { publicUser } from './rbac.ts';
import type { PublicUser } from './rbac.ts';
import { loadScope, ALL_SCOPE } from './scope.ts';
import type { Scope } from './scope.ts';

export const SESSION_COOKIE = 'dockyard_session';

declare module 'fastify' {
  interface FastifyRequest {
    /** Populated by `authenticate` / `requireRole`; null for anonymous callers. */
    user: PublicUser | null;
    /** The raw session token from the cookie, if any. */
    sessionToken: string | null;
    /**
     * What this user may see. `{mode:'all'}` for admins and unscoped users, so
     * a route can call `filterVisible(req.scope, …)` unconditionally.
     */
    scope: Scope;
  }
}

export function hashToken(token: string): string {
  return crypto.createHash('sha256').update(token).digest('hex');
}

export function newSessionToken(): string {
  return crypto.randomBytes(32).toString('base64url');
}

function ttlSeconds(): number {
  return Math.max(1, Math.floor(config.sessionTtlHours * 3600));
}

/** Insert a fresh session row for `userId`; returns the raw token (never stored). */
export async function createSession(
  userId: string,
  req: FastifyRequest,
): Promise<{ token: string; expiresAt: Date }> {
  const token = newSessionToken();
  const expiresAt = new Date(Date.now() + ttlSeconds() * 1000);
  const userAgent = req.headers['user-agent'] ? String(req.headers['user-agent']).slice(0, 500) : null;
  const ip = req.ip ?? null;
  await query(
    `insert into sessions (user_id, token_hash, user_agent, ip, expires_at)
     values ($1, $2, $3, $4, $5)`,
    [userId, hashToken(token), userAgent, ip, expiresAt],
  );
  return { token, expiresAt };
}

export function setSessionCookie(reply: FastifyReply, token: string): void {
  reply.setCookie(SESSION_COOKIE, token, {
    httpOnly: true,
    sameSite: 'lax',
    path: '/',
    secure: config.cookieSecure,
    maxAge: ttlSeconds(),
  });
}

export function clearSessionCookie(reply: FastifyReply): void {
  reply.clearCookie(SESSION_COOKIE, { path: '/' });
}

/** Resolve a raw token to its user, or null when missing/expired/unknown. */
export async function readSession(token: string | undefined | null): Promise<PublicUser | null> {
  if (!token) return null;
  const row = await one(
    `select u.id, u.email, u.role, u.scope_mode, u.can_exec, u.created_at, u.last_login_at
       from sessions s
       join users u on u.id = s.user_id
      where s.token_hash = $1 and s.expires_at > now()`,
    [hashToken(token)],
  );
  return row ? publicUser(row) : null;
}

export function sessionTokenFromRequest(req: FastifyRequest): string | null {
  const cookies = (req as unknown as { cookies?: Record<string, string | undefined> }).cookies;
  const token = cookies?.[SESSION_COOKIE];
  return typeof token === 'string' && token.length > 0 ? token : null;
}

/**
 * preHandler / helper: populate `request.user`, `request.sessionToken` and
 * `request.scope` from the cookie. Never sends a response — routes decide what
 * an anonymous caller may see.
 */
export async function authenticate(req: FastifyRequest): Promise<void> {
  // requireRole calls this, and so do several routes directly; load once.
  if (req.scope) return;
  const token = sessionTokenFromRequest(req);
  req.sessionToken = token;
  req.user = token ? await readSession(token) : null;
  req.scope = req.user ? await loadScope(req.user) : ALL_SCOPE;
}

export async function destroySession(token: string): Promise<void> {
  await query('delete from sessions where token_hash = $1', [hashToken(token)]);
}

export async function destroyUserSessions(userId: string): Promise<void> {
  await query('delete from sessions where user_id = $1', [userId]);
}

/** Housekeeping: drop rows that are already past their expiry. */
export async function pruneExpiredSessions(): Promise<number> {
  const res = await query('delete from sessions where expires_at <= now()');
  return res.rowCount ?? 0;
}
