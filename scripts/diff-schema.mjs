#!/usr/bin/env node
// Dockyard — schema diff harness (scripts/diff-schema.mjs).
//
// Proves that a database freshly built from a directory of .sql migrations has
// exactly the same schema as an existing (reference) database.
//
//   node scripts/diff-schema.mjs                 # build from server/drizzle, compare to `dockyard`
//   node scripts/diff-schema.mjs --name dy_x     # use a different throwaway db name
//   node scripts/diff-schema.mjs --against app   # compare against a different reference db
//   node scripts/diff-schema.mjs --migrations dir
//   node scripts/diff-schema.mjs --keep          # keep the throwaway db for inspection
//
// Exit codes: 0 = schemas identical, 1 = schemas differ, 2 = harness/setup error.
//
// SAFETY: the reference database is READ ONLY. This script never writes to it.
// Only the throwaway database (--name) is created, written to, and dropped.
//
// The connection URL is read from .env and is NEVER printed; only host/port/db
// are shown, and never the user or password.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(HERE, '..');

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------
function parseArgs(argv) {
  const opts = {
    name: 'dy_schema_diff',
    against: 'dockyard',
    migrations: path.join(REPO_ROOT, 'server/drizzle'),
    env: path.join(REPO_ROOT, '.env'),
    keep: false,
    reuse: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const next = () => {
      const v = argv[++i];
      if (v === undefined) fail(`option ${a} needs a value`);
      return v;
    };
    if (a === '--name') opts.name = next();
    else if (a === '--against') opts.against = next();
    else if (a === '--migrations') opts.migrations = path.resolve(next());
    else if (a === '--env') opts.env = path.resolve(next());
    else if (a === '--keep') opts.keep = true;
    else if (a === '--reuse') opts.reuse = true;
    else if (a === '-h' || a === '--help') {
      process.stdout.write(
        'usage: node scripts/diff-schema.mjs [--name DB] [--against DB] [--migrations DIR] [--env FILE] [--keep] [--reuse]\n',
      );
      process.exit(0);
    } else fail(`unknown option ${a}`);
  }
  return opts;
}

function fail(msg) {
  process.stderr.write(`diff-schema: ${msg}\n`);
  process.exit(2);
}

// ---------------------------------------------------------------------------
// Connection
// ---------------------------------------------------------------------------
function readDatabaseUrl(envPath) {
  let text;
  try {
    text = fs.readFileSync(envPath, 'utf8');
  } catch {
    fail(`cannot read env file ${envPath}`);
  }
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.replace(/^\s*export\s+/, '');
    const m = line.match(/^\s*DATABASE_URL\s*=\s*(.*?)\s*$/);
    if (m) {
      let v = m[1];
      if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) {
        v = v.slice(1, -1);
      }
      if (v.length > 0) return v;
    }
  }
  fail(`DATABASE_URL not found in ${envPath}`);
}

/** Non-sensitive one-line description of a connection target. */
function describeUrl(url) {
  const u = new URL(url);
  return `db=${u.pathname.replace(/^\//, '')} host=${u.hostname} port=${u.port || '5432'}`;
}

/** A maintenance URL on the same server, pointed at the `postgres` database. */
function maintenanceUrl(dbUrl) {
  const u = new URL(dbUrl);
  u.pathname = '/postgres';
  return u.toString();
}

// Identifier safety: a database name we are willing to CREATE/DROP.
const SAFE_DB = /^[A-Za-z_][A-Za-z0-9_]*$/;

