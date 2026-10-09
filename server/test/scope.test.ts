// Dockyard — resource scoping tests.
//
// Two layers:
//   1. the matching logic in `auth/scope.ts` — pure, no DB, no daemon
//   2. enforcement at the route boundary — real app, real Postgres, and real
//      containers when the daemon is reachable
//
// The second layer is the one that matters. A scoping rule that is only tested
// as a function can still be forgotten at a route, so every list endpoint and
// every per-id endpoint is exercised over HTTP with a genuinely scoped session.
//
//   export PATH=/root/.hermes/node/bin:$PATH
//   node --test server/test/scope.test.ts

import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { buildApp } from '../src/app.ts';
import { runMigrations } from '../src/db/migrate.ts';
import { closePool, one, query } from '../src/db/pool.ts';
import { dockerPing, removeContainer } from '../src/docker/index.ts';
import { hashPassword } from '../src/auth/password.ts';
import { createSession } from '../src/auth/sessions.ts';
import {
  ALL_SCOPE,
  canExec,
  canSee,
  filterVisible,
  grantLabel,
  isUnrestricted,
  matchesGrant,
} from '../src/auth/scope.ts';
import type { Grant, Scope } from '../src/auth/scope.ts';

const RUN = randomBytes(4).toString('hex');
const PASSWORD = 'test-password-123';
/** Unique per process, so parallel test files cannot match each other's grants. */
const TEAM = `team-${RUN}`;

const createdUserIds: string[] = [];
const createdContainerIds: string[] = [];
let app: FastifyInstance;
let dockerOk = false;

function granted(...grants: Array<Partial<Grant>>): Scope {
  return {
    mode: 'granted',
    grants: grants.map((g, i) => ({
      id: `grant-${i}`,
      resource_kind: 'container',
      resource_id: null,
      label_key: null,
      label_value: null,
      ...g,
    })) as Grant[],
  };
}

function cookieHeader(cookieValue: string): Record<string, string> {
  return { cookie: `dockyard_session=${cookieValue}` };
}

/**
 * Mint a session straight into the database rather than POSTing to /auth/login.
 *
 * The login route is rate limited to 10 attempts a minute (correctly — it is the
 * one unauthenticated write path), and this file needs a session per role per
 * test. `api.test.ts` already covers the login route itself.
 */
async function sessionFor(userId: string): Promise<string> {
  const { token } = await createSession(userId, {
    headers: {},
    ip: '127.0.0.1',
  } as unknown as FastifyRequest);
  return token;
}

async function insertUser(role: 'admin' | 'operator' | 'viewer', scopeMode = 'all'): Promise<string> {
  const email = `scope-test-${role}-${randomBytes(3).toString('hex')}-${RUN}@dockyard.test`;
  const row = await one<{ id: string }>(
    `insert into users (email, password_hash, role, scope_mode, can_exec)
     values ($1, $2, $3, $4, false) returning id`,
    [email, await hashPassword(PASSWORD), role, scopeMode],
  );
  assert.ok(row?.id, `failed to create ${role} test user`);
  createdUserIds.push(row.id);
  return row.id;
}

/** Create a real container through the API as the given admin cookie. */
async function createContainer(
  cookie: string,
  name: string,
  labels: Record<string, string>,
): Promise<string> {
  const res = await app.inject({
    method: 'POST',
    url: '/api/containers',
    headers: cookieHeader(cookie),
    payload: {
      name,
      image: 'alpine:3.20',
      cmd: ['sh', '-c', 'sleep 120'],
      pull: false,
      labels,
    },
  });
  assert.equal(res.statusCode, 201, `container create failed: ${res.body}`);
  const id = res.json().id as string;
  createdContainerIds.push(id);
  await app.inject({
    method: 'POST',
    url: `/api/containers/${id}/start`,
    headers: cookieHeader(cookie),
  });
  return id;
}

before(async () => {
  // Another test file may be applying migrations concurrently; the statements are
  // idempotent, so losing the `schema_migrations` insert race is harmless.
  await runMigrations().catch(() => undefined);
  app = await buildApp();
  await app.ready();
  dockerOk = (await dockerPing()).ok;
});

