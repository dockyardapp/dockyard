// Dockyard — stack routes (owner: agent 4). Mounted under /api.
//
//   GET    /stacks                viewer
//   GET    /stacks/:id            viewer
//   POST   /stacks/:id/:action    start|stop   operator
//   DELETE /stacks/:id ?volumes=1 admin

import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { requireRole, sendError } from '../auth/rbac.ts';
import { canSee, denyScoped, isUnrestricted } from '../auth/scope.ts';
import type { Scope } from '../auth/scope.ts';
import { auditFromRequest } from '../auth/audit.ts';
import {
  listStacks,
  getStack,
  startStack,
  stopStack,
  removeStack,
  StackNotFoundError,
} from '../stacks.ts';
import type { StackWithContainers } from '../stacks.ts';

const STACK_ACTIONS = ['start', 'stop'] as const;

const deleteQuery = z.object({ volumes: z.string().optional() });

function truthy(v: string | undefined): boolean {
  if (!v) return false;
  const s = v.toLowerCase();
  return s === '1' || s === 'true' || s === 'yes' || s === 'on';
}

/**
 * A stack is visible when it is granted directly, or when any of its containers
 * is. The second half is what makes label grants work: a scoped user deploys a
 * template, the container inherits their grant label, and the stack comes along
 * with it.
 */
function canSeeStack(scope: Scope, stack: StackWithContainers): boolean {
  if (isUnrestricted(scope)) return true;
  if (canSee(scope, 'stack', { id: stack.id, name: stack.name, slug: stack.slug })) return true;
  return stack.containers.some((c) =>
    canSee(scope, 'container', { id: c.id, name: c.name, labels: c.labels }),
  );
}

export default async function stacksRoutes(app: FastifyInstance): Promise<void> {
  app.get('/stacks', { preHandler: requireRole('viewer') }, async (req, reply) => {
    const stacks = await listStacks();
    return reply.code(200).send(stacks.filter((s) => canSeeStack(req.scope, s)));
  });

  app.get('/stacks/:id', { preHandler: requireRole('viewer') }, async (req, reply) => {
    const { id } = req.params as { id: string };
    const stack = await getStack(id);
    if (!stack) return sendError(reply, 404, 'not_found', `stack not found: ${id}`);
    if (!canSeeStack(req.scope, stack)) return denyScoped(reply, 'stack', id);
    return reply.code(200).send(stack);
  });

  app.post('/stacks/:id/:action', { preHandler: requireRole('operator') }, async (req, reply) => {
    const { id, action } = req.params as { id: string; action: string };
    if (!(STACK_ACTIONS as readonly string[]).includes(action)) {
      return sendError(reply, 400, 'validation_error', `unsupported action '${action}'`, {
        allowed: STACK_ACTIONS,
      });
    }

    // Check the allocation before touching anything; a stack the caller cannot
    // see must not be startable or stoppable.
    const existing = await getStack(id);
    if (existing && !canSeeStack(req.scope, existing)) return denyScoped(reply, 'stack', id);

    try {
      const stack = action === 'start' ? await startStack(id) : await stopStack(id);
      await auditFromRequest(req, `stack.${action}`, 'stack', id, { name: stack.name });
      return reply.code(200).send(stack);
    } catch (err) {
      if (err instanceof StackNotFoundError) {
        return sendError(reply, 404, 'not_found', err.message);
      }
      throw err;
    }
  });

  app.delete('/stacks/:id', { preHandler: requireRole('admin') }, async (req, reply) => {
    const { id } = req.params as { id: string };
    const { volumes } = deleteQuery.parse(req.query ?? {});
    const withVolumes = truthy(volumes);
    try {
      await removeStack(id, { volumes: withVolumes });
      await auditFromRequest(req, 'stack.remove', 'stack', id, { volumes: withVolumes });
      return reply.code(200).send({ ok: true });
    } catch (err) {
      if (err instanceof StackNotFoundError) {
        return sendError(reply, 404, 'not_found', err.message);
      }
      throw err;
    }
  });
}