// ---------------------------------------------------------------------------
// Statement splitting
//
// Each migration file may hold many statements. We split on top-level
// semicolons, correctly skipping over line comments, block comments, single-
// quoted strings, double-quoted identifiers, and dollar-quoted bodies ($tag$...$tag$).
// The current migrations are functions-free DDL, but handling dollar-quoting
// means a future `create function ... $$ ... $$` file still applies cleanly.
// ---------------------------------------------------------------------------
function splitStatements(sql) {
  const out = [];
  let buf = '';
  let i = 0;
  const n = sql.length;
  while (i < n) {
    const ch = sql[i];
    const two = sql.slice(i, i + 2);
    if (two === '--') {
      const nl = sql.indexOf('\n', i);
      const end = nl === -1 ? n : nl + 1;
      buf += sql.slice(i, end);
      i = end;
      continue;
    }
    if (two === '/*') {
      const close = sql.indexOf('*/', i + 2);
      const end = close === -1 ? n : close + 2;
      buf += sql.slice(i, end);
      i = end;
      continue;
    }
    if (ch === "'") {
      let j = i + 1;
      while (j < n) {
        if (sql[j] === "'") {
          if (sql[j + 1] === "'") { j += 2; continue; }
          j++;
          break;
        }
        j++;
      }
      buf += sql.slice(i, j);
      i = j;
      continue;
    }
    if (ch === '"') {
      let j = i + 1;
      while (j < n) {
        if (sql[j] === '"') {
          if (sql[j + 1] === '"') { j += 2; continue; }
          j++;
          break;
        }
        j++;
      }
      buf += sql.slice(i, j);
      i = j;
      continue;
    }
    if (ch === '$') {
      const m = /^\$[A-Za-z0-9_]*\$/.exec(sql.slice(i));
      if (m) {
        const tag = m[0];
        const close = sql.indexOf(tag, i + tag.length);
        const end = close === -1 ? n : close + tag.length;
        buf += sql.slice(i, end);
        i = end;
        continue;
      }
    }
    if (ch === ';') {
      out.push(buf);
      buf = '';
      i++;
      continue;
    }
    buf += ch;
    i++;
  }
  if (buf.trim()) out.push(buf);
  return out.map((s) => s.trim()).filter((s) => s.length > 0);
}

// ---------------------------------------------------------------------------
// Applying migrations to the throwaway database
// ---------------------------------------------------------------------------
async function applyMigrations(client, dir) {
  let files;
  try {
    files = fs.readdirSync(dir).filter((f) => f.toLowerCase().endsWith('.sql'));
  } catch (err) {
    fail(`cannot read migrations dir ${dir}: ${err.message}`);
  }
  if (files.length === 0) fail(`no .sql files in ${dir}`);
  files.sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));

  const applied = [];
  for (const file of files) {
    const sql = fs.readFileSync(path.join(dir, file), 'utf8');
    const statements = splitStatements(sql);
    if (statements.length === 0) {
      applied.push({ file, statements: 0 });
      continue;
    }
    const c = await client.connect();
    try {
      await c.query('begin');
      for (let s = 0; s < statements.length; s++) {
        try {
          await c.query(statements[s]);
        } catch (err) {
          // Report the first error loudly: file, statement index, offending SQL head.
          const head = statements[s].replace(/\s+/g, ' ').slice(0, 200);
          throw new Error(
            `${file}: statement ${s + 1}/${statements.length} failed: ${err.message}\n  SQL: ${head}`,
          );
        }
      }
      await c.query('commit');
    } catch (err) {
      try { await c.query('rollback'); } catch { /* connection may be broken */ }
      c.release();
      throw new Error(`migration ${file} failed: ${err.message}`);
    }
    c.release();
    applied.push({ file, statements: statements.length });
  }
  return applied;
}

// ---------------------------------------------------------------------------
// Schema extraction
// ---------------------------------------------------------------------------

// --- Explicit allowlist of things NOT compared. Keep this list short, obvious
// --- and commented: anything not listed here IS compared.
const IGNORED_TABLES = new Set([
  'schema_migrations', // bookkeeping of the hand-written runner Drizzle replaced; existing databases still carry it
]);
const IGNORED_TABLE_SUBSTRINGS = [
  'drizzle', // drizzle-kit journal tables (e.g. __drizzle_migrations, drizzle.__drizzle_migrations)
];
const IGNORED_SCHEMA_PREFIXES = ['pg_stat', 'pg_toast', 'pg_temp'];
const IGNORED_SCHEMAS = new Set(['information_schema', 'pg_catalog', 'pg_toast']);

function tableIsIgnored(name) {
  if (IGNORED_TABLES.has(name)) return true;
  const lower = name.toLowerCase();
  return IGNORED_TABLE_SUBSTRINGS.some((s) => lower.includes(s));
}

function schemaIsIgnored(schema) {
  if (IGNORED_SCHEMAS.has(schema)) return true;
  return IGNORED_SCHEMA_PREFIXES.some((p) => schema.startsWith(p));
}

const CONTYPE = { c: 'check', f: 'foreign key', p: 'primary key', u: 'unique', t: 'trigger', x: 'exclusion' };

function collapse(s) {
  return s == null ? null : String(s).replace(/\s+/g, ' ').trim();
}

