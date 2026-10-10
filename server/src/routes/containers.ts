// Dockyard — container routes (owner: agent 2). Mounted under /api.
//
//   GET    /containers                    ?all=1&q=            viewer
//   POST   /containers                    CreateContainerInput  operator
//   GET    /containers/:id                ContainerDetail       viewer
//   GET    /containers/:id/inspect        raw inspect           viewer
//   POST   /containers/:id/:action        start|stop|…          operator
//   DELETE /containers/:id                ?force=1&volumes=1    admin
//   GET    /containers/:id/logs           ?tail&since           viewer  (text/plain)
//   GET    /containers/:id/stats          ContainerStats        viewer
//   POST   /containers/:id/exec           { cmd: string[] }     operator
//
// `:id` accepts a full id, an id prefix or a container name (via resolveContainer).

import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import {
  containerLogs,
  containerStats,
  createContainer,
  execInContainer,
  getContainer,
  inspectContainer,
  killContainer,
  listContainers,
  pauseContainer,
  removeContainer,
  resolveContainer,
  restartContainer,
  startContainer,
  stopContainer,
  unpauseContainer,
} from '../docker/index.ts';
import type { ContainerSummary } from '../docker/index.ts';
import { requireRole, sendError } from '../auth/rbac.ts';
import { canExec, canSee, denyScoped, filterVisible, grantLabel } from '../auth/scope.ts';
import { auditFromRequest } from '../auth/audit.ts';
import { bus } from '../events.ts';

const CONTAINER_ACTIONS = ['start', 'stop', 'restart', 'kill', 'pause', 'unpause'] as const;

const listQuery = z.object({
  all: z.string().optional(),
  q: z.string().optional(),
});

const portSchema = z.object({
  host: z.number().int().min(1).max(65535).optional(),
  container: z.number().int().min(1).max(65535),
  proto: z.enum(['tcp', 'udp']).optional(),
});

const volumeSchema = z.object({
  host: z.string().min(1).optional(),
  container: z.string().min(1),
  mode: z.string().min(1).max(64).optional(),
});

const createSchema = z.object({
  name: z.string().trim().min(1).max(255),
  image: z.string().trim().min(1).max(500),
  cmd: z.array(z.string()).optional(),
  entrypoint: z.array(z.string()).optional(),
  env: z.record(z.string()).optional(),
  ports: z.array(portSchema).optional(),
  volumes: z.array(volumeSchema).optional(),
  restartPolicy: z.enum(['no', 'always', 'unless-stopped', 'on-failure']).optional(),
  labels: z.record(z.string()).optional(),
  network: z.string().min(1).optional(),
  pull: z.boolean().optional(),
});

const logsQuery = z.object({
  tail: z.coerce.number().int().min(0).max(100000).optional(),
  since: z.coerce.number().int().min(0).optional(),
  timestamps: z.string().optional(),
});

const deleteQuery = z.object({
  force: z.string().optional(),
  volumes: z.string().optional(),
});

const execSchema = z.object({
  cmd: z.array(z.string().min(1)).min(1),
});

function truthy(v: string | undefined): boolean {
  if (!v) return false;
  const s = v.toLowerCase();
  return s === '1' || s === 'true' || s === 'yes' || s === 'on';
}

/** Scope target for a container summary. */
function asTarget(c: ContainerSummary) {
  return { id: c.id, name: c.name, labels: c.labels };
}

/**
 * Resolve `:id` (id, id prefix or name) to a summary, or send a clean 404.
 *
 * A container outside the caller's allocation also 404s, worded identically to a
 * genuine miss, so a scoped user cannot enumerate the host by probing ids.
 */
async function resolveOr404(
  id: string,
  req: FastifyRequest,
  reply: FastifyReply,
): Promise<ContainerSummary | null> {
  const summary = await resolveContainer(id);
  if (!summary) {
    sendError(reply, 404, 'not_found', `no container matches '${id}'`);
    return null;
  }
  if (!canSee(req.scope, 'container', asTarget(summary))) {
    denyScoped(reply, 'container', id);
    return null;
  }
  return summary;
}

