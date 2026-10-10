// Dockyard — migrations runner (owner: agent 1).
//
// Drizzle owns the schema now. `schema.ts` is the definition, `drizzle/` holds the SQL drizzle-kit
// generated from it together with Drizzle's own journal, and this module is the single entry point
// the app boots through:
//
//   loadEnvFile() -> runMigrations() -> ensureFirstBootAdmin() -> buildApp() -> listen()
//
// It deliberately keeps the shape its callers already use (`runMigrations`, `migrationStatus`), so
// switching the engine underneath changed no call site.
//
// Three things about Drizzle's migrator are worth knowing, because each one bit while doing this:
//
//   * It reports nothing. `migrate()` resolves with `void`, so `applied` / `already` are worked out
//     by diffing the journal against Drizzle's bookkeeping table before and after the run.
//   * It records a migration by its `when` stamp (the journal entry's `when`, stored in the table's
//     `created_at`), not by name. That stamp is the join key between the two.
//   * It runs every migration it has not recorded. A database that predates Drizzle has no journal
//     table at all, so the first run applies the squashed migration to a schema that already has
//     every table. That is why the generated SQL is written with IF NOT EXISTS throughout: being a
//     no-op there is the expected outcome, not a failure.
//
// Runnable as a CLI: `node server/src/db/migrate.ts` — and importable.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { drizzle } from 'drizzle-orm/node-postgres';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import { pool, closePool } from './pool.ts';
import * as schema from './schema.ts';

const moduleDir = path.dirname(fileURLToPath(import.meta.url));

/** Where drizzle-kit writes and Drizzle's migrator reads: `<repo>/server/drizzle`. */
export const migrationsDir = path.resolve(moduleDir, '..', '..', 'drizzle');

// Drizzle's bookkeeping lives in a schema of its own, so it can never collide with the app's tables.
const JOURNAL_SCHEMA = 'drizzle';
const JOURNAL_TABLE = '__drizzle_migrations';

export type MigrationEntry = { idx: number; when: number; tag: string; breakpoints?: boolean };

/** The migrations this build knows about, in the order Drizzle will apply them. */
function readJournal(): MigrationEntry[] {
  const journalPath = path.join(migrationsDir, 'meta', '_journal.json');
  if (!fs.existsSync(journalPath)) {
    throw new Error(
      `no migration journal at ${journalPath}. The deployment has to carry server/drizzle/; ` +
        `run "npx drizzle-kit generate" in server/ if the schema changed.`,
    );
  }
  const journal = JSON.parse(fs.readFileSync(journalPath, 'utf8')) as { entries?: MigrationEntry[] };
  return (journal.entries ?? []).slice().sort((a, b) => a.idx - b.idx);
}

/**
 * The `when` stamps Drizzle has already recorded. An absent schema or table means nothing has run on
 * this database yet, which is the normal state of a fresh install and of a pre-Drizzle one.
 */
async function recordedStamps(): Promise<Set<number>> {
  try {
    const rows = await pool.query<{ created_at: string | number }>(
      `select created_at from ${JOURNAL_SCHEMA}.${JOURNAL_TABLE}`,
    );
    return new Set(rows.rows.map((r) => Number(r.created_at)));
  } catch {
    // 3F000 invalid_schema_name / 42P01 undefined_table: Drizzle has never run here.
    return new Set();
  }
}

export async function runMigrations(): Promise<{ applied: string[]; already: string[] }> {
  const entries = readJournal();
  const before = await recordedStamps();

  // Passing the schema is what makes a broken schema.ts fail at boot rather than at first use.
  const db = drizzle(pool, { schema });
  await migrate(db, { migrationsFolder: migrationsDir });

  const after = await recordedStamps();

  const applied: string[] = [];
  const already: string[] = [];
  for (const entry of entries) {
    if (before.has(entry.when)) already.push(entry.tag);
    else if (after.has(entry.when)) applied.push(entry.tag);
  }

  return { applied, already };
}

/**
 * What has run, in the order the journal lists it.
 *
 * `applied_at` is the migration's OWN timestamp, not the moment it was applied: Drizzle records the
 * journal entry's `when` (the millisecond the migration was generated) and keeps no column for when
 * it actually ran, so the true application time is not recoverable from its bookkeeping. For the
 * baseline that means the value is the moment the schema was squashed, which for a fresh install is
 * close to but not the same as first boot. Nothing in the app consumes this yet; if something ever
 * does, label it as the migration's date rather than the database's.
 */
export async function migrationStatus(): Promise<Array<{ id: string; applied_at: string | null }>> {
  const entries = readJournal();

  const stamps = new Map<number, string>();
  try {
    const rows = await pool.query<{ created_at: string | number }>(
      `select created_at from ${JOURNAL_SCHEMA}.${JOURNAL_TABLE}`,
    );
    for (const row of rows.rows) {
      const ms = Number(row.created_at);
      stamps.set(ms, new Date(ms).toISOString());
    }
  } catch {
    /* nothing has run yet */
  }

  const out: Array<{ id: string; applied_at: string | null }> = [];
  const seen = new Set<number>();
  for (const entry of entries) {
    seen.add(entry.when);
    out.push({ id: entry.tag, applied_at: stamps.get(entry.when) ?? null });
  }
  // A recorded stamp with no journal entry means history was rewritten: the migration ran, but this
  // build no longer has it. Reported rather than hidden, because that is drift worth seeing.
  for (const [ms, at] of stamps) {
    if (!seen.has(ms)) out.push({ id: `(not in this build: ${ms})`, applied_at: at });
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
