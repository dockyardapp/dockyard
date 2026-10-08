// Dockyard — stack routes (owner: agent 4). Mounted under /api.
//
//   GET    /stacks                viewer
//   GET    /stacks/:id            viewer
//   POST   /stacks/:id/:action    start|stop   operator
//   DELETE /stacks/:id ?volumes=1 admin

import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { requireRole, sendError } from '../auth/rbac.ts';
import { auditFromRequest } from '../auth/audit.ts';
import {
  listStacks,
  getStack,
  startStack,
  stopStack,
  removeStack,
  StackNotFoundError,
} from '../stacks.ts';

const STACK_ACTIONS = ['start', 'stop'] as const;

const deleteQuery = z.object({ volumes: z.string().optional() });

function truthy(v: string | undefined): boolean {
  if (!v) return false;
  const s = v.toLowerCase();
  return s === '1' || s === 'true' || s === 'yes' || s === 'on';
}

export default async function stacksRoutes(app: FastifyInstance): Promise<void> {
  app.get('/stacks', { preHandler: requireRole('viewer') }, async (_req, reply) => {
    return reply.code(200).send(await listStacks());
  });

  app.get('/stacks/:id', { preHandler: requireRole('viewer') }, async (req, reply) => {
    const { id } = req.params as { id: string };
    const stack = await getStack(id);
    if (!stack) return sendError(reply, 404, 'not_found', `stack not found: ${id}`);
    return reply.code(200).send(stack);
  });

  app.post('/stacks/:id/:action', { preHandler: requireRole('operator') }, async (req, reply) => {
    const { id, action } = req.params as { id: string; action: string };
    if (!(STACK_ACTIONS as readonly string[]).includes(action)) {
      return sendError(reply, 400, 'validation_error', `unsupported action '${action}'`, {
        allowed: STACK_ACTIONS,
      });
    }

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
