// Dockyard — network routes (owner: agent 2). Mounted under /api.
//
//   GET    /networks       NetworkSummary[]  viewer
//   POST   /networks       { name, driver? } operator
//   DELETE /networks/:id                     admin

import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { createNetwork, listNetworks, removeNetwork } from '../docker/index.ts';
import { requireRole } from '../auth/rbac.ts';
import { filterVisible, grantLabel } from '../auth/scope.ts';
import { auditFromRequest } from '../auth/audit.ts';

const createSchema = z.object({
  name: z.string().trim().min(1).max(255),
  driver: z.string().trim().min(1).max(64).optional(),
  labels: z.record(z.string()).optional(),
});

export default async function networksRoutes(app: FastifyInstance): Promise<void> {
  app.get('/networks', { preHandler: requireRole('viewer') }, async (req, reply) => {
    const networks = await listNetworks();
    return reply
      .code(200)
      .send(filterVisible(req.scope, 'network', networks, (n) => ({ name: n.name, labels: n.labels })));
  });

  app.post('/networks', { preHandler: requireRole('operator') }, async (req, reply) => {
    const { name, driver, labels } = createSchema.parse(req.body ?? {});
    const inherited = grantLabel(req.scope, 'network');
    const network = await createNetwork(name, {
      driver,
      labels: inherited ? { ...labels, ...inherited } : labels,
    });
    await auditFromRequest(req, 'network.create', 'network', name, { name, driver });
    return reply.code(200).send(network);
  });

  app.delete('/networks/:id', { preHandler: requireRole('admin') }, async (req, reply) => {
    const { id } = req.params as { id: string };
    await removeNetwork(id);
    await auditFromRequest(req, 'network.remove', 'network', id, null);
    return reply.code(200).send({ ok: true });
  });
}
