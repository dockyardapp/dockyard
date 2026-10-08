// Dockyard — image routes (owner: agent 2). Mounted under /api.
//
//   GET    /images          ImageSummary[]   viewer
//   POST   /images/pull     { ref }          operator  (may take up to ~120s)
//   DELETE /images/:id      ?force=1         admin

import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { listImages, pullImage, removeImage } from '../docker/index.ts';
import { requireRole } from '../auth/rbac.ts';
import { filterVisible } from '../auth/scope.ts';
import { auditFromRequest } from '../auth/audit.ts';

const pullSchema = z.object({ ref: z.string().trim().min(1).max(500) });
const deleteQuery = z.object({ force: z.string().optional() });

function truthy(v: string | undefined): boolean {
  if (!v) return false;
  const s = v.toLowerCase();
  return s === '1' || s === 'true' || s === 'yes' || s === 'on';
}

export default async function imagesRoutes(app: FastifyInstance): Promise<void> {
  // Images carry no labels, so they can only be allocated by id or repo tag.
  // A scoped user with no image grants sees an empty list; deploying still works,
  // because the engine pulls an image on demand rather than requiring a local one.
  app.get('/images', { preHandler: requireRole('viewer') }, async (req, reply) => {
    const images = await listImages();
    return reply
      .code(200)
      .send(filterVisible(req.scope, 'image', images, (i) => ({ id: i.id, repoTags: i.repoTags })));
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