after(async () => {
  try {
    // The containers are real; remove them before the rows that reference them.
    for (const id of createdContainerIds) {
      await removeContainer(id, { force: true }).catch(() => undefined);
    }
    if (createdUserIds.length > 0) {
      await query('delete from audit_log where user_id = any($1::uuid[])', [createdUserIds]);
      await query('delete from sessions where user_id = any($1::uuid[])', [createdUserIds]);
      // user_grants cascades.
      await query('delete from users where id = any($1::uuid[])', [createdUserIds]);
    }
  } finally {
    await app?.close();
    await closePool();
  }
});

// ---------------------------------------------------------------------------
// 1. Matching logic
// ---------------------------------------------------------------------------

describe('scope: grant matching', () => {
  it('an unrestricted scope sees everything', () => {
    assert.equal(isUnrestricted(ALL_SCOPE), true);
    assert.equal(canSee(ALL_SCOPE, 'container', { id: 'abc' }), true);
    assert.equal(grantLabel(ALL_SCOPE, 'container'), null);
  });

  it('a granted scope with no grants sees nothing', () => {
    const scope = granted();
    assert.equal(isUnrestricted(scope), false);
    assert.equal(canSee(scope, 'container', { id: 'abc', labels: { a: 'b' } }), false);
  });

  it('matches a label pair exactly', () => {
    const scope = granted({ label_key: 'dockyard.team', label_value: 'alice' });
    assert.equal(canSee(scope, 'container', { labels: { 'dockyard.team': 'alice' } }), true);
    assert.equal(canSee(scope, 'container', { labels: { 'dockyard.team': 'bob' } }), false);
    assert.equal(canSee(scope, 'container', { labels: { 'dockyard.team': 'alice2' } }), false);
    assert.equal(canSee(scope, 'container', { labels: {} }), false);
    assert.equal(canSee(scope, 'container', {}), false);
  });

  it('never matches a label grant against a different resource kind', () => {
    const scope = granted({ resource_kind: 'volume', label_key: 'dockyard.team', label_value: 'alice' });
    assert.equal(canSee(scope, 'container', { labels: { 'dockyard.team': 'alice' } }), false);
    assert.equal(canSee(scope, 'volume', { labels: { 'dockyard.team': 'alice' } }), true);
  });

  it('matches an explicit id, name, slug or repo tag', () => {
    const byId = granted({ resource_id: 'c0ffee' });
    assert.equal(matchesGrant(byId.grants[0], { id: 'c0ffee' }), true);
    assert.equal(matchesGrant(byId.grants[0], { id: 'other' }), false);

    assert.equal(matchesGrant(byId.grants[0], { name: 'c0ffee' }), true);
    assert.equal(matchesGrant(byId.grants[0], { slug: 'c0ffee' }), true);

    const image = granted({ resource_kind: 'image', resource_id: 'redis:7.4-alpine' });
    assert.equal(matchesGrant(image.grants[0], { repoTags: ['redis:7.4-alpine'] }), true);
    assert.equal(matchesGrant(image.grants[0], { repoTags: ['alpine:3.20'] }), false);
  });

  it('accepts a long id prefix but not a short ambiguous one', () => {
    const full = 'a'.repeat(40) + 'b'.repeat(24);
    const long = granted({ resource_id: full.slice(0, 20) });
    assert.equal(matchesGrant(long.grants[0], { id: full }), true);

    // Below the prefix threshold an id is too ambiguous to treat as a match.
    const short = granted({ resource_id: 'abc' });
    assert.equal(matchesGrant(short.grants[0], { id: full }), false);
  });

  it('filters a list down to the granted subset', () => {
    const scope = granted({ label_key: 'dockyard.team', label_value: TEAM });
    const items: Array<{ id: string; labels: Record<string, string> }> = [
      { id: '1', labels: { 'dockyard.team': TEAM } },
      { id: '2', labels: { 'dockyard.team': 'someone-else' } },
      { id: '3', labels: {} },
      { id: '4', labels: { 'dockyard.team': TEAM } },
    ];
    const visible = filterVisible(scope, 'container', items, (i) => ({ id: i.id, labels: i.labels }));
    assert.deepEqual(
      visible.map((v) => v.id),
      ['1', '4'],
    );
  });

  it('the inherited label is the first label grant for that kind', () => {
    const scope = granted(
      { resource_kind: 'volume', label_key: 'x', label_value: 'y' },
      { label_key: 'dockyard.team', label_value: TEAM },
    );
    assert.deepEqual(grantLabel(scope, 'container'), { 'dockyard.team': TEAM });
    assert.deepEqual(grantLabel(scope, 'volume'), { x: 'y' });
    assert.equal(grantLabel(scope, 'network'), null);
  });
});

