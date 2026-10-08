// Dockyard — stack lifecycle (owner: agent 4).
//
// A stack is a group of containers created together from one template (or hand-built). The
// linkage between a stack and its containers is ALWAYS the `dockyard.stack` label = the stack
// id, resolved through listContainers({ all: true }) — never by matching container names.

import {
  listContainers,
  getContainer,
  startContainer,
  stopContainer,
  removeContainer,
  removeVolume,
} from './docker/index.ts';
import type { ContainerSummary } from './docker/index.ts';
import { one, many, query } from './db/pool.ts';
import { logger } from './logger.ts';
import { bus } from './events.ts';
import type { TemplateSpec } from './templates/schema.ts';

export type StackStatus = 'running' | 'stopped' | 'partial' | 'error';

export type StackRow = {
  id: string;
  name: string;
  slug: string;
  source: 'template' | 'user';
  template_slug: string | null;
  spec: TemplateSpec | Record<string, unknown>;
  values: Record<string, string>;
  status: StackStatus;
  created_by: string | null;
  created_at: string;
  updated_at: string;
};

export type StackWithContainers = StackRow & { containers: ContainerSummary[] };

/** Lowercase kebab-case slug; always non-empty. */
export function slugify(input: string): string {
  const s = input
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48);
  return s || 'stack';
}

/** Deterministic name for a stack's named volume at a given container path. */
export function volumeName(stackSlug: string, containerPath: string): string {
  const base = containerPath.replace(/\/+$/, '').split('/').pop() || 'data';
  const safe = base.replace(/[^a-zA-Z0-9_.-]/g, '') || 'data';
  return `${stackSlug}-${safe}`.slice(0, 200);
}

/** Unique-ish, docker-valid container name for a stack's container. */
export function containerName(stackSlug: string, stackId: string): string {
  const suffix = stackId.replace(/[^a-z0-9]/gi, '').slice(0, 8);
  return `${stackSlug}-${suffix}`.slice(0, 200);
}

function groupByStack(containers: ContainerSummary[]): Map<string, ContainerSummary[]> {
  const map = new Map<string, ContainerSummary[]>();
  for (const c of containers) {
    if (!c.stackId) continue;
    const list = map.get(c.stackId);
    if (list) list.push(c);
    else map.set(c.stackId, [c]);
  }
  return map;
}

export async function containersForStack(stackId: string): Promise<ContainerSummary[]> {
  const all = await listContainers({ all: true });
  return all.filter((c) => c.stackId === stackId);
}

export async function listStacks(): Promise<StackWithContainers[]> {
  const rows = await many<StackRow>('select * from stacks order by created_at desc');
  const byStack = groupByStack(await listContainers({ all: true }));
  return rows.map((row) => ({ ...row, containers: byStack.get(row.id) ?? [] }));
}

export async function getStack(id: string): Promise<StackWithContainers | null> {
  const row = await one<StackRow>('select * from stacks where id = $1', [id]);
  if (!row) return null;
  return { ...row, containers: await containersForStack(id) };
}

async function setStatus(id: string, status: StackStatus): Promise<StackRow | null> {
  return one<StackRow>(
    'update stacks set status = $2, updated_at = now() where id = $1 returning *',
    [id, status],
  );
}

function emit(action: string, data: unknown): void {
  bus.emit({ type: 'stack', action, data });
}

/**
 * Start every container in the stack that is not already running, then update its status.
 * Throws if the stack does not exist.
 */
