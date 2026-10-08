// Dockyard — HTTP API + auth integration test (owner: agent 2).
//
// Boots the REAL Fastify app with app.inject() against the REAL Postgres, exercising
// bootstrap/login/logout/me, the role ladder, the error envelope, the anonymous
// /api/system/info redaction, and — when the Docker daemon is reachable — a real container
// round-trip through the routes. Everything it creates is removed at the end.
//
//   export PATH=/root/.hermes/node/bin:$PATH
//   DOCKYARD_LOGIN_RATE_MAX=1000 node --test server/test/api.test.ts
//
// The rate limit is raised because this suite signs in a dozen times from one
// address in a couple of seconds, which is exactly what the production limit of
// ten per minute is meant to stop. `npm test` sets it too.

import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../src/app.ts';
import { runMigrations } from '../src/db/migrate.ts';
import { closePool, one, query } from '../src/db/pool.ts';
import { hashPassword } from '../src/auth/password.ts';
import { dockerPing } from '../src/docker/index.ts';

const RUN = randomBytes(4).toString('hex');
const PASSWORD = 'test-password-123';

const createdUserIds: string[] = [];
let app: FastifyInstance;
let dockerOk = false;

function emailFor(role: string): string {
  return `api-test-${role}-${RUN}@dockyard.test`;
}

function cookieHeader(cookieValue: string): Record<string, string> {
  return { cookie: `dockyard_session=${cookieValue}` };
}

async function createUser(role: 'admin' | 'operator' | 'viewer'): Promise<string> {
  const email = emailFor(role);
  const hash = await hashPassword(PASSWORD);
  const row = await one<{ id: string }>(
    `insert into users (email, password_hash, role) values ($1, $2, $3) returning id`,
    [email, hash, role],
  );
  assert.ok(row?.id, `failed to create ${role} test user`);
  createdUserIds.push(row.id);
  return row.id;
}

async function loginAs(role: 'admin' | 'operator' | 'viewer'): Promise<string> {
  const res = await app.inject({
    method: 'POST',
    url: '/api/auth/login',
    payload: { email: emailFor(role), password: PASSWORD },
  });
  assert.equal(res.statusCode, 200, `login as ${role} failed: ${res.body}`);
  const cookie = res.cookies.find((c) => c.name === 'dockyard_session');
  assert.ok(cookie, `no dockyard_session cookie for ${role}`);
  return cookie.value;
}

before(async () => {
  await runMigrations();
  app = await buildApp();
  await app.ready();

  await createUser('admin');
  await createUser('operator');
  await createUser('viewer');

  dockerOk = (await dockerPing()).ok;
});

after(async () => {
  try {
    if (createdUserIds.length > 0) {
      await query('delete from audit_log where user_id = any($1::uuid[])', [createdUserIds]);
      await query('delete from sessions where user_id = any($1::uuid[])', [createdUserIds]);
      await query('delete from users where id = any($1::uuid[])', [createdUserIds]);
    }
  } finally {
    await app?.close();
    await closePool();
  }
});

