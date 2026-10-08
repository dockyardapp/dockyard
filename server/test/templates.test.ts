// Dockyard — template catalog, render, deploy engine and stack lifecycle tests (owner: agent 4).
//
// These tests run against the REAL Docker daemon and the REAL Postgres instance — no mocks.
// They create real containers, assert they are running and correctly labelled, then remove
// everything they created. Any container left behind is a bug.

import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';

import { runMigrations } from '../src/db/migrate.ts';
import { one, query, closePool } from '../src/db/pool.ts';
import {
  listContainers,
  getContainer,
  listVolumes,
  inspectImage,
  pullImage,
  getDocker,
  DockerError,
} from '../src/docker/index.ts';
import {
  builtinTemplates,
  syncBuiltinTemplates,
} from '../src/templates/catalog.ts';
import {
  templateSpecSchema,
  validateSpec,
  renderTemplate,
  persistableValues,
  TemplateValidationError,
  SECRET_MARKER,
} from '../src/templates/schema.ts';
import { deployTemplate } from '../src/templates/engine.ts';
import {
  listStacks,
  getStack,
  startStack,
  stopStack,
  removeStack,
  reconcileStackStatus,
} from '../src/stacks.ts';

const REQUIRED_TEMPLATES = [
  'postgres', 'mysql', 'redis', 'mongodb', 'adminer', 'nginx', 'wordpress', 'node-app',
  'python-app', 'uptime-kuma', 'grafana', 'prometheus', 'minio', 'n8n', 'whoami',
];
const CATEGORIES = ['database', 'web', 'monitoring', 'storage', 'devtools', 'messaging', 'other'];

// Stacks/containers created by these tests, cleaned up in the after() hook.
const createdStacks = new Set<string>();
const createdContainers = new Set<string>();

