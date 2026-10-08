// Dockyard — LocalTunnel exposure tests.
//
// Covers the two pure helpers that decide what gets sent to localtunnel.me, the
// migration that lets a tunnel row carry mode 'localtunnel', and the mode list the
// route and the manager share.
//
// The live client is deliberately not exercised here: it dials the public
// localtunnel.me service, which makes the suite depend on a third party. The live
// path is covered by the opt-in tunnel test (DOCKYARD_LIVE_TUNNEL_TESTS=1).

import { test, describe, after } from 'node:test';
import assert from 'node:assert/strict';

import { runMigrations } from '../src/db/migrate.ts';
import { pool, query, one, closePool } from '../src/db/pool.ts';
import { localTargetParts, sanitiseSubdomain } from '../src/tunnels/localtunnel.ts';
import { TUNNEL_MODES, providerOf } from '../src/tunnels/manager.ts';

after(async () => {
  await closePool();
});

describe('localTargetParts', () => {
  test('reads the host and port out of the targets the manager stores', () => {
    assert.deepEqual(localTargetParts('http://127.0.0.1:8080'), { host: '127.0.0.1', port: 8080 });
    assert.deepEqual(localTargetParts('http://localhost:3000'), { host: 'localhost', port: 3000 });
  });

  test('falls back to the scheme default when no port is written', () => {
    assert.deepEqual(localTargetParts('http://example.com'), { host: 'example.com', port: 80 });
    assert.deepEqual(localTargetParts('https://example.com'), { host: 'example.com', port: 443 });
  });

  test('refuses a target that is not a URL, naming the target', () => {
    assert.throws(() => localTargetParts('127.0.0.1:8080'), /not a URL/);
  });

  test('refuses a scheme with no port to expose', () => {
    // A non-http scheme has no default port, so there is nothing to dial.
    assert.throws(() => localTargetParts('ftp://example.com'), /usable port/);
  });
});

describe('sanitiseSubdomain', () => {
  test('turns a tunnel name into a subdomain localtunnel.me will accept', () => {
    assert.equal(sanitiseSubdomain('web preview'), 'web-preview');
    assert.equal(sanitiseSubdomain('My__Tunnel!!'), 'my-tunnel');
    assert.equal(sanitiseSubdomain('  UPPER  '), 'upper');
  });

  test('returns undefined when nothing usable is left, so an assigned one is asked for', () => {
    assert.equal(sanitiseSubdomain('ab'), undefined);
    assert.equal(sanitiseSubdomain('---'), undefined);
    assert.equal(sanitiseSubdomain(''), undefined);
  });

  test('caps the length', () => {
    const long = sanitiseSubdomain('a'.repeat(200));
    assert.ok(long !== undefined && long.length <= 40, `expected <=40 chars, got ${long}`);
  });
});

describe('exposure modes', () => {
  test('the shared mode list admits all three providers', () => {
    assert.deepEqual([...TUNNEL_MODES].sort(), ['localtunnel', 'named', 'quick']);
  });

  test('a mode reports the provider behind it, for messages', () => {
    assert.equal(providerOf('localtunnel'), 'localtunnel');
    assert.equal(providerOf('quick'), 'cloudflared');
    assert.equal(providerOf('named'), 'cloudflared');
  });
});

describe('tunnels.mode constraint', () => {
  test('a tunnel row can carry mode localtunnel', async () => {
    await runMigrations();

    const row = await one<{ id: string; mode: string }>(
      `insert into tunnels (name, mode, target_url) values ($1, 'localtunnel', $2) returning id, mode`,
      ['localtunnel-test', 'http://127.0.0.1:8080'],
    );
    assert.equal(row?.mode, 'localtunnel');

    await query('delete from tunnels where id = $1', [row?.id]);
    const gone = await one('select 1 from tunnels where id = $1', [row?.id]);
    assert.equal(gone, null, 'the test row should be cleaned up');
  });

  test('an unknown mode is still rejected by the database', async () => {
    await assert.rejects(
      () => query(`insert into tunnels (name, mode, target_url) values ($1, 'socks5', $2)`, [
        'bad-mode-test',
        'http://127.0.0.1:8080',
      ]),
      /tunnels_mode_check/,
    );
  });
});

// The pool is only here so the constraint tests can reach Postgres; fail loudly if
// it is not configured rather than reporting a green run that never ran.
test('the database is reachable for the constraint tests', async () => {
  const row = await pool.query('select 1 as ok');
  assert.equal(row.rows[0]?.ok, 1);
});
