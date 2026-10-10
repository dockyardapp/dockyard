// Dockyard — database + migration tests (owner: agent 1).
//
// Runs the migrations against the real local Postgres, asserts the resulting schema, then
// inserts/reads/deletes a row and cleans up. Leaves the schema intact for the other agents.

import { test, describe, after } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { runMigrations, migrationStatus } from '../src/db/migrate.ts';
import { pool, query, one, many, tx, closePool, dbHealth } from '../src/db/pool.ts';

const EXPECTED_TABLES = [
  'users', 'sessions', 'audit_log', 'templates', 'stacks', 'tunnels', 'settings', 'user_grants',
];

const EXPECTED_COLUMNS: Record<string, string[]> = {
  users: ['id', 'email', 'password_hash', 'role', 'created_at', 'last_login_at', 'scope_mode', 'can_exec'],
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
  user_grants: [
    'id', 'user_id', 'resource_kind', 'resource_id', 'label_key', 'label_value', 'created_by', 'created_at',
  ],
};

// The names Postgres actually assigned, read off a live database rather than guessed. Some are load
// bearing beyond their own definition: the legacy migrations dropped `templates_source_check` and
// `tunnels_mode_check` *by name*, so a squash that renamed them would silently change behaviour.
const EXPECTED_CONSTRAINTS = [
  'users_pkey', 'users_email_key', 'users_role_check', 'users_scope_mode_check',
  'sessions_pkey', 'sessions_token_hash_key', 'sessions_user_id_fkey',
  'audit_log_pkey', 'audit_log_user_id_fkey',
  'templates_pkey', 'templates_slug_key', 'templates_source_check',
  'stacks_pkey', 'stacks_source_check', 'stacks_status_check', 'stacks_created_by_fkey',
  'tunnels_pkey', 'tunnels_mode_check', 'tunnels_status_check', 'tunnels_created_by_fkey',
  'settings_pkey',
  'user_grants_pkey', 'user_grants_user_id_fkey', 'user_grants_created_by_fkey',
  'user_grants_resource_kind_check', 'user_grants_selector', 'user_grants_label_nonempty',
];

// Indexes are half of what a squashed migration can lose: a table can come back byte-identical while
// the index that made a hot query cheap is gone, and nothing else in this suite would notice.
const EXPECTED_INDEXES = [
  'sessions_user_id_idx', 'sessions_expires_at_idx', 'audit_log_created_at_idx',
  'templates_source_idx', 'stacks_slug_idx', 'user_grants_user_id_idx', 'user_grants_unique_idx',
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
    // Which migrations exist is drizzle-kit's business, so this asserts the contract rather than a
    // filename: whatever the build ships is applied exactly once and reported as already applied on
    // every run after that. Hardcoding a tag would only test that nobody renamed a file.
    const listed = await migrationStatus();
    const tags = listed.filter((s) => !s.id.startsWith('(not in this build')).map((s) => s.id);
    assert.ok(tags.length > 0, 'the build must ship at least one migration');

    const first = await runMigrations();
    for (const tag of tags) {
      assert.ok(
        first.applied.includes(tag) || first.already.includes(tag),
        `expected ${tag} in ${JSON.stringify(first)}`,
      );
    }

    const second = await runMigrations();
    assert.deepEqual(second.applied, [], 'second run must apply nothing');
    assert.deepEqual(
      second.already,
      tags,
      'second run must report every migration as already applied',
    );

    const status = await migrationStatus();
    for (const row of status) {
      assert.ok(row.applied_at, `${row.id} must have an applied_at timestamp`);
    }
  });

  test('all 8 tables exist', async () => {
    const rows = await many<{ table_name: string }>(
      `select table_name from information_schema.tables
       where table_schema = 'public' and table_type = 'BASE TABLE'`,
    );
    const names = new Set(rows.map((r) => r.table_name));
    for (const t of EXPECTED_TABLES) assert.ok(names.has(t), `missing table ${t}`);

    // Drizzle keeps its own bookkeeping, in a schema of its own so it cannot collide with the app's.
    const journalTable = await one(`select to_regclass('drizzle.__drizzle_migrations') as t`);
    assert.ok(journalTable && (journalTable as any).t, "drizzle's journal table must exist");
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

  test('the indexes that make the hot queries cheap exist', async () => {
    const rows = await many<{ indexname: string }>(
      `select indexname from pg_indexes where schemaname = 'public'`,
    );
    const names = new Set(rows.map((r) => r.indexname));
    for (const i of EXPECTED_INDEXES) assert.ok(names.has(i), `missing index ${i}`);
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