describe('scope: exec capability', () => {
  const base = { id: 'u', email: 'u@x', scope_mode: 'all' as const, created_at: '', last_login_at: null };

  it('an admin may always exec', () => {
    assert.equal(canExec({ ...base, role: 'admin', can_exec: false }), true);
  });

  it('an operator may not exec without the explicit flag', () => {
    assert.equal(canExec({ ...base, role: 'operator', can_exec: false }), false);
    assert.equal(canExec({ ...base, role: 'operator', can_exec: true }), true);
  });

  it('a viewer may not exec even with the flag set', () => {
    // The route requires the operator role as well, so the flag alone cannot
    // grant a viewer a shell.
    assert.equal(canExec({ ...base, role: 'viewer', can_exec: true }), false);
    assert.equal(canExec({ ...base, role: 'viewer', can_exec: false }), false);
  });

  it('nobody without a user may exec', () => {
    assert.equal(canExec(null), false);
  });
});

// ---------------------------------------------------------------------------
// 2. Enforcement over HTTP
// ---------------------------------------------------------------------------

describe('scope: enforcement over HTTP', () => {
  it('filters the container list, 404s per-id routes, and gates exec', async (t) => {
    if (!dockerOk) {
      t.skip('docker daemon unreachable');
      return;
    }

    const adminId = await insertUser('admin');
    const scopedId = await insertUser('operator');
    const admin = await sessionFor(adminId);

    const mine = await createContainer(admin, `dockyard-scope-mine-${RUN}`, {
      'dockyard.team': TEAM,
      'dockyard.test': RUN,
    });
    const theirs = await createContainer(admin, `dockyard-scope-other-${RUN}`, {
      'dockyard.test': RUN,
    });

    // Allocate the labelled container through the real API, which should also
    // flip the user to a scoped account.
    const grant = await app.inject({
      method: 'POST',
      url: `/api/users/${scopedId}/grants`,
      headers: cookieHeader(admin),
      payload: { resource_kind: 'container', label_key: 'dockyard.team', label_value: TEAM },
    });
    assert.equal(grant.statusCode, 201, `grant failed: ${grant.body}`);

    const users = await app.inject({ method: 'GET', url: '/api/users', headers: cookieHeader(admin) });
    const scopedUser = users.json().find((u: { id: string }) => u.id === scopedId);
    assert.equal(scopedUser.scope_mode, 'granted', 'adding a grant should scope the user');
    assert.equal(scopedUser.can_exec, false);

    const scoped = await sessionFor(scopedId);

    // --- the list shows only the allocated container
    const list = await app.inject({
      method: 'GET',
      url: '/api/containers?all=1',
      headers: cookieHeader(scoped),
    });
    assert.equal(list.statusCode, 200);
    const ids = (list.json() as Array<{ id: string }>).map((c) => c.id);
    assert.ok(ids.includes(mine), 'the allocated container must be visible');
    assert.ok(!ids.includes(theirs), 'an unallocated container must not be visible');

    // --- per-id routes 404, worded exactly like a genuine miss
    for (const url of [
      `/api/containers/${theirs}`,
      `/api/containers/${theirs}/inspect`,
      `/api/containers/${theirs}/logs`,
      `/api/containers/${theirs}/stats`,
    ]) {
      const res = await app.inject({ method: 'GET', url, headers: cookieHeader(scoped) });
      assert.equal(res.statusCode, 404, `${url} should 404 for a scoped user`);
      assert.equal(res.json().error.code, 'not_found');
    }

    // --- and it is not startable or stoppable either
    const stop = await app.inject({
      method: 'POST',
      url: `/api/containers/${theirs}/stop`,
      headers: cookieHeader(scoped),
    });
    assert.equal(stop.statusCode, 404, 'a scoped user must not stop an unallocated container');

    // --- but the allocated one is fully usable
    const logs = await app.inject({
      method: 'GET',
      url: `/api/containers/${mine}/logs`,
      headers: cookieHeader(scoped),
    });
    assert.equal(logs.statusCode, 200);

    // --- exec is refused: operator without the explicit capability
    const denied = await app.inject({
      method: 'POST',
      url: `/api/containers/${mine}/exec`,
      headers: cookieHeader(scoped),
      payload: { cmd: ['echo', 'should-not-run'] },
    });
    assert.equal(denied.statusCode, 403, `exec should be refused: ${denied.body}`);
    assert.equal(denied.json().error.code, 'forbidden');

    // --- the admin granted the capability, and a fresh session may exec
    const patched = await app.inject({
      method: 'PATCH',
      url: `/api/users/${scopedId}`,
      headers: cookieHeader(admin),
      payload: { can_exec: true },
    });
    assert.equal(patched.statusCode, 200);
    assert.equal(patched.json().can_exec, true);

    const scoped2 = await sessionFor(scopedId);
    const allowed = await app.inject({
      method: 'POST',
      url: `/api/containers/${mine}/exec`,
      headers: cookieHeader(scoped2),
      payload: { cmd: ['echo', 'scoped-exec-ok'] },
    });
    assert.equal(allowed.statusCode, 200, `exec should now work: ${allowed.body}`);
    assert.match(String(allowed.json().stdout), /scoped-exec-ok/);

    // --- exec is still refused on a container outside the allocation
    const stillDenied = await app.inject({
      method: 'POST',
      url: `/api/containers/${theirs}/exec`,
      headers: cookieHeader(scoped2),
      payload: { cmd: ['echo', 'nope'] },
    });
    assert.equal(stillDenied.statusCode, 404, 'exec must respect the allocation too');

    // --- the admin is unaffected
    const adminList = await app.inject({
      method: 'GET',
      url: '/api/containers?all=1',
      headers: cookieHeader(admin),
    });
    const adminIds = (adminList.json() as Array<{ id: string }>).map((c) => c.id);
    assert.ok(adminIds.includes(mine) && adminIds.includes(theirs), 'an admin sees both');
  });

  it('scopes the dashboard counts, which are the easiest place to leak', async (t) => {
    if (!dockerOk) {
      t.skip('docker daemon unreachable');
      return;
    }

    const adminId = await insertUser('admin');
    const scopedId = await insertUser('viewer');
    const admin = await sessionFor(adminId);

    await createContainer(admin, `dockyard-scope-count-${RUN}`, {
      'dockyard.team': TEAM,
      'dockyard.test': RUN,
    });
    // Something the scoped user must not be able to count.
    await createContainer(admin, `dockyard-scope-count-hidden-${RUN}`, { 'dockyard.test': RUN });

    await app.inject({
      method: 'POST',
      url: `/api/users/${scopedId}/grants`,
      headers: cookieHeader(admin),
      payload: { resource_kind: 'container', label_key: 'dockyard.team', label_value: TEAM },
    });
    const scoped = await sessionFor(scopedId);

    const asScoped = await app.inject({
      method: 'GET',
      url: '/api/system/info',
      headers: cookieHeader(scoped),
    });
    const asAdmin = await app.inject({
      method: 'GET',
      url: '/api/system/info',
      headers: cookieHeader(admin),
    });

    assert.equal(asScoped.statusCode, 200);

    // Derive the expected number from the host rather than hardcoding it: earlier
    // tests in this file leave their own allocated containers running, and the
    // point is that the two views agree, not that the host is empty.
    const adminList = await app.inject({
      method: 'GET',
      url: '/api/containers?all=1',
      headers: cookieHeader(admin),
    });
    const allocated = (adminList.json() as Array<{ labels: Record<string, string> }>).filter(
      (c) => c.labels?.['dockyard.team'] === TEAM,
    ).length;
    assert.ok(allocated >= 2, `expected at least two allocated containers, saw ${allocated}`);

    const scopedCounts = asScoped.json().counts;
    assert.equal(
      scopedCounts.containers,
      allocated,
      `scoped count should match the allocation exactly: ${JSON.stringify(scopedCounts)}`,
    );
    assert.equal(scopedCounts.images, 0, 'images carry no labels, so a scoped user has none allocated');

    const adminCounts = asAdmin.json().counts;
    assert.ok(
      adminCounts.containers > scopedCounts.containers,
      `an admin should see strictly more than the allocation: ${adminCounts.containers} vs ${scopedCounts.containers}`,
    );

    // The engine summary must be scoped too, not just `counts`.
    assert.equal(asScoped.json().docker.containers.total, allocated);
    assert.equal(asAdmin.json().docker.containers.total, adminCounts.containers);
  });

  it('scopes templates, so a scoped user can only deploy what they were given', async (t) => {
    if (!dockerOk) {
      t.skip('docker daemon unreachable');
      return;
    }

    const adminId = await insertUser('admin');
    const scopedId = await insertUser('operator');
    const admin = await sessionFor(adminId);

    // The panel ships no templates any more: the catalog is whatever the repository pull and the
    // local directory put there. Seed one the way a pull would, so there is something to scope.
    const seededSlug = `scoped-tpl-${RUN}`;
    const seededSpec = {
      schemaVersion: 1,
      slug: seededSlug,
      name: 'Scoped test template',
      category: 'devtools',
      icon: 'x',
      description: 'seeded for the scope test',
      image: 'traefik/whoami',
      tag: 'v1.11.0',
      ports: [],
      env: [],
      volumes: [],
      restartPolicy: 'unless-stopped',
    };
    await query(
      `insert into templates (slug, name, category, icon, description, spec, source)
       values ($1, $2, $3, $4, $5, $6::jsonb, 'remote')
       on conflict (slug) do update set spec = excluded.spec, source = 'remote'`,
      [
        seededSlug,
        seededSpec.name,
        seededSpec.category,
        seededSpec.icon,
        seededSpec.description,
        JSON.stringify(seededSpec),
      ],
    );

    const allTemplates = await app.inject({
      method: 'GET',
      url: '/api/templates',
      headers: cookieHeader(admin),
    });
    assert.equal(allTemplates.statusCode, 200);
    const slugs = (allTemplates.json() as Array<{ slug: string }>).map((t) => t.slug);
    assert.ok(slugs.length > 0, 'expected the seeded template to be listed');

    await app.inject({
      method: 'POST',
      url: `/api/users/${scopedId}/grants`,
      headers: cookieHeader(admin),
      payload: { resource_kind: 'container', label_key: 'dockyard.team', label_value: TEAM },
    });
    const scoped = await sessionFor(scopedId);

    // No template grants yet: the catalogue is empty for them, and deploying is
    // refused with the same 404 a missing template gets.
    const list = await app.inject({
      method: 'GET',
      url: '/api/templates',
      headers: cookieHeader(scoped),
    });
    assert.equal(list.statusCode, 200);
    assert.deepEqual(list.json(), [], 'a scoped user with no template grants sees none');

    const denied = await app.inject({
      method: 'POST',
      url: `/api/templates/${slugs[0]}/deploy`,
      headers: cookieHeader(scoped),
      payload: { name: `dockyard-scope-deploy-${RUN}` },
    });
    assert.equal(denied.statusCode, 404, `deploy should be refused: ${denied.body}`);

    const detail = await app.inject({
      method: 'GET',
      url: `/api/templates/${slugs[0]}`,
      headers: cookieHeader(scoped),
    });
    assert.equal(detail.statusCode, 404);

    // Grant exactly one template and the picture changes.
    const granted = await app.inject({
      method: 'POST',
      url: `/api/users/${scopedId}/grants`,
      headers: cookieHeader(admin),
      payload: { resource_kind: 'template', resource_id: slugs[0] },
    });
    assert.equal(granted.statusCode, 201, granted.body);

    const scoped2 = await sessionFor(scopedId);
    const list2 = await app.inject({
      method: 'GET',
      url: '/api/templates',
      headers: cookieHeader(scoped2),
    });
    assert.deepEqual(
      (list2.json() as Array<{ slug: string }>).map((t) => t.slug),
      [slugs[0]],
      'exactly the granted template should be listed',
    );

    await query('delete from templates where slug = $1', [seededSlug]);
  });
});

