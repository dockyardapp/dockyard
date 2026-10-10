// Dockyard — the WebSocket routes honour resource scoping.
//
// The three socket routes are a second door onto the same resources the REST
// routes serve, and they used to authenticate without applying the allocation:
// a user granted three containers could read the logs and stats of the other
// forty, and `/ws/events` delivered every container, tunnel and stack event on
// the host. The REST route for the same container answered 404.
//
// Two layers, like `scope.test.ts`:
//   1. the filter in `ws/visibility.ts` — pure, no DB, no daemon
//   2. the handlers over a REAL socket, with a real session and real grants
//
// The second layer is the one that matters: a filter that is only tested as a
// function can still be forgotten at a handler. The daemon is the in-memory mock
// (`mock-docker.ts`), so this file needs Postgres but no Docker.
//
//   export PATH=/root/.hermes/node/bin:$PATH
//   node --test server/test/ws-scope.test.ts

import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { createRequire } from 'node:module';
import type { AddressInfo } from 'node:net';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { startMockDocker } from './mock-docker.ts';

// Point the docker layer at the in-memory daemon BEFORE the app (and config) is
// imported, exactly as `docker.test.ts` does.
process.env.NODE_ENV = 'test';
const mock = await startMockDocker();
process.env.DOCKER_HOST = mock.url;

const { buildApp } = await import('../src/app.ts');
const { runMigrations } = await import('../src/db/migrate.ts');
const { closePool, one, query } = await import('../src/db/pool.ts');
const { hashPassword } = await import('../src/auth/password.ts');
const { createSession } = await import('../src/auth/sessions.ts');
const { bus } = await import('../src/events.ts');
const { canSeeContainer, eventVisible } = await import('../src/ws/visibility.ts');

import type { BusEvent } from '../src/events.ts';
import type { Grant, Scope } from '../src/auth/scope.ts';

const RUN = randomBytes(4).toString('hex');
const PASSWORD = 'test-password-123';
/** Unique per process, so a parallel test file cannot match this file's grants. */
const TEAM_KEY = 'dockyard.test.team';
const TEAM = `ws-team-${RUN}`;

const createdUserIds: string[] = [];
let app: FastifyInstance;
let port = 0;

// ---------------------------------------------------------------------------
// A WebSocket client
// ---------------------------------------------------------------------------

type WsLike = {
  on(event: 'open', cb: () => void): void;
  on(event: 'message', cb: (data: unknown, isBinary?: boolean) => void): void;
  on(event: 'close', cb: (code: number, reason: Buffer) => void): void;
  on(event: 'error', cb: (err: Error) => void): void;
  close(): void;
};

// `ws` is a hard dependency of `@fastify/websocket`, which is a direct
// dependency, but it ships no type declarations and `@types/ws` is not
// installed. Requiring it through `createRequire` keeps tsc from asking for
// types that are not there; the shape this file uses is `WsLike` above.
const WsClient = (createRequire(import.meta.url)('ws') as {
  WebSocket: new (url: string, options?: { headers?: Record<string, string> }) => WsLike;
}).WebSocket;

type Frame = Record<string, unknown>;

type Conn = {
  frames: Frame[];
  waitForOpen: () => Promise<void>;
  waitForClose: () => Promise<{ code: number; reason: string }>;
  waitFor: (predicate: (f: Frame) => boolean, label: string) => Promise<void>;
  closed: () => { code: number; reason: string } | null;
  close: () => void;
};

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

async function waitUntil(predicate: () => boolean, label: string, timeoutMs = 5000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await sleep(20);
  }
  throw new Error(`timed out waiting for ${label}`);
}

