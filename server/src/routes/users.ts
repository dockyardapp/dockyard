// Dockyard — user management and resource allocation. Admin only. Mounted under /api.
//
//   GET    /users                       -> PublicUser[]
//   POST   /users                       -> PublicUser
//   PATCH  /users/:id                   -> PublicUser
//   DELETE /users/:id                   -> { ok: true }
//   GET    /users/:id/grants            -> Grant[]
//   POST   /users/:id/grants            -> Grant      (allocates one resource)
//   DELETE /users/:id/grants            -> { ok: true }  (clears the allocation)
//   DELETE /users/:id/grants/:grantId   -> { ok: true }
//
// Two invariants keep the panel from locking itself out:
//   * the last admin can never be demoted or deleted
//   * an admin can never be scoped, so there is always one account that sees everything
//
// Adding the first grant to a user flips them to `scope_mode = 'granted'`
// automatically. A grant on an unscoped user would otherwise have no effect at
// all, which reads as the allocation having silently failed.

import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { many, one, query } from '../db/pool.ts';
import { hashPassword, MIN_PASSWORD_LENGTH } from '../auth/password.ts';
import { publicUser, requireRole, sendError } from '../auth/rbac.ts';
import { RESOURCE_KINDS } from '../auth/scope.ts';
import type { Grant } from '../auth/scope.ts';
import { auditFromRequest } from '../auth/audit.ts';

const USER_COLUMNS = 'id, email, role, scope_mode, can_exec, created_at, last_login_at';
const GRANT_COLUMNS = 'id, resource_kind, resource_id, label_key, label_value';
const roles = z.enum(['admin', 'operator', 'viewer']);
const scopeModes = z.enum(['all', 'granted']);

const createUserSchema = z.object({
  email: z.string().trim().email().max(320),
  password: z.string().min(MIN_PASSWORD_LENGTH).max(1000),
  role: roles,
  scope_mode: scopeModes.optional(),
  can_exec: z.boolean().optional(),
});

const patchUserSchema = z
  .object({
    role: roles.optional(),
    password: z.string().min(MIN_PASSWORD_LENGTH).max(1000).optional(),
    scope_mode: scopeModes.optional(),
    can_exec: z.boolean().optional(),
  })
  .refine(
    (v) =>
      v.role !== undefined ||
      v.password !== undefined ||
      v.scope_mode !== undefined ||
      v.can_exec !== undefined,
    { message: 'provide at least one of role, password, scope_mode or can_exec' },
  );

const grantSchema = z
  .object({
    resource_kind: z.enum(RESOURCE_KINDS as unknown as [string, ...string[]]),
    resource_id: z.string().trim().min(1).max(500).optional(),
    label_key: z.string().trim().min(1).max(200).optional(),
    label_value: z.string().max(500).optional(),
  })
  .refine((v) => Boolean(v.resource_id) !== Boolean(v.label_key), {
    message: 'provide either resource_id or label_key, not both',
  });

async function adminCount(): Promise<number> {
  const row = await one<{ n: number }>("select count(*)::int as n from users where role = 'admin'");
  return row?.n ?? 0;
}

type TargetRow = { id: string; email: string; role: string; scope_mode: string };

async function loadTarget(id: string): Promise<TargetRow | null> {
  return one<TargetRow>('select id, email, role, scope_mode from users where id = $1', [id]);
}

