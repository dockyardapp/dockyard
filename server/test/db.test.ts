// Dockyard — database + migration tests (owner: agent 1).
//
// Runs the migrations against the real local Postgres, asserts the resulting schema, then
// inserts/reads/deletes a row and cleans up. Leaves the schema intact for the other agents.

import { test, describe, after } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { runMigrations, migrationStatus } from '../src/db/migrate.ts';
import { pool, query, one, many, tx, closePool, dbHealth } from '../src/db/pool.ts';

const EXPECTED_TABLES = ['users', 'sessions', 'audit_log', 'templates', 'stacks', 'tunnels', 'settings'];

const EXPECTED_COLUMNS: Record<string, string[]> = {
  users: ['id', 'email', 'password_hash', 'role', 'created_at', 'last_login_at'],
  sessions: ['id', 'user_id', 'token_hash', 'user_agent', 'ip', 'created_at', 'expires_at'],
  audit_log: ['id', 'user_id', 'action', 'target_type', 'target_id', 'detail', 'ip', 'created_at'],
  templates: ['id', 'slug', 'name', 'category', 'icon', 'description', 'spec', 'source', 'created_at', 'updated_at'],
  stacks: ['id', 'name', 'slug', 'source', 'template_slug', 'spec', 'values', 'status', 'created_by', 'created_at', 'updated_at'],
  tunnels: [
    'id', 'name', 'mode', 'target_url', 'container_id', 'port', 'hostname', 'zone_id', 'tunnel_id',
    'credentials_path', 'config_path', 'status', 'url', 'pid', 'last_error', 'auto_start', 'created_by',
    'created_at', 'updated_at',
  ],
  settings: ['key', 'value', 'secret', 'updated_at'],
};

const EXPECTED_CONSTRAINTS = [
  'users_pkey', 'users_email_key', 'users_role_check',
  'sessions_pkey', 'sessions_token_hash_key', 'sessions_user_id_fkey',
  'audit_log_pkey',
  'templates_pkey', 'templates_slug_key', 'templates_source_check',
  'stacks_pkey', 'stacks_status_check',
  'tunnels_pkey', 'tunnels_mode_check', 'tunnels_status_check',
  'settings_pkey',
];

const testEmail = `agent1-${crypto.randomBytes(6).toString('hex')}@dockyard.test`;

after(async () => {
  // Best-effort cleanup in case a test failed mid-way.
  try {
    await query('delete from users where email = $1', [testEmail]);
  } catch {
    /* ignore */
  }
  await closePool();
});

describe('migrations', () => {
  test('runMigrations applies cleanly and is idempotent', async () => {
    const first = await runMigrations();
    // Either it applied 001_init now, or a prior run already did.
    assert.ok(
      first.applied.includes('001_init') || first.already.includes('001_init'),
      `expected 001_init in ${JSON.stringify(first)}`,
    );

    const second = await runMigrations();
    assert.deepEqual(second.applied, [], 'second run must apply nothing');
    assert.ok(second.already.includes('001_init'), 'second run must report 001_init as already applied');

    const status = await migrationStatus();
    const init = status.find((s) => s.id === '001_init');
    assert.ok(init, 'migrationStatus must list 001_init');
    assert.ok(init!.applied_at, '001_init must have an applied_at timestamp');
  });

  test('all 7 tables exist', async () => {
    const rows = await many<{ table_name: string }>(
      `select table_name from information_schema.tables
       where table_schema = 'public' and table_type = 'BASE TABLE'`,
    );
    const names = new Set(rows.map((r) => r.table_name));
    for (const t of EXPECTED_TABLES) assert.ok(names.has(t), `missing table ${t}`);

    const migrationsTable = await one(`select to_regclass('public.schema_migrations') as t`);
    assert.ok(migrationsTable && (migrationsTable as any).t, 'schema_migrations table must exist');
  });

  test('each table has the contract columns', async () => {
    for (const [table, cols] of Object.entries(EXPECTED_COLUMNS)) {
      const rows = await many<{ column_name: string }>(
        `select column_name from information_schema.columns
         where table_schema = 'public' and table_name = $1`,
        [table],
      );
      const got = new Set(rows.map((r) => r.column_name));
      for (const c of cols) assert.ok(got.has(c), `${table} missing column ${c}`);
    }
  });

  test('key constraints and checks exist', async () => {
    const rows = await many<{ conname: string }>(
      `select conname from pg_constraint
       where connamespace = 'public'::regnamespace`,
    );
    const names = new Set(rows.map((r) => r.conname));
    for (const c of EXPECTED_CONSTRAINTS) assert.ok(names.has(c), `missing constraint ${c}`);
  });

  test('users.role check rejects an invalid role', async () => {
    await assert.rejects(
      () => query(`insert into users (email, password_hash, role) values ($1,$2,$3)`, ['x@bad.test', 'h', 'root']),
      /role/i,
    );
  });
});

describe('pool data access', () => {
  test('one() returns null when there are no rows', async () => {
    const row = await one('select 1 as x where false');
    assert.equal(row, null);
  });

  test('dbHealth reports the server version', async () => {
    const health = await dbHealth();
    assert.equal(health.ok, true);
    assert.match(String(health.serverVersion), /PostgreSQL/i);
  });

  test('insert / read / delete a user, JSONB round-trips', async () => {
    const inserted = await one<{ id: string; email: string; role: string; created_at: Date }>(
      `insert into users (email, password_hash, role) values ($1,$2,$3)
       returning id, email, role, created_at`,
      [testEmail, 'hash-not-a-real-password', 'admin'],
    );
    assert.ok(inserted, 'insert returned a row');
    assert.equal(inserted!.email, testEmail);
    assert.equal(inserted!.role, 'admin');
    assert.match(inserted!.id, /^[0-9a-f-]{36}$/);

    const found = await one<{ id: string }>('select id from users where email = $1', [testEmail]);
    assert.equal(found?.id, inserted!.id);

    // JSONB comes back as a JS object, not a string.
    const settingsRow = await one<{ value: Record<string, unknown> }>(
      `insert into settings (key, value) values ($1, $2::jsonb) returning value`,
      [`agent1.test.${testEmail}`, JSON.stringify({ nested: { n: 1 }, ok: true })],
    );
    assert.equal(typeof settingsRow!.value, 'object');
    assert.equal((settingsRow!.value as any).ok, true);
    assert.equal((settingsRow!.value as any).nested.n, 1);
    await query('delete from settings where key = $1', [`agent1.test.${testEmail}`]);

    const deleted = await query('delete from users where id = $1', [inserted!.id]);
    assert.equal(deleted.rowCount, 1);
    const gone = await one('select id from users where id = $1', [inserted!.id]);
    assert.equal(gone, null);
  });

  test('tx() rolls back on throw and always releases the client', async () => {
    const before = await pool.totalCount;
    await assert.rejects(
      () =>
        tx(async (client) => {
          await client.query(`insert into users (email, password_hash, role) values ($1,$2,$3)`, [
            `rollback-${testEmail}`,
            'h',
            'admin',
          ]);
          throw new Error('boom');
        }),
      /boom/,
    );
    const row = await one('select id from users where email = $1', [`rollback-${testEmail}`]);
    assert.equal(row, null, 'inserted row must have been rolled back');
    assert.ok(pool.totalCount <= before, 'client was released');
  });
});
