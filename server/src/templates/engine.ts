// Dockyard — template deploy engine (owner: agent 4).
//
// deployTemplate() turns a template + user values into a running container:
//   resolve spec -> render + validate -> insert stacks row ('running') -> create container ->
//   start container -> update stack.
// On a Docker failure the DockerError propagates (so the route picks the right HTTP status) and
// the stack row is either rolled back (create failed, no container exists) or marked 'error'.
// A failed *start* never leaves an orphan container behind: the container created is removed
// before the error is rethrown.

import {
  createContainer,
  startContainer,
  removeContainer,
  normalizeDockerError,
} from '../docker/index.ts';
import type { CreateContainerInput } from '../docker/index.ts';
import { one, query } from '../db/pool.ts';
import { logger } from '../logger.ts';
import { bus } from '../events.ts';
import {
  renderTemplate,
  persistableValues,
  validateSpec,
  TemplateValidationError,
} from './schema.ts';
import type { TemplateSpec, TemplateHealthcheck } from './schema.ts';
import { builtinSpecBySlug } from './catalog.ts';
import { slugify, containerName, volumeName } from '../stacks.ts';
import type { StackRow } from '../stacks.ts';

export class TemplateNotFoundError extends Error {
  code = 'not_found';
  statusCode = 404;

  constructor(slug: string) {
    super(`template not found: ${slug}`);
    this.name = 'TemplateNotFoundError';
  }
}

export type DeployInput = {
  slug: string;
  name: string;
  values: Record<string, string>;
  userId: string | null;
  /**
   * Labels merged onto the created container on top of the template's own.
   * Used to keep a scoped user's deployments inside their allocation, so the
   * container they just created does not vanish from their view.
   */
  extraLabels?: Record<string, string>;
};

export type DeployResult = {
  stack: StackRow;
  container: { id: string; name: string };
};

/** The stored spec wins (user edits / user templates); fall back to the built-in catalog. */
async function resolveSpec(slug: string): Promise<TemplateSpec | null> {
  const row = await one<{ spec: unknown }>('select spec from templates where slug = $1', [slug]);
  if (row) {
    const parsed = validateSpec(row.spec);
    if (parsed.ok) return parsed.spec;
    logger.warn('deploy: stored template spec invalid, falling back to builtin', {
      slug,
      errors: parsed.errors,
    });
  }
  return builtinSpecBySlug(slug);
}

function dockerHealthcheck(hc: TemplateHealthcheck): {
  Test: string[];
  Interval: number;
  Timeout: number;
  Retries: number;
} {
  return {
    Test: hc.test,
    Interval: hc.intervalSec * 1_000_000_000,
    Timeout: hc.timeoutSec * 1_000_000_000,
    Retries: hc.retries,
  };
}

function emitError(stackId: string, message: string): void {
  bus.emit({ type: 'stack', action: 'error', data: { id: stackId, error: message } });
}

export async function deployTemplate(input: DeployInput): Promise<DeployResult> {
  const spec = await resolveSpec(input.slug);
  if (!spec) throw new TemplateNotFoundError(input.slug);

  const rendered = renderTemplate(spec, input.values);
  if (rendered.missing.length > 0) {
    // Reject BEFORE touching Docker.
    throw new TemplateValidationError(
      `missing required value(s): ${rendered.missing.join(', ')}`,
      { missing: rendered.missing },
    );
  }

  const name = (input.name ?? '').trim() || spec.name;
  const slug = slugify(name);
  const persisted = persistableValues(spec, input.values);

  // 1. insert the stack row first, status 'running' (reconciled once the container is up)
  const stack = await one<StackRow>(
    `insert into stacks (name, slug, source, template_slug, spec, values, status, created_by)
     values ($1, $2, 'template', $3, $4::jsonb, $5::jsonb, 'running', $6)
     returning *`,
    [name, slug, spec.slug, JSON.stringify(spec), JSON.stringify(persisted), input.userId],
  );
  if (!stack) throw new Error('failed to insert stack row');

  // 2. volumes: honour an explicit host override, otherwise use a stack-scoped named volume
  const volumes = rendered.volumes.map((v) => {
    if (v.host) return { host: v.host, container: v.container, mode: 'rw' };
    const specVol = spec.volumes.find((s) => s.container === v.container);
    if (specVol && specVol.named !== false) {
      return { host: volumeName(stack.slug, v.container), container: v.container, mode: 'rw' };
    }
    return { container: v.container, mode: 'rw' };
  });

  const labels: Record<string, string> = {
    ...rendered.labels,
    // Allocation labels sit above the template's own, but below the dockyard
    // bookkeeping ones, which the stack join depends on.
    ...(input.extraLabels ?? {}),
    'dockyard.stack': stack.id,
    'dockyard.name': stack.name,
  };

  const cname = containerName(stack.slug, stack.id);

  // 3. create the container (pulling the image if missing)
  let created: { id: string; name: string } | null = null;
  try {
    const base: CreateContainerInput & { healthcheck?: unknown } = {
      name: cname,
      image: rendered.image,
      cmd: rendered.command,
      entrypoint: rendered.entrypoint,
      env: rendered.env,
      ports: rendered.ports.map((p) => ({ host: p.host, container: p.container })),
      volumes,
      restartPolicy: rendered.restartPolicy,
      labels,
      pull: true,
    };
    if (spec.healthcheck) base.healthcheck = dockerHealthcheck(spec.healthcheck);

    const res = await createContainer(base);
    created = { id: res.id, name: res.name };
  } catch (err) {
    const de = normalizeDockerError(err);
    // create failed -> no container exists; roll the stack row back
    await query('delete from stacks where id = $1', [stack.id]).catch(() => {});
    emitError(stack.id, de.message);
    logger.error('deploy: container create failed', {
      stack: stack.id,
      slug: spec.slug,
      error: de.message,
    });
    throw de;
  }

  // 4. start the container
  try {
    await startContainer(created.id);
  } catch (err) {
    const de = normalizeDockerError(err);
    // never leave an orphan: remove the container we just created, keep the row as 'error'
    await removeContainer(created.id, { force: true }).catch(() => {});
    await query("update stacks set status = 'error', updated_at = now() where id = $1", [
      stack.id,
    ]).catch(() => {});
    emitError(stack.id, de.message);
    logger.error('deploy: container start failed; removed orphan container', {
      stack: stack.id,
      container: created.id,
      error: de.message,
    });
    throw de;
  }

  // 5. mark the stack running
  const updated = await one<StackRow>(
    "update stacks set status = 'running', updated_at = now() where id = $1 returning *",
    [stack.id],
  );
  const finalStack = updated ?? stack;

  bus.emit({
    type: 'stack',
    action: 'deploy',
    data: { id: finalStack.id, status: finalStack.status, container: created },
  });
  logger.info('deploy: stack running', {
    stack: finalStack.id,
    slug: spec.slug,
    container: created.id,
    image: rendered.image,
  });

  return { stack: finalStack, container: created };
}