describe('auth: bootstrap / login / logout / me', () => {
  it('bootstrap is rejected once users exist', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/auth/bootstrap',
      payload: { email: 'whoever@dockyard.test', password: 'irrelevant-123' },
    });
    assert.equal(res.statusCode, 409);
    assert.equal(res.json().error.code, 'conflict');
  });

  it('bootstrap refuses a password shorter than the advertised minimum', async () => {
    // The sign-in form says "at least 8 characters", so the API has to be the one
    // that enforces it: it is reachable directly, and this endpoint creates an
    // administrator. Validation runs before the "users already exist" check, so
    // the length rule is what answers here.
    const res = await app.inject({
      method: 'POST',
      url: '/api/auth/bootstrap',
      payload: { email: 'whoever@dockyard.test', password: 'short' },
    });
    assert.equal(res.statusCode, 400);
    assert.equal(res.json().error.code, 'validation_error');
  });

  it('creating a user refuses a short password, but login still accepts one', async () => {
    const adminCookie = await loginAs('admin');

    const created = await app.inject({
      method: 'POST',
      url: '/api/users',
      headers: cookieHeader(adminCookie),
      payload: { email: 'shorty@dockyard.test', password: 'tiny', role: 'viewer' },
    });
    assert.equal(created.statusCode, 400);
    assert.equal(created.json().error.code, 'validation_error');

    // Login must not apply the same rule, or an account whose password predates
    // the minimum could never sign in to change it.
    const login = await app.inject({
      method: 'POST',
      url: '/api/auth/login',
      payload: { email: emailFor('admin'), password: 'x' },
    });
    assert.equal(login.statusCode, 401, 'a short wrong password is a 401, not a 400');
  });

  it('login sets a session cookie and /me returns the user', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/auth/login',
      payload: { email: emailFor('admin'), password: PASSWORD },
    });
    assert.equal(res.statusCode, 200);
    const cookie = res.cookies.find((c) => c.name === 'dockyard_session');
    assert.ok(cookie, 'expected a dockyard_session cookie');
    assert.equal(cookie.httpOnly, true);
    assert.equal(cookie.sameSite?.toLowerCase(), 'lax');
    assert.equal(cookie.path, '/');
    assert.equal(res.json().user.email, emailFor('admin'));
    assert.equal(res.json().user.role, 'admin');
    assert.equal(res.json().user.password_hash, undefined);

    const me = await app.inject({ method: 'GET', url: '/api/auth/me', headers: cookieHeader(cookie.value) });
    assert.equal(me.statusCode, 200);
    assert.equal(me.json().user.email, emailFor('admin'));
  });

  it('a wrong password is rejected with the error envelope', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/auth/login',
      payload: { email: emailFor('admin'), password: 'definitely-not-it' },
    });
    assert.equal(res.statusCode, 401);
    assert.equal(res.json().error.code, 'unauthorized');
  });

  it('logout clears the cookie and invalidates the session', async () => {
    const cookie = await loginAs('admin');
    const out = await app.inject({ method: 'POST', url: '/api/auth/logout', headers: cookieHeader(cookie) });
    assert.equal(out.statusCode, 200);
    assert.deepEqual(out.json(), { ok: true });

    const me = await app.inject({ method: 'GET', url: '/api/auth/me', headers: cookieHeader(cookie) });
    assert.equal(me.statusCode, 200);
    assert.equal(me.json().user, null);
  });
});

describe('error envelope', () => {
  it('unauthenticated /api/users -> 401 unauthorized', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/users' });
    assert.equal(res.statusCode, 401);
    assert.equal(res.json().error.code, 'unauthorized');
    assert.equal(typeof res.json().error.message, 'string');
  });

  it('zod failures -> 400 validation_error with issues', async () => {
    const res = await app.inject({ method: 'POST', url: '/api/auth/login', payload: {} });
    assert.equal(res.statusCode, 400);
    assert.equal(res.json().error.code, 'validation_error');
    assert.ok(Array.isArray(res.json().error.details.issues));
    assert.ok(res.json().error.details.issues.length > 0);
  });
});

describe('role ladder', () => {
  it('viewer may read but not delete', async () => {
    const cookie = await loginAs('viewer');
    const del = await app.inject({ method: 'DELETE', url: '/api/containers/whatever', headers: cookieHeader(cookie) });
    assert.equal(del.statusCode, 403);
    assert.equal(del.json().error.code, 'forbidden');
  });

  it('operator may not touch users or the audit log', async () => {
    const cookie = await loginAs('operator');
    const users = await app.inject({ method: 'GET', url: '/api/users', headers: cookieHeader(cookie) });
    assert.equal(users.statusCode, 403);
    const audit = await app.inject({ method: 'GET', url: '/api/audit', headers: cookieHeader(cookie) });
    assert.equal(audit.statusCode, 403);

    // Settings is owned by agent 3: if it is registered, an operator must be refused.
    const settings = await app.inject({ method: 'GET', url: '/api/settings', headers: cookieHeader(cookie) });
    if (settings.statusCode !== 404) assert.equal(settings.statusCode, 403);
  });

  it('admin is allowed', async () => {
    const cookie = await loginAs('admin');
    const res = await app.inject({ method: 'GET', url: '/api/users', headers: cookieHeader(cookie) });
    assert.equal(res.statusCode, 200);
    assert.ok(Array.isArray(res.json()));
    assert.ok(res.json().some((u: any) => u.email === emailFor('viewer')));
  });
});