// Normalise a column default so cosmetic, environment-dependent spellings compare equal:
//   CURRENT_TIMESTAMP  <->  now()
//   '{}'::jsonb        ->   '{}'      (strip cast noise)
function normDefault(d) {
  if (d == null) return null;
  let s = collapse(d);
  s = s.replace(/\bCURRENT_TIMESTAMP\b/gi, 'now()');
  s = s.replace(/::[A-Za-z_][A-Za-z0-9_]*(?:\(\d+(?:,\s*\d+)?\))?(?:\[\])?/g, '');
  return collapse(s);
}

// A readable column type, e.g. `character varying(10)`, `numeric(10,2)`, `text`.
function colType(row) {
  let t = row.data_type;
  if (row.character_maximum_length != null) t += `(${row.character_maximum_length})`;
  else if (row.numeric_precision != null && (row.data_type === 'numeric' || row.data_type === 'decimal')) {
    t += `(${row.numeric_precision},${row.numeric_scale ?? 0})`;
  }
  return t;
}

async function extractSchema(client) {
  const s = {
    extensions: new Map(),
    sequences: new Map(),
    tables: new Map(),
    columns: new Map(),
    constraints: new Map(),
    indexes: new Map(),
    pkIndexNames: new Set(),
  };

  const q = (text) => client.query(text);

  // Extensions actually used by the schema. plpgsql ships with every database,
  // so it carries no signal; everything else (pgcrypto here) is compared.
  for (const r of (await q(
    `select extname, extversion from pg_extension where extname <> 'plpgsql' order by extname`,
  )).rows) {
    s.extensions.set(r.extname, { version: r.extversion });
  }

  for (const r of (await q(
    `select sequence_name, data_type from information_schema.sequences
      where sequence_schema = 'public' order by sequence_name`,
  )).rows) {
    if (tableIsIgnored(r.sequence_name)) continue;
    s.sequences.set(r.sequence_name, { type: r.data_type });
  }

  for (const r of (await q(
    `select table_name, table_type from information_schema.tables
      where table_schema = 'public' order by table_name`,
  )).rows) {
    if (tableIsIgnored(r.table_name)) continue;
    s.tables.set(r.table_name, { type: r.table_type });
  }

  for (const r of (await q(
    `select table_name, column_name, data_type, udt_name, is_nullable, column_default,
            character_maximum_length, numeric_precision, numeric_scale
       from information_schema.columns
      where table_schema = 'public'
      order by table_name, column_name`,
  )).rows) {
    if (tableIsIgnored(r.table_name)) continue;
    s.columns.set(`${r.table_name}.${r.column_name}`, {
      type: colType(r),
      udt: r.udt_name,
      nullable: r.is_nullable,
      default: normDefault(r.column_default),
    });
  }

  for (const r of (await q(
    `select c.relname as tbl, con.conname as name, con.contype as contype,
            pg_get_constraintdef(con.oid) as def
       from pg_constraint con
       join pg_class c on c.oid = con.conrelid
       join pg_namespace n on n.oid = c.relnamespace
      where n.nspname = 'public'
      order by c.relname, con.conname`,
  )).rows) {
    if (tableIsIgnored(r.tbl)) continue;
    s.constraints.set(`${r.tbl}.${r.name}`, {
      type: CONTYPE[r.contype] ?? r.contype,
      def: collapse(r.def),
    });
  }

  // Primary-key-backing indexes, used for the "exclude only if both sides agree" rule.
  for (const r of (await q(
    `select c.relname as tbl, ci.relname as idx
       from pg_constraint con
       join pg_class ci on ci.oid = con.conindid
       join pg_class c on c.oid = con.conrelid
       join pg_namespace n on n.oid = c.relnamespace
      where n.nspname = 'public' and con.contype = 'p'`,
  )).rows) {
    if (tableIsIgnored(r.tbl)) continue;
    s.pkIndexNames.add(r.idx);
  }

  for (const r of (await q(
    `select tablename, indexname, indexdef from pg_indexes
      where schemaname = 'public' order by tablename, indexname`,
  )).rows) {
    if (tableIsIgnored(r.tablename)) continue;
    s.indexes.set(`${r.tablename}.${r.indexname}`, { def: collapse(r.indexdef) });
  }

  return s;
}