export default async function usersRoutes(app: FastifyInstance): Promise<void> {
  app.get('/users', { preHandler: requireRole('admin') }, async (_req, reply) => {
    // The allocation size belongs on the list: an admin scanning the table should
    // see who is scoped without opening each user.
    const rows = await many<{
      id: unknown;
      email: unknown;
      role: unknown;
      scope_mode?: unknown;
      can_exec?: unknown;
      created_at?: unknown;
      last_login_at?: unknown;
      grant_count?: unknown;
    }>(
      `select u.id, u.email, u.role, u.scope_mode, u.can_exec, u.created_at, u.last_login_at,
              (select count(*)::int from user_grants g where g.user_id = u.id) as grant_count
         from users u
        order by u.created_at asc, u.email asc`,
    );
    return reply
      .code(200)
      .send(rows.map((r) => ({ ...publicUser(r), grant_count: Number(r.grant_count ?? 0) })));
  });

  app.post('/users', { preHandler: requireRole('admin') }, async (req, reply) => {
    const { email, password, role, scope_mode, can_exec } = createUserSchema.parse(req.body ?? {});
    if (role === 'admin' && scope_mode === 'granted') {
      return sendError(reply, 409, 'conflict', 'an admin always sees every resource and cannot be scoped');
    }

    const existing = await one('select id from users where lower(email) = lower($1)', [email]);
    if (existing) return sendError(reply, 409, 'conflict', 'a user with that email already exists');

    const passwordHash = await hashPassword(password);
    const row = await one(
      `insert into users (email, password_hash, role, scope_mode, can_exec)
       values ($1, $2, $3, $4, $5)
       returning ${USER_COLUMNS}`,
      [email.toLowerCase(), passwordHash, role, scope_mode ?? 'all', can_exec ?? false],
    );
    if (!row) return sendError(reply, 500, 'internal', 'could not create the user');
    await auditFromRequest(req, 'user.create', 'user', String(row.id), {
      email: row.email,
      role,
      scope_mode: scope_mode ?? 'all',
      can_exec: can_exec ?? false,
    });
    return reply.code(200).send(publicUser(row));
  });

  app.patch('/users/:id', { preHandler: requireRole('admin') }, async (req, reply) => {
    const { id } = req.params as { id: string };
    const body = patchUserSchema.parse(req.body ?? {});

    const target = await loadTarget(id);
    if (!target) return sendError(reply, 404, 'not_found', 'user not found');

    if (body.role !== undefined && body.role !== 'admin' && target.role === 'admin') {
      if ((await adminCount()) <= 1) return sendError(reply, 409, 'conflict', 'cannot demote the last admin');
    }

    // An admin who is demoted keeps their scope setting, so re-check that the
    // combination is still coherent.
    const nextRole = body.role ?? target.role;
    const nextScope = body.scope_mode ?? target.scope_mode;
    if (nextRole === 'admin' && nextScope === 'granted') {
      return sendError(reply, 409, 'conflict', 'an admin always sees every resource and cannot be scoped');
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
    if (body.scope_mode !== undefined) {
      params.push(body.scope_mode);
      sets.push(`scope_mode = $${params.length}`);
    }
    if (body.can_exec !== undefined) {
      params.push(body.can_exec);
      sets.push(`can_exec = $${params.length}`);
    }
    params.push(id);
    const row = await one(
      `update users set ${sets.join(', ')} where id = $${params.length} returning ${USER_COLUMNS}`,
      params,
    );

    // Changing a password invalidates that user's existing sessions. So does
    // changing what they may see: the scope is resolved per request, but a
    // demotion or re-scoping should not leave a stale session in a browser.
    if (body.password !== undefined || body.scope_mode !== undefined) {
      await query('delete from sessions where user_id = $1', [id]);
    }

    await auditFromRequest(req, 'user.update', 'user', id, {
      role: body.role,
      passwordChanged: body.password !== undefined,
      scope_mode: body.scope_mode,
      can_exec: body.can_exec,
    });
    return reply.code(200).send(publicUser(row));
  });

  app.delete('/users/:id', { preHandler: requireRole('admin') }, async (req, reply) => {
    const { id } = req.params as { id: string };
    const target = await loadTarget(id);
    if (!target) return sendError(reply, 404, 'not_found', 'user not found');

    if (target.role === 'admin' && (await adminCount()) <= 1) {
      return sendError(reply, 409, 'conflict', 'cannot delete the last admin');
    }

    // user_grants cascades on delete.
    await query('delete from users where id = $1', [id]);
    await auditFromRequest(req, 'user.delete', 'user', id, { email: target.email, role: target.role });
    return reply.code(200).send({ ok: true });
  });

  // -------------------------------------------------------------------------
  // Allocation
  // -------------------------------------------------------------------------

  app.get('/users/:id/grants', { preHandler: requireRole('admin') }, async (req, reply) => {
    const { id } = req.params as { id: string };
    const target = await loadTarget(id);
    if (!target) return sendError(reply, 404, 'not_found', 'user not found');

    const rows = await many<Grant>(
      `select ${GRANT_COLUMNS} from user_grants
        where user_id = $1
        order by resource_kind asc, created_at asc`,
      [id],
    );
    return reply.code(200).send(rows);
  });

  app.post('/users/:id/grants', { preHandler: requireRole('admin') }, async (req, reply) => {
    const { id } = req.params as { id: string };
    const body = grantSchema.parse(req.body ?? {});

    const target = await loadTarget(id);
    if (!target) return sendError(reply, 404, 'not_found', 'user not found');
    if (target.role === 'admin') {
      return sendError(reply, 409, 'conflict', 'an admin always sees every resource; grants would have no effect');
    }

    const resourceId = body.resource_id ?? null;
    const labelKey = body.label_key ?? null;
    const labelValue = body.label_key ? (body.label_value ?? '') : null;

    const inserted = await one<Grant>(
      `insert into user_grants (user_id, resource_kind, resource_id, label_key, label_value, created_by)
       values ($1, $2, $3, $4, $5, $6)
       on conflict do nothing
       returning ${GRANT_COLUMNS}`,
      [id, body.resource_kind, resourceId, labelKey, labelValue, req.user?.id ?? null],
    );

    // A grant on an unscoped user would do nothing, which reads as a bug. Adding
    // the first one turns scoping on.
    if (target.scope_mode !== 'granted') {
      await query("update users set scope_mode = 'granted' where id = $1", [id]);
      await query('delete from sessions where user_id = $1', [id]);
    }

    if (!inserted) {
      // The unique index swallowed it: the same allocation already exists.
      const existing = await one<Grant>(
        `select ${GRANT_COLUMNS} from user_grants
          where user_id = $1 and resource_kind = $2
            and coalesce(resource_id, '') = coalesce($3, '')
            and coalesce(label_key, '') = coalesce($4, '')
            and coalesce(label_value, '') = coalesce($5, '')`,
        [id, body.resource_kind, resourceId, labelKey, labelValue],
      );
      return reply.code(200).send(existing);
    }

    await auditFromRequest(req, 'grant.create', 'user', id, {
      email: target.email,
      resource_kind: body.resource_kind,
      resource_id: resourceId,
      label_key: labelKey,
      label_value: labelValue,
    });
    return reply.code(201).send(inserted);
  });

  app.delete('/users/:id/grants', { preHandler: requireRole('admin') }, async (req, reply) => {
    const { id } = req.params as { id: string };
    const target = await loadTarget(id);
    if (!target) return sendError(reply, 404, 'not_found', 'user not found');

    const result = await query('delete from user_grants where user_id = $1', [id]);
    const removed = result.rowCount ?? 0;
    // Clearing every grant leaves nothing to see, which is the honest outcome;
    // flipping back to 'all' is a separate, explicit decision.
    await auditFromRequest(req, 'grant.clear', 'user', id, {
      email: target.email,
      removed,
    });
    return reply.code(200).send({ ok: true, removed });
  });

  app.delete('/users/:id/grants/:grantId', { preHandler: requireRole('admin') }, async (req, reply) => {
    const { id, grantId } = req.params as { id: string; grantId: string };
    const target = await loadTarget(id);
    if (!target) return sendError(reply, 404, 'not_found', 'user not found');

    const result = await query('delete from user_grants where id = $1 and user_id = $2', [grantId, id]);
    if ((result.rowCount ?? 0) === 0) return sendError(reply, 404, 'not_found', 'grant not found');

    await auditFromRequest(req, 'grant.delete', 'user', id, {
      email: target.email,
      grant_id: grantId,
    });
    return reply.code(200).send({ ok: true });
  });
}