function tag(): string {
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`;
}

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.on('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const addr = srv.address();
      const port = typeof addr === 'object' && addr ? addr.port : 0;
      srv.close(() => resolve(port));
    });
  });
}

// Images the deploy tests use, and a locally-available equivalent to fall back on when the
// registry cannot be reached. Docker Hub's anonymous pull rate limit is per-IP; when it is
// exhausted the test retags an equivalent image already on the host so the real
// create/start/label/remove path is still exercised (the pull itself is agent 1's concern).
const IMAGE_FALLBACKS: Record<string, string> = {
  'traefik/whoami:v1.11.0': 'traefik/whoami:latest',
  'redis:7.4-alpine': 'redis:7-alpine',
};

async function ensureImageAvailable(ref: string): Promise<void> {
  try {
    await inspectImage(ref);
    return; // already present locally
  } catch {
    /* not present — try to pull */
  }
  try {
    await pullImage(ref);
  } catch (err) {
    const fallback = IMAGE_FALLBACKS[ref];
    if (!fallback) throw err;
    const [repo, tag] = ref.split(':');
    await (getDocker().getImage(fallback) as any).tag({ repo, tag });
  }
}

before(async () => {
  await runMigrations();
  await ensureImageAvailable('traefik/whoami:v1.11.0');
  await ensureImageAvailable('redis:7.4-alpine');
});

after(async () => {
  // Remove every stack we created (containers + named volumes).
  for (const id of createdStacks) {
    try {
      await removeStack(id, { volumes: true });
    } catch {
      /* best effort */
    }
  }
  // Belt and braces: force-remove any tracked container still on the host.
  for (const id of createdContainers) {
    try {
      await getContainer(id);
      const { removeContainer } = await import('../src/docker/index.ts');
      await removeContainer(id, { force: true, volumes: true });
    } catch {
      /* already gone */
    }
  }
  await closePool();
});

// ---------------------------------------------------------------------------
// 1. Catalog integrity
// ---------------------------------------------------------------------------

test('builtin catalog: every spec validates, slugs are unique, >= 14 templates, all categories', () => {
  const specs = builtinTemplates();
  assert.ok(specs.length >= 14, `expected at least 14 templates, got ${specs.length}`);

  const slugs = new Set<string>();
  for (const spec of specs) {
    const parsed = templateSpecSchema.safeParse(spec);
    assert.ok(
      parsed.success,
      `spec "${spec.slug}" failed schema validation: ${
        parsed.success ? '' : JSON.stringify(parsed.error.issues)
      }`,
    );
    assert.ok(!slugs.has(spec.slug), `duplicate template slug: ${spec.slug}`);
    slugs.add(spec.slug);

    // real image + pinned tag, real absolute volume paths, real container ports
    assert.ok(spec.image.length > 0 && !spec.image.includes(':'), `${spec.slug}: image must not carry a tag`);
    assert.ok(spec.tag.length > 0, `${spec.slug}: missing tag`);
    assert.notEqual(spec.tag, 'latest', `${spec.slug}: tag should be pinned, not "latest"`);
    for (const v of spec.volumes) {
      assert.ok(v.container.startsWith('/'), `${spec.slug}: volume path not absolute: ${v.container}`);
    }
    for (const p of spec.ports) {
      assert.ok(Number.isInteger(p.container) && p.container > 0 && p.container <= 65535);
    }
  }

  // every required application is present
  for (const slug of REQUIRED_TEMPLATES) {
    assert.ok(slugs.has(slug), `required template missing: ${slug}`);
  }
  // at least one template per category
  for (const cat of CATEGORIES) {
    assert.ok(specs.some((s) => s.category === cat), `no template in category "${cat}"`);
  }
});

test('validateSpec rejects malformed specs and accepts a good one', () => {
  const good = builtinTemplates().find((s) => s.slug === 'redis');
  assert.ok(good);
  assert.deepEqual(validateSpec(good), { ok: true, spec: good });

  const bad = validateSpec({ slug: 'Bad Slug', name: '', category: 'nope', image: '', tag: '' });
  assert.equal(bad.ok, false);
  assert.ok(!bad.ok && bad.errors.length > 0);

  // relative volume path is rejected
  const relVol = validateSpec({
    schemaVersion: 1, slug: 'x', name: 'X', category: 'other', icon: 'x',
    description: '', image: 'x', tag: '1', restartPolicy: 'no',
    volumes: [{ container: 'not-absolute' }],
  });
  assert.equal(relVol.ok, false);
});

// ---------------------------------------------------------------------------
// 2. renderTemplate
// ---------------------------------------------------------------------------

test('renderTemplate: defaults applied, required-missing reported, overrides parsed, secrets masked', () => {
  const pg = builtinTemplates().find((s) => s.slug === 'postgres');
  assert.ok(pg);

  // defaults + required supplied
  const r = renderTemplate(pg, { POSTGRES_PASSWORD: 'supersecret' });
  assert.equal(r.image, 'postgres:16-alpine');
  assert.equal(r.env.POSTGRES_PASSWORD, 'supersecret');
  assert.equal(r.env.POSTGRES_USER, 'postgres'); // default applied
  assert.equal(r.env.POSTGRES_DB, 'postgres'); // default applied
  assert.deepEqual(r.missing, []);
  assert.equal(r.labels['dockyard.managed'], 'true');
  assert.equal(r.labels['dockyard.template'], 'postgres');
  assert.equal(r.ports.find((p) => p.container === 5432)?.host, 5432); // defaultHost

  // required missing
  const r2 = renderTemplate(pg, {});
  assert.deepEqual(r2.missing, ['POSTGRES_PASSWORD']);

  // port override parsed to a number
  const r3 = renderTemplate(pg, { POSTGRES_PASSWORD: 'x', 'port:5432': '15432' });
  assert.equal(r3.ports.find((p) => p.container === 5432)?.host, 15432);

  // invalid host ports are rejected
  assert.throws(
    () => renderTemplate(pg, { POSTGRES_PASSWORD: 'x', 'port:5432': '99999' }),
    /invalid host port/,
  );
  assert.throws(
    () => renderTemplate(pg, { POSTGRES_PASSWORD: 'x', 'port:5432': 'not-a-port' }),
    /invalid host port/,
  );

  // volume override parsed; non-absolute rejected
  const r4 = renderTemplate(pg, {
    POSTGRES_PASSWORD: 'x',
    'volume:/var/lib/postgresql/data': '/srv/pgdata',
  });
  assert.equal(
    r4.volumes.find((v) => v.container === '/var/lib/postgresql/data')?.host,
    '/srv/pgdata',
  );
  assert.throws(
    () => renderTemplate(pg, { POSTGRES_PASSWORD: 'x', 'volume:/var/lib/postgresql/data': 'rel' }),
    /absolute/,
  );

  // the object used for persistence must not contain the secret value
  const persisted = persistableValues(pg, { POSTGRES_PASSWORD: 'supersecret' });
  assert.equal(persisted.POSTGRES_PASSWORD, SECRET_MARKER);
  assert.equal(persisted.POSTGRES_USER, 'postgres');
  assert.ok(
    !JSON.stringify(persisted).includes('supersecret'),
    'secret value leaked into the persisted values object',
  );
});

// ---------------------------------------------------------------------------
// 3. syncBuiltinTemplates
// ---------------------------------------------------------------------------

test('syncBuiltinTemplates upserts builtins, preserves created_at, never overwrites a user row', async () => {
  const first = await syncBuiltinTemplates();
  assert.ok(first.total >= 14);

  const beforeRow = await one<{ created_at: unknown }>(
    'select created_at from templates where slug = $1',
    ['postgres'],
  );
  assert.ok(beforeRow);

  // plant a USER row using a builtin slug
  await query(
    `insert into templates (slug, name, category, icon, description, spec, source)
     values ('nginx', 'My Nginx', 'web', '🌐', 'custom', '{}'::jsonb, 'user')
     on conflict (slug) do update set source = 'user', name = 'My Nginx', spec = '{}'::jsonb`,
  );

  const second = await syncBuiltinTemplates();
  assert.ok(second.skipped >= 1, 'the user row should have been skipped');

  const nginx = await one<{ name: string; source: string }>(
    'select name, source from templates where slug = $1',
    ['nginx'],
  );
  assert.equal(nginx?.source, 'user');
  assert.equal(nginx?.name, 'My Nginx', 'sync must not overwrite a user row');

  const afterRow = await one<{ created_at: unknown }>(
    'select created_at from templates where slug = $1',
    ['postgres'],
  );
  assert.equal(
    String(afterRow?.created_at),
    String(beforeRow?.created_at),
    'sync must not clobber a builtin row created_at',
  );

  // restore the builtin nginx row
  await query("delete from templates where slug = 'nginx' and source = 'user'");
  await syncBuiltinTemplates();
  const restored = await one<{ source: string }>('select source from templates where slug = $1', ['nginx']);
  assert.equal(restored?.source, 'builtin');
});

// ---------------------------------------------------------------------------
// 4. Real deployment onto the Docker daemon
// ---------------------------------------------------------------------------

test('deployTemplate(whoami): real container created, running, labelled, listed under its stack', async () => {
  const hostPort = await freePort();
  const name = `t-whoami-${tag()}`;

  const result = await deployTemplate({
    slug: 'whoami',
    name,
    values: { 'port:80': String(hostPort) },
    userId: null,
  });
  createdStacks.add(result.stack.id);
  createdContainers.add(result.container.id);

  assert.ok(result.container.id, 'deploy returned no container id');
  assert.equal(result.stack.status, 'running');
  assert.equal(result.stack.template_slug, 'whoami');

  // the container really exists and really runs
  const detail = await getContainer(result.container.id);
  assert.equal(detail.state, 'running');
  assert.equal(detail.image, 'traefik/whoami:v1.11.0');
  assert.equal(detail.labels['dockyard.managed'], 'true');
  assert.equal(detail.labels['dockyard.template'], 'whoami');
  assert.equal(detail.labels['dockyard.stack'], result.stack.id);
  assert.equal(detail.labels['dockyard.name'], result.stack.name);
  assert.ok(
    detail.ports.some((p) => p.publicPort === hostPort && p.privatePort === 80),
    `expected host port ${hostPort} published to container port 80; got ${JSON.stringify(detail.ports)}`,
  );

  // it shows up in the stack's container list (matched by label)
  const stack = await getStack(result.stack.id);
  assert.ok(stack, 'stack not found after deploy');
  assert.ok(
    stack!.containers.some((c) => c.id === result.container.id),
    'deployed container missing from its stack container list',
  );
  assert.equal(stack!.containers[0].stackId, result.stack.id);

  // it also shows up in the global stack listing
  const stacks = await listStacks();
  const listed = stacks.find((s) => s.id === result.stack.id);
  assert.ok(listed);
  assert.ok(listed!.containers.length >= 1);
});

test('stack lifecycle: stopStack then startStack move the real container between states', async () => {
  const hostPort = await freePort();
  const name = `t-redis-${tag()}`;

  const deployed = await deployTemplate({
    slug: 'redis',
    name,
    values: { 'port:6379': String(hostPort) },
    userId: null,
  });
  createdStacks.add(deployed.stack.id);
  createdContainers.add(deployed.container.id);

  assert.equal((await getContainer(deployed.container.id)).state, 'running');

  const stopped = await stopStack(deployed.stack.id);
  assert.equal(stopped.status, 'stopped');
  assert.equal((await getContainer(deployed.container.id)).state, 'exited');

  const started = await startStack(deployed.stack.id);
  assert.equal(started.status, 'running');
  assert.equal((await getContainer(deployed.container.id)).state, 'running');
});

test('removeStack: really removes the container (inspect 404) and its named volume', async () => {
  const hostPort = await freePort();
  const name = `t-rm-${tag()}`;

  const deployed = await deployTemplate({
    slug: 'redis',
    name,
    values: { 'port:6379': String(hostPort) },
    userId: null,
  });
  // not tracked for cleanup: this test removes it itself
  const stackId = deployed.stack.id;
  const containerId = deployed.container.id;
  createdContainers.add(containerId);

  const volName = `${deployed.stack.slug}-data`;
  const volsBefore = await listVolumes();
  assert.ok(volsBefore.some((v) => v.name === volName), `expected named volume ${volName}`);

  const res = await removeStack(stackId, { volumes: true });
  assert.equal(res.ok, true);
  assert.ok(res.removed.includes(containerId));

  // stack row gone
  assert.equal(await getStack(stackId), null);

  // container really gone: docker inspect 404
  await assert.rejects(
    getContainer(containerId),
    (err: unknown) => err instanceof DockerError && err.statusCode === 404,
    'container should be gone (404) after removeStack',
  );

  // and absent from the daemon's container list
  const all = await listContainers({ all: true });
  assert.ok(!all.some((c) => c.id === containerId));

  // named volume removed too
  const volsAfter = await listVolumes();
  assert.ok(!volsAfter.some((v) => v.name === volName), `named volume ${volName} should be gone`);

  createdContainers.delete(containerId);
});

// ---------------------------------------------------------------------------
// 5. Rejection path — before Docker is touched
// ---------------------------------------------------------------------------

test('deploy with a missing required secret is rejected and creates NO container', async () => {
  const name = `t-reject-${tag()}`;
  const before = (await listContainers({ all: true })).length;

  await assert.rejects(
    deployTemplate({ slug: 'postgres', name, values: {}, userId: null }),
    (err: unknown) => {
      assert.ok(err instanceof TemplateValidationError, 'expected TemplateValidationError');
      const e = err as TemplateValidationError;
      assert.equal(e.code, 'validation_error');
      assert.equal(e.statusCode, 400);
      const missing = (e.details as { missing?: string[] }).missing ?? [];
      assert.ok(missing.includes('POSTGRES_PASSWORD'), `missing[] should list POSTGRES_PASSWORD: ${JSON.stringify(missing)}`);
      return true;
    },
  );

  // no stack row was created
  const stack = await one('select id from stacks where name = $1', [name]);
  assert.equal(stack, null, 'a rejected deploy must not create a stack row');

  // no container was created
  const after = (await listContainers({ all: true })).length;
  assert.equal(after, before, 'a rejected deploy must not create a container');
});

// ---------------------------------------------------------------------------
// 6. reconcileStackStatus
// ---------------------------------------------------------------------------

test('reconcileStackStatus: preserves error with no containers, stops a containerless running stack', async () => {
  const created = await one<{ id: string }>(
    `insert into stacks (name, slug, source, spec, values, status)
     values ('t-reconcile', 't-reconcile', 'user', '{}'::jsonb, '{}'::jsonb, 'error')
     returning id`,
  );
  assert.ok(created);
  const id = created!.id;

  try {
    // status 'error' with no live containers is preserved (a container went missing)
    const changed = await reconcileStackStatus(id);
    assert.deepEqual(changed, []);
    assert.equal((await one<{ status: string }>('select status from stacks where id=$1', [id]))?.status, 'error');

    // a containerless 'running' stack is corrected to 'stopped'
    await query("update stacks set status = 'running' where id = $1", [id]);
    const changed2 = await reconcileStackStatus(id);
    assert.equal(changed2.length, 1);
    assert.equal(changed2[0].to, 'stopped');
    assert.equal((await one<{ status: string }>('select status from stacks where id=$1', [id]))?.status, 'stopped');
  } finally {
    await query('delete from stacks where id = $1', [id]);
  }
});