export async function startStack(id: string): Promise<StackWithContainers> {
  const stack = await one<StackRow>('select * from stacks where id = $1', [id]);
  if (!stack) throw new StackNotFoundError(id);

  const containers = await containersForStack(id);
  let started = 0;
  let failed = 0;
  for (const c of containers) {
    if (c.state === 'running') continue;
    try {
      await startContainer(c.id);
      started += 1;
      logger.info('stack: started container', { stack: id, container: c.id });
    } catch (err) {
      failed += 1;
      logger.warn('stack: failed to start container', {
        stack: id,
        container: c.id,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  // The container *list* API lags a beat behind a lifecycle change, so the status is derived
  // from the operation outcome here (reconcileStackStatus covers external drift later).
  if (containers.length > 0) {
    await setStatus(id, failed === 0 ? 'running' : started > 0 ? 'partial' : 'error');
  }
  emit('start', { id, started });
  return (await getStack(id)) as StackWithContainers;
}

/** Stop every running container in the stack, then update its status. */
export async function stopStack(id: string): Promise<StackWithContainers> {
  const stack = await one<StackRow>('select * from stacks where id = $1', [id]);
  if (!stack) throw new StackNotFoundError(id);

  const containers = await containersForStack(id);
  let stopped = 0;
  let failed = 0;
  for (const c of containers) {
    if (c.state !== 'running') continue;
    try {
      await stopContainer(c.id);
      stopped += 1;
      logger.info('stack: stopped container', { stack: id, container: c.id });
    } catch (err) {
      failed += 1;
      logger.warn('stack: failed to stop container', {
        stack: id,
        container: c.id,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  if (containers.length > 0) {
    await setStatus(id, failed === 0 ? 'stopped' : stopped > 0 ? 'partial' : 'error');
  }
  emit('stop', { id, stopped });
  return (await getStack(id)) as StackWithContainers;
}

/**
 * Stop and remove every container in the stack (and, when `volumes` is set, its named volumes),
 * then delete the stack row.
 */
export async function removeStack(
  id: string,
  opts: { volumes?: boolean } = {},
): Promise<{ ok: true; removed: string[] }> {
  const stack = await one<StackRow>('select * from stacks where id = $1', [id]);
  if (!stack) throw new StackNotFoundError(id);

  const containers = await containersForStack(id);
  const removed: string[] = [];

  // Collect the named volumes backing the stack's containers BEFORE removing them, so
  // `{ volumes: true }` can delete them too (docker rm -v only drops anonymous volumes).
  // The authoritative source is the stack's own spec + values (we created the volumes with
  // deterministic names); the live mounts are a safety net.
  const volumeNames = new Set<string>();
  if (opts.volumes === true) {
    const spec = stack.spec as { volumes?: Array<{ container: string; named?: boolean }> } | null;
    const values = (stack.values ?? {}) as Record<string, string>;
    for (const v of spec?.volumes ?? []) {
      if (!v || typeof v.container !== 'string' || v.named === false) continue;
      if (values[`volume:${v.container}`]) continue; // bind-mount override, not a named volume
      volumeNames.add(volumeName(stack.slug, v.container));
    }
    for (const c of containers) {
      try {
        const detail = await getContainer(c.id);
        for (const m of detail.mounts) {
          if (m.type !== 'volume' || !m.source) continue;
          // inspect reports a named volume's Source as /var/lib/docker/volumes/<name>/_data
          const match = /\/volumes\/([^/]+)\/_data\/?$/.exec(m.source);
          if (match) volumeNames.add(match[1]);
        }
      } catch {
        /* container already gone */
      }
    }
  }

  for (const c of containers) {
    try {
      if (c.state === 'running') {
        await stopContainer(c.id).catch(() => {
          /* already stopping / gone — remove with force below */
        });
      }
      await removeContainer(c.id, { force: true, volumes: opts.volumes === true });
      removed.push(c.id);
    } catch (err) {
      logger.warn('stack: failed to remove container', {
        stack: id,
        container: c.id,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  if (opts.volumes === true) {
    for (const name of volumeNames) {
      await removeVolume(name, { force: true }).catch((err) => {
        logger.warn('stack: failed to remove volume', {
          stack: id,
          volume: name,
          error: err instanceof Error ? err.message : String(err),
        });
      });
    }
  }

  await query('delete from stacks where id = $1', [id]);
  emit('remove', { id, removed: removed.length, volumes: [...volumeNames] });
  logger.info('stack: removed', {
    stack: id,
    containers: removed.length,
    volumes: opts.volumes === true ? volumeNames.size : 0,
  });
  return { ok: true, removed };
}

/**
 * Recompute stack status from its live containers:
 *   - 'running'  when every container is running
 *   - 'stopped'  when none are running
 *   - 'partial'  when some are running
 *   - 'error'    preserved when the stack is in error and has no containers left at all
 * Returns the stacks whose status actually changed. Pass an id to reconcile a single stack.
 */
export async function reconcileStackStatus(
  stackId?: string,
): Promise<Array<{ id: string; from: StackStatus; to: StackStatus }>> {
  const rows = stackId
    ? await many<StackRow>('select * from stacks where id = $1', [stackId])
    : await many<StackRow>('select * from stacks');
  const byStack = groupByStack(await listContainers({ all: true }));
  const changed: Array<{ id: string; from: StackStatus; to: StackStatus }> = [];

  for (const row of rows) {
    const containers = byStack.get(row.id) ?? [];
    let next: StackStatus;
    if (containers.length === 0) {
      next = row.status === 'error' ? 'error' : 'stopped';
    } else {
      const running = containers.filter((c) => c.state === 'running').length;
      if (running === containers.length) next = 'running';
      else if (running === 0) next = 'stopped';
      else next = 'partial';
    }

    if (next !== row.status) {
      await setStatus(row.id, next);
      changed.push({ id: row.id, from: row.status, to: next });
      emit('status', { id: row.id, status: next, from: row.status });
    }
  }
  return changed;
}

export class StackNotFoundError extends Error {
  code = 'not_found';
  statusCode = 404;

  constructor(id: string) {
    super(`stack not found: ${id}`);
    this.name = 'StackNotFoundError';
  }
}