describe('anonymous /api/system/info redaction', () => {
  it('health is public', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/system/health' });
    assert.equal(res.statusCode, 200);
    assert.equal(res.json().ok, true);
    assert.equal(typeof res.json().uptime, 'number');
  });

  it('anonymous callers get zeroed counts and no docker.containers', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/system/info' });
    assert.equal(res.statusCode, 200);
    const info = res.json();
    assert.ok(['real', 'demo'].includes(info.mode));
    assert.equal(info.docker.containers, undefined);
    assert.deepEqual(info.counts, {
      containers: 0,
      running: 0,
      images: 0,
      volumes: 0,
      networks: 0,
      tunnels: 0,
      tunnelsActive: 0,
      stacks: 0,
      templates: 0,
    });
  });

  it('authenticated callers get the full object', async () => {
    const cookie = await loginAs('admin');
    const res = await app.inject({ method: 'GET', url: '/api/system/info', headers: cookieHeader(cookie) });
    assert.equal(res.statusCode, 200);
    const info = res.json();
    assert.equal(typeof info.counts.containers, 'number');
    assert.equal(typeof info.counts.templates, 'number');
    if (dockerOk) {
      assert.equal(info.mode, 'real');
      assert.ok(info.docker.containers, 'authenticated callers see docker.containers');
      assert.equal(typeof info.docker.containers.total, 'number');
    }
  });
});

describe('container round-trip through the routes', () => {
  it('create -> start -> logs -> stats -> exec -> delete (real daemon)', async (t) => {
    if (!dockerOk) {
      t.skip('docker daemon unreachable');
      return;
    }

    const cookie = await loginAs('admin');
    const name = `dockyard-api-test-${RUN}`;
    let containerId: string | null = null;

    try {
      const created = await app.inject({
        method: 'POST',
        url: '/api/containers',
        headers: cookieHeader(cookie),
        payload: {
          name,
          image: 'alpine:3.20',
          cmd: ['sh', '-c', 'echo dockyard-route-ok; sleep 25'],
          pull: false,
          labels: { 'dockyard.managed': 'true', 'dockyard.test': RUN },
        },
      });
      assert.equal(created.statusCode, 201, `create failed: ${created.body}`);
      containerId = created.json().id;
      assert.ok(containerId);

      const started = await app.inject({
        method: 'POST',
        url: `/api/containers/${containerId}/start`,
        headers: cookieHeader(cookie),
      });
      assert.equal(started.statusCode, 200, `start failed: ${started.body}`);
      assert.equal(started.json().state, 'running');
      assert.equal(started.json().managed, true);

      // Give the process a moment to write its line.
      await new Promise((r) => setTimeout(r, 1200));

      const logs = await app.inject({
        method: 'GET',
        url: `/api/containers/${containerId}/logs?tail=50`,
        headers: cookieHeader(cookie),
      });
      assert.equal(logs.statusCode, 200);
      assert.match(logs.headers['content-type'] ?? '', /text\/plain/);
      assert.match(logs.body, /dockyard-route-ok/);

      const stats = await app.inject({
        method: 'GET',
        url: `/api/containers/${containerId}/stats`,
        headers: cookieHeader(cookie),
      });
      assert.equal(stats.statusCode, 200);
      assert.equal(typeof stats.json().memLimit, 'number');
      assert.equal(typeof stats.json().cpuPercent, 'number');

      const exec = await app.inject({
        method: 'POST',
        url: `/api/containers/${containerId}/exec`,
        headers: cookieHeader(cookie),
        payload: { cmd: ['echo', 'dockyard-exec-ok'] },
      });
      assert.equal(exec.statusCode, 200);
      assert.match(String(exec.json().stdout), /dockyard-exec-ok/);

      // Resolving by name must work too.
      const byName = await app.inject({ method: 'GET', url: `/api/containers/${name}`, headers: cookieHeader(cookie) });
      assert.equal(byName.statusCode, 200);
      assert.equal(byName.json().id, containerId);

      const removed = await app.inject({
        method: 'DELETE',
        url: `/api/containers/${containerId}?force=1`,
        headers: cookieHeader(cookie),
      });
      assert.equal(removed.statusCode, 200);
      assert.deepEqual(removed.json(), { ok: true });
      containerId = null;

      const gone = await app.inject({ method: 'GET', url: `/api/containers/${name}`, headers: cookieHeader(cookie) });
      assert.equal(gone.statusCode, 404);
      assert.equal(gone.json().error.code, 'not_found');
    } finally {
      if (containerId) {
        await app
          .inject({ method: 'DELETE', url: `/api/containers/${containerId}?force=1`, headers: cookieHeader(cookie) })
          .catch(() => undefined);
      }
    }
  });

  it('mutations landed in the audit trail', async () => {
    const cookie = await loginAs('admin');
    const res = await app.inject({ method: 'GET', url: '/api/audit?limit=50', headers: cookieHeader(cookie) });
    assert.equal(res.statusCode, 200);
    assert.ok(Array.isArray(res.json()));
    assert.ok(res.json().length > 0, 'expected at least one audit entry');
    assert.ok(res.json().every((e: any) => typeof e.action === 'string' && typeof e.created_at === 'string'));
  });
});
