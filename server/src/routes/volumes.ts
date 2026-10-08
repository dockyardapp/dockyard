// Dockyard — volume routes (owner: agent 2). Mounted under /api.
//
//   GET    /volumes          VolumeSummary[]   viewer
//   POST   /volumes          { name }          operator
//   DELETE /volumes/:name    ?force=1          admin

import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { createVolume, listVolumes, removeVolume } from '../docker/index.ts';
import { requireRole } from '../auth/rbac.ts';
import { filterVisible, grantLabel } from '../auth/scope.ts';
import { auditFromRequest } from '../auth/audit.ts';

const createSchema = z.object({
  name: z.string().trim().min(1).max(255),
  labels: z.record(z.string()).optional(),
});
const deleteQuery = z.object({ force: z.string().optional() });

function truthy(v: string | undefined): boolean {
  if (!v) return false;
  const s = v.toLowerCase();
  return s === '1' || s === 'true' || s === 'yes' || s === 'on';
}

export default async function volumesRoutes(app: FastifyInstance): Promise<void> {
  app.get('/volumes', { preHandler: requireRole('viewer') }, async (req, reply) => {
    const volumes = await listVolumes();
    return reply
      .code(200)
      .send(filterVisible(req.scope, 'volume', volumes, (v) => ({ name: v.name, labels: v.labels })));
  });

  app.post('/volumes', { preHandler: requireRole('operator') }, async (req, reply) => {
    const { name, labels } = createSchema.parse(req.body ?? {});
    const inherited = grantLabel(req.scope, 'volume');
    const volume = await createVolume(name, inherited ? { ...labels, ...inherited } : labels);
    await auditFromRequest(req, 'volume.create', 'volume', name, { name });
    return reply.code(200).send(volume);
  });

  app.delete('/volumes/:name', { preHandler: requireRole('admin') }, async (req, reply) => {
    const { name } = req.params as { name: string };
    const { force } = deleteQuery.parse(req.query ?? {});
    await removeVolume(name, { force: truthy(force) });
    await auditFromRequest(req, 'volume.remove', 'volume', name, { force: truthy(force) });
    return reply.code(200).send({ ok: true });
  });
}