function connect(path: string, token: string | null): Conn {
  const headers: Record<string, string> = token ? { cookie: `dockyard_session=${token}` } : {};
  const socket = new WsClient(`ws://127.0.0.1:${port}${path}`, { headers });

  const frames: Frame[] = [];
  let open = false;
  let closeInfo: { code: number; reason: string } | null = null;

  socket.on('open', () => {
    open = true;
  });
  socket.on('message', (data: unknown) => {
    try {
      frames.push(JSON.parse(String(data)) as Frame);
    } catch {
      /* a non-JSON frame is not part of the protocol */
    }
  });
  socket.on('close', (code: number, reason: Buffer) => {
    closeInfo = { code, reason: String(reason ?? '') };
  });
  socket.on('error', () => {
    /* a refused upgrade surfaces as a close, not here */
  });

  return {
    frames,
    waitForOpen: () => waitUntil(() => open, `socket ${path} to open`),
    waitForClose: async () => {
      await waitUntil(() => closeInfo !== null, `socket ${path} to close`);
      return closeInfo as { code: number; reason: string };
    },
    waitFor: (predicate, label) => waitUntil(() => frames.some(predicate), label),
    closed: () => closeInfo,
    close: () => socket.close(),
  };
}

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

async function insertUser(role: 'admin' | 'operator', scopeMode: string): Promise<string> {
  const email = `ws-scope-${role}-${randomBytes(3).toString('hex')}-${RUN}@dockyard.test`;
  const row = await one<{ id: string }>(
    `insert into users (email, password_hash, role, scope_mode, can_exec)
     values ($1, $2, $3, $4, false) returning id`,
    [email, await hashPassword(PASSWORD), role, scopeMode],
  );
  assert.ok(row?.id, `failed to create ${role} test user`);
  createdUserIds.push(row.id);
  return row.id;
}

async function sessionFor(userId: string): Promise<string> {
  const { token } = await createSession(userId, {
    headers: {},
    ip: '127.0.0.1',
  } as unknown as FastifyRequest);
  return token;
}

async function grantById(userId: string, containerId: string): Promise<void> {
  await query(
    `insert into user_grants (user_id, resource_kind, resource_id) values ($1, 'container', $2)`,
    [userId, containerId],
  );
}

async function grantByLabel(userId: string, key: string, value: string): Promise<void> {
  await query(
    `insert into user_grants (user_id, resource_kind, label_key, label_value)
     values ($1, 'container', $2, $3)`,
    [userId, key, value],
  );
}

/** A container the scoped users are allocated, and one they are not. */
const grantedId = mock.seedContainer({
  name: `ws-granted-${RUN}`,
  labels: { [TEAM_KEY]: TEAM },
  logs: 'granted line one\ngranted line two\n',
});
const otherId = mock.seedContainer({
  name: `ws-other-${RUN}`,
  labels: {},
  logs: 'a line the scoped user must never read\n',
});

let adminToken = '';
let idToken = '';
let labelToken = '';

before(async () => {
  await runMigrations().catch(() => undefined);
  app = await buildApp();
  await app.ready();
  await app.listen({ port: 0, host: '127.0.0.1' });
  port = (app.server.address() as AddressInfo).port;

  adminToken = await sessionFor(await insertUser('admin', 'all'));

  const idUser = await insertUser('operator', 'granted');
  await grantById(idUser, grantedId);
  idToken = await sessionFor(idUser);

  const labelUser = await insertUser('operator', 'granted');
  await grantByLabel(labelUser, TEAM_KEY, TEAM);
  labelToken = await sessionFor(labelUser);
});

after(async () => {
  try {
    if (createdUserIds.length > 0) {
      await query('delete from audit_log where user_id = any($1::uuid[])', [createdUserIds]);
      await query('delete from sessions where user_id = any($1::uuid[])', [createdUserIds]);
      // user_grants cascades.
      await query('delete from users where id = any($1::uuid[])', [createdUserIds]);
    }
  } finally {
    await app?.close();
    await mock.close();
    await closePool();
  }
});

// ---------------------------------------------------------------------------
// Layer 1 — the filter itself
// ---------------------------------------------------------------------------

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

function event(type: BusEvent['type'], action: string, data: unknown): BusEvent {
  return { type, action, data };
}

