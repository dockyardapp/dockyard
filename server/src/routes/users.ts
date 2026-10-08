// Dockyard — user management (owner: agent 2). Admin only. Mounted under /api.
//
//   GET    /users       -> PublicUser[]
//   POST   /users       -> PublicUser
//   PATCH  /users/:id   -> PublicUser
//   DELETE /users/:id   -> { ok: true }
//
// The last admin can never be demoted or deleted, so the panel cannot lock itself out.

import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { many, one, query } from '../db/pool.ts';
import { hashPassword } from '../auth/password.ts';
import { publicUser, requireRole, sendError } from '../auth/rbac.ts';
import { auditFromRequest } from '../auth/audit.ts';

const USER_COLUMNS = 'id, email, role, created_at, last_login_at';
const roles = z.enum(['admin', 'operator', 'viewer']);

const createUserSchema = z.object({
  email: z.string().trim().email().max(320),
  password: z.string().min(1).max(1000),
  role: roles,
});

const patchUserSchema = z
  .object({
    role: roles.optional(),
    password: z.string().min(1).max(1000).optional(),
  })
  .refine((v) => v.role !== undefined || v.password !== undefined, {
    message: 'provide at least one of role or password',
  });

async function adminCount(): Promise<number> {
  const row = await one<{ n: number }>("select count(*)::int as n from users where role = 'admin'");
  return row?.n ?? 0;
}

export default async function usersRoutes(app: FastifyInstance): Promise<void> {
  app.get('/users', { preHandler: requireRole('admin') }, async (_req, reply) => {
    const rows = await many(`select ${USER_COLUMNS} from users order by created_at asc, email asc`);
    return reply.code(200).send(rows.map(publicUser));
  });

  app.post('/users', { preHandler: requireRole('admin') }, async (req, reply) => {
    const { email, password, role } = createUserSchema.parse(req.body ?? {});
    const existing = await one('select id from users where lower(email) = lower($1)', [email]);
    if (existing) return sendError(reply, 409, 'conflict', 'a user with that email already exists');

    const passwordHash = await hashPassword(password);
    const row = await one(
      `insert into users (email, password_hash, role) values ($1, $2, $3) returning ${USER_COLUMNS}`,
      [email.toLowerCase(), passwordHash, role],
    );
    if (!row) return sendError(reply, 500, 'internal', 'could not create the user');
    await auditFromRequest(req, 'user.create', 'user', String(row.id), { email: row.email, role });
    return reply.code(200).send(publicUser(row));
  });

  app.patch('/users/:id', { preHandler: requireRole('admin') }, async (req, reply) => {
    const { id } = req.params as { id: string };
    const body = patchUserSchema.parse(req.body ?? {});

    const target = await one<{ id: string; email: string; role: string }>(
      'select id, email, role from users where id = $1',
      [id],
    );
    if (!target) return sendError(reply, 404, 'not_found', 'user not found');

    if (body.role !== undefined && body.role !== 'admin' && target.role === 'admin') {
      if ((await adminCount()) <= 1) return sendError(reply, 409, 'conflict', 'cannot demote the last admin');
    }

    const sets: string[] = [];
    const params: unknown[] = [];
    if (body.role !== undefined) {
      params.push(body.role);
      sets.push(`role = $${params.length}`);
    }
    if (body.password !== undefined) {
      params.push(await hashPassword(body.password));
      sets.push(`password_hash = $${params.length}`);
    }
    params.push(id);
    const row = await one(
      `update users set ${sets.join(', ')} where id = $${params.length} returning ${USER_COLUMNS}`,
      params,
    );

    // Changing a password invalidates that user's existing sessions.
    if (body.password !== undefined) await query('delete from sessions where user_id = $1', [id]);

    await auditFromRequest(req, 'user.update', 'user', id, {
      role: body.role,
      passwordChanged: body.password !== undefined,
    });
    return reply.code(200).send(publicUser(row));
  });

  app.delete('/users/:id', { preHandler: requireRole('admin') }, async (req, reply) => {
    const { id } = req.params as { id: string };
    const target = await one<{ id: string; email: string; role: string }>(
      'select id, email, role from users where id = $1',
      [id],
    );
    if (!target) return sendError(reply, 404, 'not_found', 'user not found');

    if (target.role === 'admin' && (await adminCount()) <= 1) {
      return sendError(reply, 409, 'conflict', 'cannot delete the last admin');
    }

    await query('delete from users where id = $1', [id]);
    await auditFromRequest(req, 'user.delete', 'user', id, { email: target.email, role: target.role });
    return reply.code(200).send({ ok: true });
  });
}
