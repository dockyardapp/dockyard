// Dockyard — authentication routes (owner: agent 2). Mounted under /api.
//
//   POST /auth/bootstrap   public, only while the users table is empty -> { user }
//   POST /auth/login       public, rate limited                        -> { user }
//   POST /auth/logout      any                                         -> { ok: true }
//   GET  /auth/me          public                                      -> { user: PublicUser | null }

import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { one, query } from '../db/pool.ts';
import { config } from '../config.ts';
import { logger } from '../logger.ts';
import { dummyVerify, hashPassword, MIN_PASSWORD_LENGTH, verifyPassword } from '../auth/password.ts';
import { publicUser, sendError } from '../auth/rbac.ts';
import {
  SESSION_COOKIE,
  authenticate,
  clearSessionCookie,
  createSession,
  destroySession,
  setSessionCookie,
} from '../auth/sessions.ts';
import { audit, clientIp } from '../auth/audit.ts';

const credentials = z.object({
  email: z.string().trim().email().max(320),
  password: z.string().min(1).max(1000),
});

/**
 * Setting a password, as opposed to presenting one.
 *
 * Login keeps the permissive rule above on purpose: an account whose password
 * predates the minimum must still be able to sign in. Creating or changing a
 * password enforces the length the UI advertises.
 */
const newCredentials = z.object({
  email: z.string().trim().email().max(320),
  password: z.string().min(MIN_PASSWORD_LENGTH).max(1000),
});

const USER_COLUMNS = 'id, email, role, scope_mode, can_exec, created_at, last_login_at';

export default async function authRoutes(app: FastifyInstance): Promise<void> {
  // First-run admin creation. 409 as soon as any user exists.
  app.post('/auth/bootstrap', async (req, reply) => {
    const { email, password } = newCredentials.parse(req.body ?? {});
    const count = await one<{ n: number }>('select count(*)::int as n from users');
    if ((count?.n ?? 0) > 0) {
      return sendError(reply, 409, 'conflict', 'bootstrap is only available while no users exist');
    }

    const passwordHash = await hashPassword(password);
    const row = await one(
      `insert into users (email, password_hash, role) values ($1, $2, 'admin') returning ${USER_COLUMNS}`,
      [email.toLowerCase(), passwordHash],
    );
    if (!row) return sendError(reply, 500, 'internal', 'could not create the bootstrap user');
    const user = publicUser(row);

    const { token } = await createSession(user.id, req);
    setSessionCookie(reply, token);
    await query('update users set last_login_at = now() where id = $1', [user.id]);
    await audit({
      userId: user.id,
      action: 'auth.bootstrap',
      targetType: 'user',
      targetId: user.id,
      detail: { email: user.email, role: 'admin' },
      ip: clientIp(req),
    });
    logger.info('bootstrap admin created', { userId: user.id });
    return reply.code(200).send({ user });
  });

  // Login — always runs a verify (real or dummy) so timing does not leak account existence.
  app.post(
    '/auth/login',
    { config: { rateLimit: { max: config.loginRateMax, timeWindow: '1 minute' } } },
    async (req, reply) => {
      const { email, password } = credentials.parse(req.body ?? {});
      const row = await one<{
        id: string;
        email: string;
        role: string;
        scope_mode: string;
        can_exec: boolean;
        password_hash: string;
        created_at: unknown;
        last_login_at: unknown;
      }>(
        // scope_mode and can_exec belong here: the sign-in response seeds the
        // client's idea of the session, and without them a scoped user sees an
        // unscoped panel until the next /auth/me refresh.
        `select id, email, role, scope_mode, can_exec, password_hash, created_at, last_login_at
           from users where lower(email) = lower($1)`,
        [email],
      );

      const ok = row ? await verifyPassword(password, row.password_hash) : false;
      if (!row) await dummyVerify(password);

      if (!row || !ok) {
        await audit({
          userId: row?.id ?? null,
          action: 'auth.login_failed',
          targetType: 'user',
          targetId: row?.id ?? null,
          detail: { email: email.toLowerCase() },
          ip: clientIp(req),
        });
        return sendError(reply, 401, 'unauthorized', 'invalid email or password');
      }

      const { token } = await createSession(row.id, req);
      setSessionCookie(reply, token);
      await query('update users set last_login_at = now() where id = $1', [row.id]);
      const user = publicUser({ ...row, last_login_at: new Date() });
      await audit({
        userId: row.id,
        action: 'auth.login',
        targetType: 'user',
        targetId: row.id,
        detail: { email: row.email },
        ip: clientIp(req),
      });
      return reply.code(200).send({ user });
    },
  );

  app.post('/auth/logout', { preHandler: authenticate }, async (req, reply) => {
    const token = req.cookies?.[SESSION_COOKIE];
    if (token) {
      await destroySession(token);
      await audit({
        userId: req.user?.id ?? null,
        action: 'auth.logout',
        targetType: 'session',
        targetId: null,
        ip: clientIp(req),
      });
    }
    clearSessionCookie(reply);
    return reply.code(200).send({ ok: true });
  });

  app.get('/auth/me', { preHandler: authenticate }, async (req, reply) => {
    return reply.code(200).send({ user: req.user ?? null });
  });
}