describe('ws visibility filter', () => {
  const byId = granted({ resource_id: 'c'.repeat(64) });
  const byLabel = granted({ resource_kind: 'container', label_key: 'team', label_value: 'alpha' });
  const unrestricted = { mode: 'all', grants: [] } as Scope;

  it('lets an unrestricted scope through, whatever the payload', () => {
    assert.equal(eventVisible(unrestricted, event('container', 'start', { id: 'x' })), true);
    assert.equal(eventVisible(unrestricted, event('stack', 'deploy', {})), true);
    assert.equal(eventVisible(null, event('container', 'start', {})), true);
  });

  it('matches a scoped subscriber on the id the event carries', () => {
    assert.equal(eventVisible(byId, event('container', 'start', { id: 'c'.repeat(64) })), true);
    assert.equal(eventVisible(byId, event('container', 'start', { id: 'd'.repeat(64) })), false);
  });

  it('matches a scoped subscriber on a label the event carries', () => {
    const visible = event('container', 'start', { id: 'x', labels: { team: 'alpha' } });
    const hidden = event('container', 'start', { id: 'x', labels: { team: 'beta' } });
    assert.equal(eventVisible(byLabel, visible), true);
    assert.equal(eventVisible(byLabel, hidden), false);
  });

  it('withholds an event it cannot attribute to a resource', () => {
    // Failing closed is the only safe direction: an event with nothing to match
    // on cannot be shown to be the subscriber's.
    for (const payload of [null, undefined, {}, 'a string', 42, [], { unrelated: true }]) {
      assert.equal(
        eventVisible(byId, event('container', 'start', payload)),
        false,
        `payload ${JSON.stringify(payload) ?? 'undefined'} should be withheld`,
      );
    }
  });

  it('withholds an event whose type is not a resource kind', () => {
    assert.equal(eventVisible(byId, event('nonsense' as BusEvent['type'], 'x', { id: 'c'.repeat(64) })), false);
  });

  it('lets a tunnel event through when the container it exposes is granted', () => {
    const tunnelEvent = event('tunnel', 'start', {
      id: 'tunnel-1',
      name: 'web',
      container_id: 'c'.repeat(64),
      container_name: 'web',
    });
    assert.equal(eventVisible(byId, tunnelEvent), true);
    assert.equal(eventVisible(byLabel, tunnelEvent), false);
    assert.equal(
      eventVisible(granted({ resource_kind: 'tunnel', resource_id: 'tunnel-1' }), tunnelEvent),
      true,
    );
  });

  it('treats a container with no labels as visible to an id grant only', () => {
    assert.equal(canSeeContainer(byId, { id: 'c'.repeat(64), name: 'web', labels: {} }), true);
    assert.equal(canSeeContainer(byLabel, { id: 'c'.repeat(64), name: 'web', labels: {} }), false);
    assert.equal(
      canSeeContainer(byLabel, { id: 'z', name: 'web', labels: { team: 'alpha' } }),
      true,
    );
  });
});

// ---------------------------------------------------------------------------
// Layer 2 — the handlers, over a real socket
// ---------------------------------------------------------------------------

describe('ws container logs', () => {
  it('refuses an unauthenticated upgrade with 4401', async () => {
    const conn = connect(`/ws/containers/${grantedId}/logs`, null);
    const closed = await conn.waitForClose();
    assert.equal(closed.code, 4401, `expected 4401, got ${closed.code} ${closed.reason}`);
  });

  it('streams logs for a container the caller was allocated by id', async () => {
    const conn = connect(`/ws/containers/${grantedId}/logs`, idToken);
    await conn.waitFor((f) => f.type === 'log', 'a log line');
    const lines = conn.frames.filter((f) => f.type === 'log').map((f) => String(f.line));
    assert.ok(
      lines.some((l) => l.includes('granted line one')),
      `expected the container's own logs, got ${JSON.stringify(lines)}`,
    );
    conn.close();
  });

  it('streams logs for a container the caller was allocated by label', async () => {
    // This is what proves the label reaches the socket: the grant names no id,
    // so the check can only pass by reading the container's labels.
    const conn = connect(`/ws/containers/${grantedId}/logs`, labelToken);
    await conn.waitFor((f) => f.type === 'log', 'a log line');
    conn.close();
  });

  it('refuses a container outside the allocation, exactly like a missing one', async () => {
    const conn = connect(`/ws/containers/${otherId}/logs`, idToken);
    const closed = await conn.waitForClose();
    assert.equal(closed.code, 1000, `expected a clean close, got ${closed.code}`);
    assert.equal(conn.frames.some((f) => f.type === 'log'), false, 'no log line may be delivered');
    const end = conn.frames.find((f) => f.type === 'end');
    assert.equal(end?.reason, 'container_gone', 'must read exactly like a container that is gone');
  });

  it('refuses the same container for a label-scoped caller too', async () => {
    const conn = connect(`/ws/containers/${otherId}/logs`, labelToken);
    await conn.waitForClose();
    assert.equal(conn.frames.some((f) => f.type === 'log'), false);
  });

  it('still streams it for an unrestricted caller', async () => {
    const conn = connect(`/ws/containers/${otherId}/logs`, adminToken);
    await conn.waitFor((f) => f.type === 'log', 'a log line');
    conn.close();
  });
});