// ---------------------------------------------------------------------------
// Diffing
// ---------------------------------------------------------------------------
const KINDS = ['extensions', 'sequences', 'tables', 'columns', 'constraints', 'indexes'];
const FIELD_ORDER = {
  extensions: ['version'],
  sequences: ['type'],
  tables: ['type'],
  columns: ['type', 'udt', 'nullable', 'default'],
  constraints: ['type', 'def'],
  indexes: ['def'],
};

function diffSchemas(ref, neu, refDb, newDb) {
  const notes = [];
  const lines = []; // { kind, sortKey, text }
  let differences = 0;

  // Decide whether to exclude primary-key-backing indexes: only when the two
  // sides agree on exactly which indexes those are.
  const pkEqual =
    ref.pkIndexNames.size === neu.pkIndexNames.size &&
    [...ref.pkIndexNames].every((n) => neu.pkIndexNames.has(n));
  const excludePk = pkEqual && ref.pkIndexNames.size > 0;
  if (excludePk) {
    notes.push(
      `excluding ${ref.pkIndexNames.size} primary-key-backing index(es) (identical on both sides): ` +
        [...ref.pkIndexNames].sort().join(', '),
    );
  } else if (ref.pkIndexNames.size > 0 || neu.pkIndexNames.size > 0) {
    notes.push(
      'primary-key-backing indexes differ between the two sides; including ALL indexes in the comparison',
    );
  }

  for (const kind of KINDS) {
    const a = ref[kind];
    const b = neu[kind];
    const keys = new Set([...a.keys(), ...b.keys()]);
    for (const key of keys) {
      // Index PK-exclusion.
      if (kind === 'indexes' && excludePk) {
        const idxName = key.slice(key.indexOf('.') + 1);
        if (ref.pkIndexNames.has(idxName)) continue;
      }
      const av = a.get(key);
      const bv = b.get(key);
      if (av && !bv) {
        differences++;
        lines.push({ kind, key, text: `- ${kind}.${refDb}.${key}: only in ${refDb}` });
      } else if (!av && bv) {
        differences++;
        lines.push({ kind, key, text: `+ ${kind}.${newDb}.${key}: only in ${newDb}` });
      } else {
        for (const field of FIELD_ORDER[kind]) {
          const x = av[field] ?? null;
          const y = bv[field] ?? null;
          if (x !== y) {
            differences++;
            lines.push({
              kind,
              key,
              text: `${kind}.${refDb}.${key}: ${field} ${x} vs ${y}`,
            });
          }
        }
      }
    }
  }

  // Deterministic order: kind first (in KINDS order), then object key, then line text.
  const kindRank = new Map(KINDS.map((k, i) => [k, i]));
  lines.sort((l, r) => {
    if (l.kind !== r.kind) return kindRank.get(l.kind) - kindRank.get(r.kind);
    if (l.key !== r.key) return l.key < r.key ? -1 : 1;
    return l.text < r.text ? -1 : l.text > r.text ? 1 : 0;
  });

  return { differences, lines, notes };
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------
async function main() {
  const opts = parseArgs(process.argv.slice(2));

  if (!SAFE_DB.test(opts.name)) fail(`--name "${opts.name}" is not a safe database name`);
  if (!SAFE_DB.test(opts.against)) fail(`--against "${opts.against}" is not a safe database name`);
  if (opts.name === opts.against) fail('--name and --against must differ');
  if (['postgres', 'template0', 'template1'].includes(opts.name)) {
    fail(`refusing to use the reserved database name "${opts.name}" as the throwaway`);
  }

  const dbUrl = readDatabaseUrl(opts.env);
  const maintUrl = maintenanceUrl(dbUrl);

  const refDesc = describeUrl(new URL(dbUrl));
  process.stdout.write(`== dockyard schema diff ==\n`);
  process.stdout.write(`REF (reference, read-only) = ${opts.against} (${refDesc})\n`);
  process.stdout.write(`NEW (freshly built)         = ${opts.name}\n`);
  process.stdout.write(`migrations dir              = ${path.relative(REPO_ROOT, opts.migrations) || opts.migrations}\n`);
  process.stdout.write(
    `legend: a differing line reads  <kind>.<db>.<object>: <field> <REF-value> vs <NEW-value>\n\n`,
  );

  // 1. Recreate the throwaway database (unless --reuse).
  const admin = new pg.Client({ connectionString: maintUrl });
  await admin.connect();
  const createdByUs = !opts.reuse;
  if (createdByUs) {
    try {
      try {
        await admin.query(`drop database if exists "${opts.name}" with (force)`);
      } catch {
        // Pre-PG13 has no WITH (FORCE); plain DROP (fails if sessions linger).
        await admin.query(`drop database if exists "${opts.name}"`);
      }
      await admin.query(`create database "${opts.name}"`);
      process.stdout.write(`created throwaway database "${opts.name}"\n`);
    } catch (err) {
      const msg = err?.message ?? String(err);
      if (/permission denied to create database/i.test(msg)) {
        fail(
          `could not (re)create database "${opts.name}": ${msg}\n` +
            `  the DATABASE_URL role needs the CREATEDB attribute; as a superuser run:\n` +
            `    ALTER ROLE <role> CREATEDB;   -- e.g. ALTER ROLE dockyard CREATEDB;`,
        );
      }
      fail(`could not (re)create database "${opts.name}": ${msg}`);
    }
  } else {
    const exists = (
      await admin.query(`select 1 from pg_database where datname = $1`, [opts.name])
    ).rows.length > 0;
    if (!exists) fail(`--reuse: database "${opts.name}" does not exist (build it first)`);
    process.stdout.write(`reusing existing database "${opts.name}" (--reuse: not rebuilt)\n`);
  }

  let dropped = false;
  const dropThrowaway = async () => {
    if (!createdByUs) return; // never drop a database we did not create
    if (opts.keep || dropped) return;
    try {
      await admin.query(`drop database if exists "${opts.name}" with (force)`);
    } catch {
      try { await admin.query(`drop database if exists "${opts.name}"`); } catch { /* best effort */ }
    }
    dropped = true;
  };

  let exitCode = 0;
  try {
    // 2. Apply migrations to the throwaway (skipped with --reuse).
    if (createdByUs) {
      const newPool = new pg.Pool({ connectionString: new URL('/' + opts.name, dbUrl).toString(), max: 4 });
      let applied;
      try {
        applied = await applyMigrations(newPool, opts.migrations);
      } catch (err) {
        await newPool.end().catch(() => {});
        fail(`applying migrations failed:\n${err.message}`);
      }
      await newPool.end();
      const totalStmts = applied.reduce((n, f) => n + f.statements, 0);
      process.stdout.write(
        `applied ${applied.length} file(s), ${totalStmts} statement(s): ${applied.map((f) => f.file).join(', ')}\n\n`,
      );
    } else {
      process.stdout.write(`(migrations not applied: comparing the reused database as-is)\n\n`);
    }

    // 3. Extract both schemas.
    const newClient = new pg.Client({ connectionString: new URL('/' + opts.name, dbUrl).toString() });
    await newClient.connect();
    let newSchema;
    try {
      newSchema = await extractSchema(newClient);
    } finally {
      await newClient.end().catch(() => {});
    }

    const refClient = new pg.Client({ connectionString: dbUrl });
    await refClient.connect();
    let refSchema;
    try {
      refSchema = await extractSchema(refClient);
    } finally {
      await refClient.end().catch(() => {});
    }

    // 4. Diff.
    const { differences, lines, notes } = diffSchemas(refSchema, newSchema, opts.against, opts.name);

    for (const note of notes) process.stdout.write(`note: ${note}\n`);
    if (notes.length) process.stdout.write('\n');

    if (differences === 0) {
      process.stdout.write('no differences found\n\n');
      process.stdout.write(
        `RESULT: schemas are IDENTICAL (${opts.name} == ${opts.against}) — exit 0\n`,
      );
    } else {
      process.stdout.write(`found ${differences} difference(s):\n\n`);
      for (const l of lines) process.stdout.write(l.text + '\n');
      process.stdout.write(
        `\nRESULT: schemas DIFFER (${differences} difference(s)) — exit 1\n`,
      );
      exitCode = 1;
    }
  } finally {
    // 6. Drop the throwaway unless --keep.
    await dropThrowaway();
    if (!opts.keep && dropped) process.stdout.write(`dropped throwaway database "${opts.name}"\n`);
    else if (opts.keep) process.stdout.write(`kept throwaway database "${opts.name}" (--keep)\n`);
    await admin.end().catch(() => {});
  }

  process.exit(exitCode);
}

main().catch((err) => {
  process.stderr.write(`diff-schema: unexpected error: ${err?.stack ?? err}\n`);
  process.exit(2);
});
