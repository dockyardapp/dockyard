// Dockyard — tunnel REST routes (owner: agent 3). Contract §6.
//
//   GET    /api/tunnels            viewer
//   POST   /api/tunnels            operator  -> Tunnel 201
//   GET    /api/tunnels/:id        viewer
//   POST   /api/tunnels/:id/:action operator (start|stop) -> Tunnel
//   DELETE /api/tunnels/:id        admin
//
// Errors use the frozen envelope via rbac.sendError.

import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { auditFromRequest } from '../auth/audit.ts';
import { requireRole, sendError } from '../auth/rbac.ts';
import { denyScoped } from '../auth/scope.ts';
import { logger } from '../logger.ts';
import { TunnelError, tunnelManager } from '../tunnels/manager.ts';
import type { CreateTunnelInput } from '../tunnels/manager.ts';
import { canSeeTunnel, filterTunnels } from '../tunnels/visibility.ts';

const createTunnelSchema = z
  .object({
    name: z.string().min(1, 'name is required'),
    mode: z.enum(['quick', 'named', 'localtunnel']),
    target_url: z.string().min(1).optional(),
    container_id: z.string().min(1).optional(),
    port: z.number().int().positive().optional(),
    hostname: z.string().min(1).optional(),
    zone_id: z.string().min(1).optional(),
    auto_start: z.boolean().optional(),
  })
  .refine((v) => !!v.target_url || !!v.container_id, {
    message: 'target_url or container_id is required',
    path: ['target_url'],
  })
  .refine((v) => v.mode !== 'named' || !!v.hostname, {
    message: 'hostname is required for a named tunnel',
    path: ['hostname'],
  });

function fail(reply: Parameters<typeof sendError>[0], err: unknown) {
  if (err instanceof TunnelError) {
    const code = (err.code === 'not_found'
      ? 'not_found'
      : err.code === 'validation_error'
        ? 'validation_error'
        : err.statusCode >= 500
          ? 'internal'
          : err.code) as Parameters<typeof sendError>[2];
    return sendError(reply, err.statusCode, code, err.message);
  }
  if (err instanceof z.ZodError) {
    return sendError(
      reply,
      400,
      'validation_error',
      err.issues.map((i) => i.message).join('; ') || 'invalid request body',
      { issues: err.issues },
    );
  }
  const anyErr = err as { statusCode?: number; code?: string; message?: string };
  if (typeof anyErr?.statusCode === 'number') {
    return sendError(
      reply,
      anyErr.statusCode,
      (anyErr.code as Parameters<typeof sendError>[2]) ?? 'internal',
      anyErr.message ?? 'error',
    );
  }
  logger.error('tunnel route error', {
    error: err instanceof Error ? err.message : String(err),
  });
  return sendError(reply, 500, 'internal', err instanceof Error ? err.message : 'internal error');
}

export default async function tunnelRoutes(app: FastifyInstance): Promise<void> {
  app.get('/api/tunnels', { preHandler: requireRole('viewer') }, async (req, reply) => {
    try {
      return await filterTunnels(req.scope, await tunnelManager.list());
    } catch (err) {
      return fail(reply, err);
    }
  });

  app.post('/api/tunnels', { preHandler: requireRole('operator') }, async (req, reply) => {
    try {
      const parsed = createTunnelSchema.parse(req.body ?? {});
      const input: CreateTunnelInput = parsed;
      const tunnel = await tunnelManager.create(input);
      await auditFromRequest(req, 'tunnel.create', 'tunnel', tunnel.id, {
        name: tunnel.name,
        mode: tunnel.mode,
        target_url: tunnel.target_url,
      });
      return reply.code(201).send(tunnel);
    } catch (err) {
      return fail(reply, err);
    }
  });

  app.get('/api/tunnels/:id', { preHandler: requireRole('viewer') }, async (req, reply) => {
    try {
      const { id } = req.params as { id: string };
      const tunnel = await tunnelManager.get(id);
      if (!tunnel) return sendError(reply, 404, 'not_found', `tunnel '${id}' was not found`);
      if (!(await canSeeTunnel(req.scope, tunnel))) return denyScoped(reply, 'tunnel', id);
      return tunnel;
    } catch (err) {
      return fail(reply, err);
    }
  });

  app.post('/api/tunnels/:id/:action', { preHandler: requireRole('operator') }, async (req, reply) => {
    try {
      const { id, action } = req.params as { id: string; action: string };
      if (action !== 'start' && action !== 'stop') {
        return sendError(reply, 400, 'validation_error', `unknown tunnel action '${action}'`);
      }
      const before = await tunnelManager.get(id);
      if (before && !(await canSeeTunnel(req.scope, before))) return denyScoped(reply, 'tunnel', id);
      const tunnel =
        action === 'start' ? await tunnelManager.start(id) : await tunnelManager.stop(id);
      await auditFromRequest(req, `tunnel.${action}`, 'tunnel', id, { name: tunnel.name });
      return tunnel;
    } catch (err) {
      return fail(reply, err);
    }
  });

  app.delete('/api/tunnels/:id', { preHandler: requireRole('admin') }, async (req, reply) => {
    try {
      const { id } = req.params as { id: string };
      const existing = await tunnelManager.get(id);
      await tunnelManager.remove(id);
      await auditFromRequest(req, 'tunnel.delete', 'tunnel', id, {
        name: existing?.name ?? null,
        mode: existing?.mode ?? null,
      });
      return { ok: true };
    } catch (err) {
      return fail(reply, err);
    }
  });
}
