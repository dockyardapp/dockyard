// Dockyard — audit log read API (owner: agent 2). Admin only. Mounted under /api.
//
//   GET /audit?limit=100&offset=0&action=  -> AuditEntry[]

import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { listAudit } from '../auth/audit.ts';
import { requireRole } from '../auth/rbac.ts';

const querySchema = z.object({
  limit: z.coerce.number().int().min(1).max(500).optional(),
  offset: z.coerce.number().int().min(0).optional(),
  action: z.string().trim().min(1).max(200).optional(),
});

export default async function auditRoutes(app: FastifyInstance): Promise<void> {
  app.get('/audit', { preHandler: requireRole('admin') }, async (req, reply) => {
    const { limit, offset, action } = querySchema.parse(req.query ?? {});
    const entries = await listAudit({ limit: limit ?? 100, offset: offset ?? 0, action });
    return reply.code(200).send(entries);
  });
}