describe('ws container stats', () => {
  it('refuses a container outside the allocation', async () => {
    const conn = connect(`/ws/containers/${otherId}/stats`, idToken);
    await conn.waitForClose();
    assert.equal(conn.frames.some((f) => f.type === 'stats'), false, 'no stats may be delivered');
  });

  it('pushes stats for a container inside the allocation', async () => {
    const conn = connect(`/ws/containers/${grantedId}/stats`, idToken);
    await conn.waitFor((f) => f.type === 'stats', 'a stats frame');
    conn.close();
  });
});

describe('ws events', () => {
  it('delivers a scoped subscriber only the events it may see', async () => {
    const conn = connect('/ws/events', idToken);
    await conn.waitForOpen();

    // The handler subscribes after authenticating, which is an async read, so an
    // event emitted the instant the socket opens can be missed. A probe the
    // subscriber must see pins the subscription live before the assertions.
    bus.emit(event('container', 'probe', { id: grantedId, name: 'granted' }));
    await conn.waitFor((f) => f.action === 'probe', 'the subscription to be live');

    // The bus is synchronous and ordered, so the withheld event is emitted first
    // and the visible one after it: by the time the visible one has arrived, a
    // delivery of the withheld one would already be in the buffer. That makes the
    // negative assertion a fact rather than a race.
    bus.emit(event('container', 'other', { id: otherId, name: 'other' }));
    bus.emit(event('container', 'visible', { id: grantedId, name: 'granted' }));
    await conn.waitFor((f) => f.action === 'visible', 'the visible event');

    assert.equal(
      conn.frames.some((f) => f.action === 'other'),
      false,
      'an event for a container outside the allocation must not be delivered',
    );
    conn.close();
  });

  it('withholds an event it cannot attribute to any resource', async () => {
    const conn = connect('/ws/events', idToken);
    await conn.waitForOpen();
    bus.emit(event('container', 'probe', { id: grantedId, name: 'granted' }));
    await conn.waitFor((f) => f.action === 'probe', 'the subscription to be live');

    bus.emit(event('container', 'unattributable', { note: 'no id, no name, no labels' }));
    bus.emit(event('container', 'visible', { id: grantedId, name: 'granted' }));
    await conn.waitFor((f) => f.action === 'visible', 'the visible event');

    assert.equal(conn.frames.some((f) => f.action === 'unattributable'), false);
    conn.close();
  });

  it('still delivers everything to an unrestricted subscriber', async () => {
    const conn = connect('/ws/events', adminToken);
    await conn.waitForOpen();
    bus.emit(event('container', 'probe', { id: grantedId, name: 'granted' }));
    await conn.waitFor((f) => f.action === 'probe', 'the subscription to be live');

    bus.emit(event('container', 'other', { id: otherId, name: 'other' }));
    await conn.waitFor((f) => f.action === 'other', 'the event an admin may see');
    conn.close();
  });

  it('refuses an unauthenticated subscriber with 4401', async () => {
    const conn = connect('/ws/events', null);
    const closed = await conn.waitForClose();
    assert.equal(closed.code, 4401);
  });
});