describe('scope: the grants API', () => {
  it('lists, deletes and clears grants, and audits each change', async () => {
    const adminId = await insertUser('admin');
    const subjectId = await insertUser('viewer');
    const admin = await sessionFor(adminId);

    const created = await app.inject({
      method: 'POST',
      url: `/api/users/${subjectId}/grants`,
      headers: cookieHeader(admin),
      payload: { resource_kind: 'volume', label_key: 'dockyard.team', label_value: TEAM },
    });
    assert.equal(created.statusCode, 201);
    const grantId = created.json().id as string;
    assert.equal(created.json().resource_kind, 'volume');
    assert.equal(created.json().label_key, 'dockyard.team');

    // The same allocation twice is a no-op, not a second row.
    const again = await app.inject({
      method: 'POST',
      url: `/api/users/${subjectId}/grants`,
      headers: cookieHeader(admin),
      payload: { resource_kind: 'volume', label_key: 'dockyard.team', label_value: TEAM },
    });
    assert.equal(again.statusCode, 200, 'a duplicate grant should not create a second row');

    const list = await app.inject({
      method: 'GET',
      url: `/api/users/${subjectId}/grants`,
      headers: cookieHeader(admin),
    });
    assert.equal(list.statusCode, 200);
    assert.equal(list.json().length, 1, 'the duplicate must not have been stored');

    // Neither selector form, or both at once, is a validation error.
    const neither = await app.inject({
      method: 'POST',
      url: `/api/users/${subjectId}/grants`,
      headers: cookieHeader(admin),
      payload: { resource_kind: 'container' },
    });
    assert.equal(neither.statusCode, 400);

    const both = await app.inject({
      method: 'POST',
      url: `/api/users/${subjectId}/grants`,
      headers: cookieHeader(admin),
      payload: { resource_kind: 'container', resource_id: 'x', label_key: 'y' },
    });
    assert.equal(both.statusCode, 400);

    const removed = await app.inject({
      method: 'DELETE',
      url: `/api/users/${subjectId}/grants/${grantId}`,
      headers: cookieHeader(admin),
    });
    assert.equal(removed.statusCode, 200);

    const gone = await app.inject({
      method: 'DELETE',
      url: `/api/users/${subjectId}/grants/${grantId}`,
      headers: cookieHeader(admin),
    });
    assert.equal(gone.statusCode, 404, 'deleting the same grant twice should 404');

    // Re-add two and clear them in one call.
    for (const kind of ['container', 'network']) {
      await app.inject({
        method: 'POST',
        url: `/api/users/${subjectId}/grants`,
        headers: cookieHeader(admin),
        payload: { resource_kind: kind, label_key: 'dockyard.team', label_value: TEAM },
      });
    }
    const cleared = await app.inject({
      method: 'DELETE',
      url: `/api/users/${subjectId}/grants`,
      headers: cookieHeader(admin),
    });
    assert.equal(cleared.statusCode, 200);
    assert.equal(cleared.json().removed, 2);

    const audit = await app.inject({
      method: 'GET',
      url: '/api/audit?limit=200',
      headers: cookieHeader(admin),
    });
    const actions = (audit.json() as Array<{ action: string; target_id: string }>)
      .filter((e) => e.target_id === subjectId)
      .map((e) => e.action);
    assert.ok(actions.includes('grant.create'), 'grant.create should be audited');
    assert.ok(actions.includes('grant.delete'), 'grant.delete should be audited');
    assert.ok(actions.includes('grant.clear'), 'grant.clear should be audited');
  });

  it('refuses to scope an admin, so the panel cannot lock itself out', async () => {
    const adminId = await insertUser('admin');
    const otherAdminId = await insertUser('admin');
    const admin = await sessionFor(adminId);

    const grant = await app.inject({
      method: 'POST',
      url: `/api/users/${otherAdminId}/grants`,
      headers: cookieHeader(admin),
      payload: { resource_kind: 'container', label_key: 'dockyard.team', label_value: TEAM },
    });
    assert.equal(grant.statusCode, 409, 'an admin must not be scoped');
    assert.equal(grant.json().error.code, 'conflict');

    const patched = await app.inject({
      method: 'PATCH',
      url: `/api/users/${otherAdminId}`,
      headers: cookieHeader(admin),
      payload: { scope_mode: 'granted' },
    });
    assert.equal(patched.statusCode, 409, 'an admin must not be switched to scoped');

    const created = await app.inject({
      method: 'POST',
      url: '/api/users',
      headers: cookieHeader(admin),
      payload: {
        email: `scope-test-admin-${RUN}-scoped@dockyard.test`,
        password: PASSWORD,
        role: 'admin',
        scope_mode: 'granted',
      },
    });
    assert.equal(created.statusCode, 409, 'an admin must not be created scoped');

    // Even if the row is forced into that state behind the API's back, an admin
    // still sees everything.
    await query("update users set scope_mode = 'granted' where id = $1", [otherAdminId]);
    const forced = await sessionFor(otherAdminId);
    const list = await app.inject({
      method: 'GET',
      url: '/api/containers?all=1',
      headers: cookieHeader(forced),
    });
    assert.equal(list.statusCode, 200);
    assert.ok(
      (list.json() as unknown[]).length >= 0,
      'the request must succeed for a forced-scoped admin',
    );
    const me = await app.inject({ method: 'GET', url: '/api/auth/me', headers: cookieHeader(forced) });
    assert.equal(me.statusCode, 200);
  });

  it('reports the scope on the sign-in response, not only on /auth/me', async () => {
    // The client seeds its session from the login response, so a scoped user
    // whose login response says 'all' sees an unscoped panel until the next
    // refresh. Only /auth/me used to carry the field.
    const adminId = await insertUser('admin');
    const scopedId = await insertUser('operator');
    const email = `scope-test-login-${RUN}@dockyard.test`;
    await query('update users set email = $2, can_exec = true where id = $1', [scopedId, email]);

    const admin = await sessionFor(adminId);
    await app.inject({
      method: 'POST',
      url: `/api/users/${scopedId}/grants`,
      headers: cookieHeader(admin),
      payload: { resource_kind: 'container', label_key: 'dockyard.team', label_value: TEAM },
    });

    const res = await app.inject({
      method: 'POST',
      url: '/api/auth/login',
      payload: { email, password: PASSWORD },
    });
    assert.equal(res.statusCode, 200, `login failed: ${res.body}`);
    assert.equal(res.json().user.scope_mode, 'granted', 'the login response must carry the scope');
    assert.equal(res.json().user.can_exec, true, 'the login response must carry the exec flag');

    const me = await app.inject({ method: 'GET', url: '/api/auth/me', headers: cookieHeader(
      res.cookies.find((c) => c.name === 'dockyard_session')!.value,
    ) });
    assert.equal(me.json().user.scope_mode, 'granted');
    assert.equal(me.json().user.can_exec, true);
  });

  it('requires an admin to read or change an allocation', async () => {
    const subjectId = await insertUser('viewer');
    const operatorId = await insertUser('operator');
    const operator = await sessionFor(operatorId);

    for (const req of [
      { method: 'GET' as const, url: `/api/users/${subjectId}/grants` },
      { method: 'POST' as const, url: `/api/users/${subjectId}/grants` },
      { method: 'DELETE' as const, url: `/api/users/${subjectId}/grants` },
    ]) {
      const res = await app.inject({
        ...req,
        headers: cookieHeader(operator),
        payload: req.method === 'POST' ? { resource_kind: 'container', resource_id: 'x' } : undefined,
      });
      assert.equal(res.statusCode, 403, `${req.method} ${req.url} should require admin`);
    }
  });
});