export default async function containersRoutes(app: FastifyInstance): Promise<void> {
  app.get('/containers', { preHandler: requireRole('viewer') }, async (req, reply) => {
    const { all, q } = listQuery.parse(req.query ?? {});
    const containers = await listContainers({ all: truthy(all), q });
    return reply.code(200).send(filterVisible(req.scope, 'container', containers, asTarget));
  });

  app.post('/containers', { preHandler: requireRole('operator') }, async (req, reply) => {
    const parsed = createSchema.parse(req.body ?? {});
    // A scoped user's new container inherits their grant label, so it stays
    // visible to them. Without this they would create one and lose sight of it.
    const inherited = grantLabel(req.scope, 'container');
    const input = inherited ? { ...parsed, labels: { ...parsed.labels, ...inherited } } : parsed;
    const created = await createContainer(input);
    await auditFromRequest(req, 'container.create', 'container', created.id, {
      name: created.name,
      image: input.image,
      ...(inherited ? { allocatedBy: inherited } : {}),
    });
    // `labels` is here for the event stream's scope filter: a container grant may
    // name a label rather than an id, and without them a label-scoped subscriber
    // could not be told which events are theirs. It is the same field the
    // container routes already hand to `canSee`. `createContainer` returns only
    // the id and name, so this is the set the container was created with.
    bus.emit({
      type: 'container',
      action: 'create',
      data: { id: created.id, name: created.name, image: input.image, labels: input.labels },
    });
    return reply.code(201).send({ id: created.id, name: created.name });
  });

  app.get('/containers/:id', { preHandler: requireRole('viewer') }, async (req, reply) => {
    const { id } = req.params as { id: string };
    const summary = await resolveOr404(id, req, reply);
    if (!summary) return;
    return reply.code(200).send(await getContainer(summary.id));
  });

  app.get('/containers/:id/inspect', { preHandler: requireRole('viewer') }, async (req, reply) => {
    const { id } = req.params as { id: string };
    const summary = await resolveOr404(id, req, reply);
    if (!summary) return;
    return reply.code(200).send(await inspectContainer(summary.id));
  });

  app.post('/containers/:id/:action', { preHandler: requireRole('operator') }, async (req, reply) => {
    const { id, action } = req.params as { id: string; action: string };
    if (!(CONTAINER_ACTIONS as readonly string[]).includes(action)) {
      return sendError(reply, 400, 'validation_error', `unsupported action '${action}'`, {
        allowed: CONTAINER_ACTIONS,
      });
    }

    const summary = await resolveOr404(id, req, reply);
    if (!summary) return;

    switch (action as (typeof CONTAINER_ACTIONS)[number]) {
      case 'start':
        await startContainer(summary.id);
        break;
      case 'stop':
        await stopContainer(summary.id);
        break;
      case 'restart':
        await restartContainer(summary.id);
        break;
      case 'kill':
        await killContainer(summary.id);
        break;
      case 'pause':
        await pauseContainer(summary.id);
        break;
      case 'unpause':
        await unpauseContainer(summary.id);
        break;
    }

    await auditFromRequest(req, `container.${action}`, 'container', summary.id, { name: summary.name });
    bus.emit({
      type: 'container',
      action,
      data: { id: summary.id, name: summary.name, labels: summary.labels },
    });
    return reply.code(200).send(await getContainer(summary.id));
  });

  app.delete('/containers/:id', { preHandler: requireRole('admin') }, async (req, reply) => {
    const { id } = req.params as { id: string };
    const { force, volumes } = deleteQuery.parse(req.query ?? {});
    const summary = await resolveOr404(id, req, reply);
    if (!summary) return;

    const opts = { force: truthy(force), volumes: truthy(volumes) };
    await removeContainer(summary.id, opts);
    await auditFromRequest(req, 'container.remove', 'container', summary.id, {
      name: summary.name,
      force: opts.force,
      volumes: opts.volumes,
    });
    bus.emit({
      type: 'container',
      action: 'remove',
      data: { id: summary.id, name: summary.name, labels: summary.labels },
    });
    return reply.code(200).send({ ok: true });
  });

  app.get('/containers/:id/logs', { preHandler: requireRole('viewer') }, async (req, reply) => {
    const { id } = req.params as { id: string };
    const { tail, since, timestamps } = logsQuery.parse(req.query ?? {});
    const summary = await resolveOr404(id, req, reply);
    if (!summary) return;
    const text = await containerLogs(summary.id, {
      tail: tail ?? 200,
      since,
      timestamps: truthy(timestamps),
    });
    return reply.type('text/plain; charset=utf-8').code(200).send(text);
  });

  app.get('/containers/:id/stats', { preHandler: requireRole('viewer') }, async (req, reply) => {
    const { id } = req.params as { id: string };
    const summary = await resolveOr404(id, req, reply);
    if (!summary) return;
    return reply.code(200).send(await containerStats(summary.id));
  });

  // Exec is gated on `can_exec`, not on the operator role. The panel mounts the
  // Docker socket, so a shell in any container is root on the host; that should
  // be an explicit grant rather than a side effect of being able to restart
  // things. Admins always may.
  app.post('/containers/:id/exec', { preHandler: requireRole('operator') }, async (req, reply) => {
    const { id } = req.params as { id: string };
    if (!canExec(req.user)) {
      return sendError(reply, 403, 'forbidden', 'exec is not enabled for this account');
    }
    const { cmd } = execSchema.parse(req.body ?? {});
    const summary = await resolveOr404(id, req, reply);
    if (!summary) return;
    const result = await execInContainer(summary.id, cmd);
    await auditFromRequest(req, 'container.exec', 'container', summary.id, { name: summary.name, cmd });
    return reply.code(200).send(result);
  });
}
