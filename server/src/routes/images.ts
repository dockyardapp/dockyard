// Dockyard — image routes (owner: agent 2). Mounted under /api.
//
//   GET    /images          ImageSummary[]   viewer
//   POST   /images/pull     { ref }          operator  (may take up to ~120s)
//   DELETE /images/:id      ?force=1         admin

import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { listImages, pullImage, removeImage } from '../docker/index.ts';
import { requireRole } from '../auth/rbac.ts';
import { auditFromRequest } from '../auth/audit.ts';

const pullSchema = z.object({ ref: z.string().trim().min(1).max(500) });
const deleteQuery = z.object({ force: z.string().optional() });

function truthy(v: string | undefined): boolean {
  if (!v) return false;
  const s = v.toLowerCase();
  return s === '1' || s === 'true' || s === 'yes' || s === 'on';
}

export default async function imagesRoutes(app: FastifyInstance): Promise<void> {
  app.get('/images', { preHandler: requireRole('viewer') }, async (_req, reply) => {
    return reply.code(200).send(await listImages());
  });

  // Pulling a large image can take a while; the client is expected to allow ~120s.
  app.post('/images/pull', { preHandler: requireRole('operator') }, async (req, reply) => {
    const { ref } = pullSchema.parse(req.body ?? {});
    await pullImage(ref);
    await auditFromRequest(req, 'image.pull', 'image', ref, { ref });
    return reply.code(200).send({ ok: true, ref });
  });

  app.delete('/images/:id', { preHandler: requireRole('admin') }, async (req, reply) => {
    const { id } = req.params as { id: string };
    const { force } = deleteQuery.parse(req.query ?? {});
    await removeImage(id, { force: truthy(force) });
    await auditFromRequest(req, 'image.remove', 'image', id, { force: truthy(force) });
    return reply.code(200).send({ ok: true });
  });
}
