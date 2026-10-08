// Dockyard — migrations runner (owner: agent 1).
//
// Creates `schema_migrations` itself, then applies migrations/NNN_*.sql in filename order,
// one transaction per migration, recording id = filename without extension.
// Runnable as a CLI: `node server/src/db/migrate.ts` — and importable.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { pool, closePool } from './pool.ts';

const moduleDir = path.dirname(fileURLToPath(import.meta.url));
export const migrationsDir = path.join(moduleDir, 'migrations');

const MIGRATION_RE = /^(\d+)[-_].+\.sql$/;

function listMigrationFiles(): string[] {
  let entries: string[];
  try {
    entries = fs.readdirSync(migrationsDir);
  } catch {
    return [];
  }
  return entries
    .filter((f) => MIGRATION_RE.test(f))
    .sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
}

function idOf(filename: string): string {
  return filename.replace(/\.sql$/i, '');
}

async function ensureMigrationsTable(): Promise<void> {
  await pool.query(
    `create table if not exists schema_migrations (
       id text primary key,
       applied_at timestamptz not null default now()
     )`,
  );
}

export async function runMigrations(): Promise<{ applied: string[]; already: string[] }> {
  await ensureMigrationsTable();

  const files = listMigrationFiles();
  const rows = await pool.query<{ id: string }>('select id from schema_migrations');
  const recorded = new Set(rows.rows.map((r) => r.id));

  const applied: string[] = [];
  const already: string[] = [];

  for (const file of files) {
    const id = idOf(file);
    if (recorded.has(id)) {
      already.push(id);
      continue;
    }
    const sql = fs.readFileSync(path.join(migrationsDir, file), 'utf8');
    const client = await pool.connect();
    try {
      await client.query('begin');
      await client.query(sql);
      await client.query('insert into schema_migrations (id) values ($1)', [id]);
      await client.query('commit');
      applied.push(id);
    } catch (err) {
      try {
        await client.query('rollback');
      } catch {
        /* ignore */
      }
      client.release();
      throw new Error(
        `migration ${file} failed: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
    client.release();
  }

  return { applied, already };
}

export async function migrationStatus(): Promise<Array<{ id: string; applied_at: string | null }>> {
  await ensureMigrationsTable();
  const rows = await pool.query<{ id: string; applied_at: Date }>(
    'select id, applied_at from schema_migrations',
  );
  const byId = new Map(rows.rows.map((r) => [r.id, r.applied_at]));

  const out: Array<{ id: string; applied_at: string | null }> = [];
  const seen = new Set<string>();
  for (const file of listMigrationFiles()) {
    const id = idOf(file);
    seen.add(id);
    const at = byId.get(id);
    out.push({ id, applied_at: at ? new Date(at).toISOString() : null });
  }
  // Any recorded migration whose file is gone is still reported.
  for (const [id, at] of byId) {
    if (!seen.has(id)) out.push({ id, applied_at: new Date(at).toISOString() });
  }
  return out;
}

async function main(): Promise<void> {
  const { applied, already } = await runMigrations();
  const status = await migrationStatus();
  process.stdout.write(
    JSON.stringify({ ok: true, applied, already, migrations: status }, null, 2) + '\n',
  );
  await closePool();
}

const invokedDirectly =
  process.argv[1] !== undefined &&
  import.meta.url === pathToFileURL(process.argv[1]).href;

if (invokedDirectly) {
  main().catch(async (err) => {
    process.stderr.write(
      JSON.stringify({ ok: false, error: err instanceof Error ? err.message : String(err) }) + '\n',
    );
    try {
      await closePool();
    } catch {
      /* ignore */
    }
    process.exitCode = 1;
  });
}
