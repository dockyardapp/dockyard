// Dockyard — JSON-file template catalog tests (owner: agent 4).
//
// The feature under test is "add a template without rebuilding the image": the operator drops a
// `*.json` file into DOCKYARD_TEMPLATE_DIR and it appears. So the tests are mostly about the
// lifecycle of a file — added, edited, removed, colliding, malformed — rather than about a
// template's contents, which `templates.test.ts` already covers.
//
// Real Postgres, real app, real files. The directory is a temp one owned by this file, so a test
// never reads or writes the repo's own `data/templates`.
//
//   export PATH=/root/.hermes/node/bin:$PATH
//   DOCKYARD_LOGIN_RATE_MAX=1000 node --test server/test/template-files.test.ts

import test, { after, before } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import type { FastifyInstance, FastifyRequest } from 'fastify';

import { buildApp } from '../src/app.ts';
import { runMigrations } from '../src/db/migrate.ts';
import { closePool, one, query } from '../src/db/pool.ts';
import { hashPassword } from '../src/auth/password.ts';
import { createSession } from '../src/auth/sessions.ts';
import { config } from '../src/config.ts';
import type { TemplateSpec } from '../src/templates/schema.ts';
import {
  maybeResyncTemplateFiles,
  reloadTemplateFiles,
  resetTemplateFileCache,
  scanTemplateFiles,
  syncTemplateFiles,
  syncTemplateSource,
  templateFilesStatus,
} from '../src/templates/files.ts';

const RUN = randomBytes(4).toString('hex');
const PASSWORD = 'test-password-123';
/** Every slug this file creates carries the run id, so cleanup cannot touch anything else. */
const PREFIX = `tf${RUN}`;

let tmpDir: string;
let app: FastifyInstance;
const originalTemplateDir = config.templateDir;
const createdUserIds: string[] = [];

function slugFor(name: string): string {
  return `${PREFIX}-${name}`;
}

/** A minimal valid spec; the caller overrides what it cares about. */
function spec(name: string, extra: Partial<TemplateSpec> = {}): TemplateSpec {
  return {
    schemaVersion: 1,
    slug: slugFor(name),
    name: `Test ${name}`,
    category: 'devtools',
    icon: 'x',
    description: 'a test template',
    image: 'traefik/whoami',
    tag: 'v1.11.0',
    ports: [],
    env: [],
    volumes: [],
    restartPolicy: 'unless-stopped',
    ...extra,
  };
}

function writeFile(name: string, contents: unknown): void {
  fs.writeFileSync(path.join(tmpDir, name), typeof contents === 'string' ? contents : JSON.stringify(contents, null, 2));
}

function clearDir(): void {
  for (const name of fs.readdirSync(tmpDir)) fs.rmSync(path.join(tmpDir, name), { force: true });
}

async function cleanupSlugs(): Promise<void> {
  await query('delete from templates where slug like $1', [`${PREFIX}-%`]);
}

function cookieHeader(cookieValue: string): Record<string, string> {
  return { cookie: `dockyard_session=${cookieValue}` };
}

async function sessionFor(userId: string): Promise<string> {
  const { token } = await createSession(userId, {
    headers: {},
    ip: '127.0.0.1',
  } as unknown as FastifyRequest);
  return token;
}

async function insertUser(role: 'admin' | 'operator' | 'viewer'): Promise<string> {
  const email = `tf-${role}-${randomBytes(3).toString('hex')}-${RUN}@dockyard.test`;
  const row = await one<{ id: string }>(
    `insert into users (email, password_hash, role, scope_mode, can_exec)
     values ($1, $2, $3, 'all', false) returning id`,
    [email, await hashPassword(PASSWORD), role],
  );
  assert.ok(row?.id, `failed to create ${role} test user`);
  createdUserIds.push(row.id);
  return row.id;
}

let admin = '';
let operator = '';

before(async () => {
  await runMigrations();
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dockyard-templates-'));
  // The routes read `config.templateDir` through its default parameter, so pointing the config at
  // the temp directory is what makes the route-level tests exercise the real code path without
  // touching the repo's own data directory. Restored in after().
  config.templateDir = tmpDir;
  resetTemplateFileCache();
  app = await buildApp();
  admin = await sessionFor(await insertUser('admin'));
  operator = await sessionFor(await insertUser('operator'));
});

after(async () => {
  await cleanupSlugs();
  config.templateDir = originalTemplateDir;
  resetTemplateFileCache();
  for (const id of createdUserIds) {
    await query('delete from users where id = $1', [id]);
  }
  fs.rmSync(tmpDir, { recursive: true, force: true });
  await closePool();
});

// ---------------------------------------------------------------------------
// 1. Reading the directory
// ---------------------------------------------------------------------------

test('scanTemplateFiles: a single spec, an array and a pack all load', () => {
  clearDir();
  writeFile('one.json', spec('one'));
  writeFile('many.json', [spec('two'), spec('three')]);
  writeFile('pack.json', { templates: [spec('four'), spec('five')] });

  const scan = scanTemplateFiles(tmpDir);
  assert.equal(scan.exists, true);
  assert.deepEqual(
    scan.specs.map((s) => s.spec.slug).sort(),
    [slugFor('five'), slugFor('four'), slugFor('one'), slugFor('three'), slugFor('two')].sort(),
  );
  assert.deepEqual(scan.entries.filter((e) => e.errors.length > 0), []);
  // the file each spec came from is tracked, so an error can name it; a file holding several
  // templates indexes them
  assert.equal(scan.specs.find((s) => s.spec.slug === slugFor('three'))?.file, 'many.json[1]');
  assert.equal(scan.specs.find((s) => s.spec.slug === slugFor('five'))?.file, 'pack.json[1]');
  assert.equal(scan.specs.find((s) => s.spec.slug === slugFor('one'))?.file, 'one.json');
});

test('scanTemplateFiles: parked files and non-JSON files are ignored', () => {
  clearDir();
  writeFile('live.json', spec('live'));
  writeFile('_parked.json', spec('parked'));
  writeFile('.hidden.json', spec('hidden'));
  fs.writeFileSync(path.join(tmpDir, 'notes.txt'), 'not a template');

  const scan = scanTemplateFiles(tmpDir);
  assert.deepEqual(scan.specs.map((s) => s.spec.slug), [slugFor('live')]);
  assert.deepEqual(scan.parked, ['.hidden.json', '_parked.json']);
});

test('scanTemplateFiles: a missing directory is not an error', () => {
  const scan = scanTemplateFiles(path.join(tmpDir, 'does-not-exist'));
  assert.equal(scan.exists, false);
  assert.deepEqual(scan.specs, []);
  assert.deepEqual(scan.entries, []);
});

test('scanTemplateFiles: one bad file does not stop the good ones', () => {
  clearDir();
  writeFile('good.json', spec('good'));
  writeFile('broken.json', '{ this is not json');
  writeFile('wrong-shape.json', { slug: 'Bad Slug', name: '', category: 'nope', image: '', tag: '' });
  writeFile('empty-pack.json', { templates: [] });
  writeFile('not-an-array.json', { templates: 'nope' });

  const scan = scanTemplateFiles(tmpDir);
  assert.deepEqual(scan.specs.map((s) => s.spec.slug), [slugFor('good')]);

  const byFile = new Map(scan.entries.map((e) => [e.file, e.errors]));
  assert.match(byFile.get('broken.json')!.join(' '), /invalid JSON/);
  assert.ok(byFile.get('wrong-shape.json')!.length > 0, 'a malformed spec must be reported');
  assert.match(byFile.get('empty-pack.json')!.join(' '), /no templates/);
  assert.match(byFile.get('not-an-array.json')!.join(' '), /must be an array/);
  assert.deepEqual(byFile.get('good.json'), []);
});

test('scanTemplateFiles: a slug claimed by two files is reported, and the first file wins', () => {
  clearDir();
  writeFile('a.json', spec('dup', { name: 'From A' }));
  writeFile('b.json', spec('dup', { name: 'From B' }));

  const scan = scanTemplateFiles(tmpDir);
  assert.equal(scan.specs.length, 1);
  assert.equal(scan.specs[0].spec.name, 'From A');
  assert.match(scan.entries.find((e) => e.file === 'b.json')!.errors.join(' '), /already defined in a\.json/);
});

// ---------------------------------------------------------------------------
// 2. Reconciling with the table
// ---------------------------------------------------------------------------

test('syncTemplateFiles stores file templates with source=file, and is idempotent', async () => {
  clearDir();
  await cleanupSlugs();
  writeFile('redis-json.json', spec('cache', { name: 'Cache from a file' }));

  const first = await syncTemplateFiles(tmpDir);
  assert.equal(first.inserted, 1);
  assert.equal(first.updated, 0);
  assert.deepEqual(first.errors, []);

  const row = await one<{ name: string; source: string; spec: TemplateSpec }>(
    'select name, source, spec from templates where slug = $1',
    [slugFor('cache')],
  );
  assert.equal(row?.source, 'file');
  assert.equal(row?.name, 'Cache from a file');
  assert.equal(row?.spec.image, 'traefik/whoami');

  // running it again updates rather than duplicating
  const second = await syncTemplateFiles(tmpDir);
  assert.equal(second.inserted, 0);
  assert.equal(second.updated, 1);
  const count = await one<{ n: string }>('select count(*)::int as n from templates where slug = $1', [
    slugFor('cache'),
  ]);
  assert.equal(Number(count?.n), 1);
});

test('a file added later appears with no restart, and maybeResync notices it', async () => {
  clearDir();
  await cleanupSlugs();
  resetTemplateFileCache();

  // Prime the cache: with nothing remembered yet the first call always syncs, which is what makes
  // a restart pick the directory up. An empty directory has nothing to store.
  const primed = await maybeResyncTemplateFiles(tmpDir);
  assert.equal(primed?.templates, 0);
  assert.equal(await maybeResyncTemplateFiles(tmpDir), null);

  writeFile('late.json', spec('late', { name: 'Arrived late' }));
  const report = await maybeResyncTemplateFiles(tmpDir);
  assert.ok(report, 'the added file should have triggered a sync');
  assert.equal(report!.inserted, 1);

  const row = await one<{ source: string }>('select source from templates where slug = $1', [slugFor('late')]);
  assert.equal(row?.source, 'file');

  // and once synced, an unchanged directory costs nothing
  assert.equal(await maybeResyncTemplateFiles(tmpDir), null);

  // editing the file in place is noticed too (a directory's own mtime would not change)
  writeFile('late.json', spec('late', { name: 'Edited in place' }));
  const edited = await maybeResyncTemplateFiles(tmpDir);
  assert.ok(edited, 'editing a file should have triggered a sync');
  assert.equal(edited!.updated, 1);
  const renamed = await one<{ name: string }>('select name from templates where slug = $1', [slugFor('late')]);
  assert.equal(renamed?.name, 'Edited in place');
});

test('removing a file removes the template it defined', async () => {
  clearDir();
  await cleanupSlugs();
  resetTemplateFileCache();

  writeFile('temp.json', spec('temp'));
  await syncTemplateFiles(tmpDir);
  assert.ok(await one('select id from templates where slug = $1', [slugFor('temp')]));

  fs.rmSync(path.join(tmpDir, 'temp.json'));
  const report = await syncTemplateFiles(tmpDir);
  assert.deepEqual(report.removed, [slugFor('temp')]);
  assert.equal(await one('select id from templates where slug = $1', [slugFor('temp')]), null);
});

test('an empty directory removes every file template, but leaves repository and user rows alone', async () => {
  clearDir();
  await cleanupSlugs();
  writeFile('a.json', spec('a'));
  writeFile('b.json', spec('b'));
  await syncTemplateFiles(tmpDir);

  // One row the repository would own and one authored in the panel: neither is this source's to
  // delete, so an empty directory must not take them.
  const repoSpec = spec('repo', { name: 'From the repo' });
  const mineSpec = spec('mine', { name: 'Authored here' });
  await query(
    `insert into templates (slug, name, category, icon, description, spec, source)
     values ($1, $2, $3, $4, $5, $6::jsonb, 'remote'),
            ($7, $8, $9, $10, $11, $12::jsonb, 'user')`,
    [
      repoSpec.slug, repoSpec.name, repoSpec.category, repoSpec.icon, repoSpec.description, JSON.stringify(repoSpec),
      mineSpec.slug, mineSpec.name, mineSpec.category, mineSpec.icon, mineSpec.description, JSON.stringify(mineSpec),
    ],
  );

  const before = await one<{ n: string }>(
    "select count(*)::int as n from templates where slug like $1 and source in ('remote', 'user')",
    [`${PREFIX}-%`],
  );
  assert.equal(Number(before?.n), 2, 'expected both non-file rows to be in place');

  clearDir();
  const report = await syncTemplateFiles(tmpDir);
  assert.equal(report.removed.length, 2);

  const after = await one<{ n: string }>(
    "select count(*)::int as n from templates where slug like $1 and source in ('remote', 'user')",
    [`${PREFIX}-%`],
  );
  assert.equal(
    Number(after?.n),
    Number(before?.n),
    'repository and user rows must survive an empty directory',
  );
});

// ---------------------------------------------------------------------------
// 3. Precedence
// ---------------------------------------------------------------------------

test('a file overrides a repository template, and removing the file lets the repository copy back', async () => {
  clearDir();
  await cleanupSlugs();
  const slug = slugFor('over');

  // The repository's own copy of this slug, as a pull would have left it.
  const repoSpec = spec('over', { tag: 'repo-tag', name: 'From the repo' });
  await query(
    `insert into templates (slug, name, category, icon, description, spec, source)
     values ($1, $2, $3, $4, $5, $6::jsonb, 'remote')`,
    [
      slug,
      repoSpec.name,
      repoSpec.category,
      repoSpec.icon,
      repoSpec.description,
      JSON.stringify(repoSpec),
    ],
  );

  try {
    // a local file claims the same slug with a different tag
    writeFile('override.json', { ...repoSpec, tag: 'overridden-tag', name: 'Overridden from a file' });
    const report = await syncTemplateFiles(tmpDir);
    assert.deepEqual(report.overrides, [slug], 'the override should be reported');

    const row = await one<{ name: string; source: string; tag: string }>(
      'select name, source, spec->>$1 as tag from templates where slug = $2',
      ['tag', slug],
    );
    assert.equal(row?.source, 'file');
    assert.equal(row?.name, 'Overridden from a file');
    assert.equal(row?.tag, 'overridden-tag');

    // Removing the file removes the row. The repository's copy is what brings it back, on the
    // remote reconcile the route forces right after this one, so model that here: the repository
    // still holds the spec, and reconciling it restores the original.
    clearDir();
    const removed = await syncTemplateFiles(tmpDir);
    assert.deepEqual(removed.removed, [slug]);
    assert.equal(await one('select id from templates where slug = $1', [slug]), null);

    const remoteDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dockyard-remote-'));
    try {
      fs.writeFileSync(path.join(remoteDir, 'over.json'), JSON.stringify(repoSpec, null, 2));
      await syncTemplateSource(remoteDir, 'remote');

      const back = await one<{ source: string; tag: string }>(
        'select source, spec->>$1 as tag from templates where slug = $2',
        ['tag', slug],
      );
      assert.equal(back?.source, 'remote');
      assert.equal(back?.tag, 'repo-tag');
    } finally {
      fs.rmSync(remoteDir, { recursive: true, force: true });
    }
  } finally {
    clearDir();
    await cleanupSlugs();
  }
});

test('a file never clobbers a template authored in the panel', async () => {
  clearDir();
  await cleanupSlugs();
  const slug = slugFor('mine');
  await query(
    `insert into templates (slug, name, category, icon, description, spec, source)
     values ($1, 'Authored in the panel', 'other', 'x', 'mine', '{}'::jsonb, 'user')`,
    [slug],
  );

  writeFile('mine.json', spec('mine', { name: 'From a file' }));
  const report = await syncTemplateFiles(tmpDir);
  assert.deepEqual(report.skippedUser, [slug]);

  const row = await one<{ name: string; source: string }>('select name, source from templates where slug = $1', [slug]);
  assert.equal(row?.source, 'user');
  assert.equal(row?.name, 'Authored in the panel');
});

// ---------------------------------------------------------------------------
// 4. Diagnostics
// ---------------------------------------------------------------------------

test('two concurrent reads share one reconcile', async () => {
  clearDir();
  await cleanupSlugs();
  resetTemplateFileCache();
  writeFile('concurrent.json', spec('concurrent'));

  // A first page load fires the list and the files request together. Exactly one of them should do
  // the work, and the other must not return while the catalog is half applied.
  const [a, b] = await Promise.all([maybeResyncTemplateFiles(tmpDir), maybeResyncTemplateFiles(tmpDir)]);
  const reports = [a, b].filter((r): r is NonNullable<typeof r> => r !== null);
  assert.equal(reports.length, 1, 'exactly one of the two should have synced');
  assert.equal(reports[0].inserted, 1);

  const row = await one('select source from templates where slug = $1', [slugFor('concurrent')]);
  assert.equal(row?.source, 'file');
});

test('templateFilesStatus reports what is on disk and what the last sync did', async () => {
  clearDir();
  await cleanupSlugs();
  resetTemplateFileCache();
  writeFile('ok.json', spec('ok'));
  writeFile('bad.json', '{ broken');
  writeFile('_parked.json', spec('parked'));

  const report = await syncTemplateFiles(tmpDir);
  const status = templateFilesStatus(tmpDir);

  assert.equal(status.exists, true);
  assert.equal(status.dir, tmpDir);
  assert.deepEqual(status.parked, ['_parked.json']);
  assert.equal(status.errors.length, 1);
  assert.equal(status.errors[0].file, 'bad.json');
  assert.ok(status.entries.some((e) => e.file === 'ok.json' && e.templates.length === 1));
  assert.equal(report.errors.length, 1);
});

// ---------------------------------------------------------------------------
// 5. Over HTTP
// ---------------------------------------------------------------------------

test('the templates list carries a file template as source=file', async () => {
  clearDir();
  await cleanupSlugs();
  resetTemplateFileCache();
  writeFile('listed.json', spec('listed', { name: 'Listed from a file' }));

  const res = await app.inject({ method: 'GET', url: '/api/templates', headers: cookieHeader(admin) });
  assert.equal(res.statusCode, 200);
  const body = res.json() as Array<{ slug: string; name: string; source: string }>;
  const found = body.find((t) => t.slug === slugFor('listed'));
  assert.ok(found, 'the file template should be listed');
  assert.equal(found!.source, 'file');

  // the source filter works for the new value
  const filtered = await app.inject({
    method: 'GET',
    url: '/api/templates?source=file',
    headers: cookieHeader(admin),
  });
  const onlyFiles = filtered.json() as Array<{ source: string }>;
  assert.ok(onlyFiles.length >= 1);
  assert.ok(onlyFiles.every((t) => t.source === 'file'));
});

test('a template added to the directory shows up on the next request, with no restart', async () => {
  clearDir();
  await cleanupSlugs();
  resetTemplateFileCache();

  const before = await app.inject({ method: 'GET', url: '/api/templates', headers: cookieHeader(admin) });
  const countBefore = (before.json() as unknown[]).length;
  assert.ok(!(before.json() as Array<{ slug: string }>).some((t) => t.slug === slugFor('hot')));

  // the operator drops a file on the host; nothing else happens
  writeFile('hot.json', spec('hot', { name: 'Dropped in at runtime' }));

  const after = await app.inject({ method: 'GET', url: '/api/templates', headers: cookieHeader(admin) });
  const body = after.json() as Array<{ slug: string; source: string }>;
  assert.equal(body.length, countBefore + 1);
  const found = body.find((t) => t.slug === slugFor('hot'));
  assert.ok(found, 'the dropped file should be visible without a restart');
  assert.equal(found!.source, 'file');
});

test('GET /template-files describes the directory to a viewer', async () => {
  clearDir();
  resetTemplateFileCache();
  writeFile('seen.json', spec('seen'));
  writeFile('broken.json', 'nope');

  const res = await app.inject({ method: 'GET', url: '/api/template-files', headers: cookieHeader(admin) });
  assert.equal(res.statusCode, 200);
  const body = res.json() as { dir: string; exists: boolean; entries: unknown[]; errors: Array<{ file: string }> };
  assert.equal(body.dir, tmpDir);
  assert.equal(body.exists, true);
  assert.ok(body.entries.length >= 2);
  assert.ok(body.errors.some((e) => e.file === 'broken.json'));
});

test('a file template cannot be deleted through the API, and the refusal names the file', async () => {
  clearDir();
  await cleanupSlugs();
  resetTemplateFileCache();
  writeFile('undeletable.json', spec('undeletable'));
  await app.inject({ method: 'GET', url: '/api/templates', headers: cookieHeader(admin) });

  const res = await app.inject({
    method: 'DELETE',
    url: `/api/templates/${slugFor('undeletable')}`,
    headers: cookieHeader(admin),
  });
  assert.equal(res.statusCode, 409);
  assert.match((res.json() as { error: { message: string } }).error.message, /file on disk/);

  // it is still there
  const row = await one('select id from templates where slug = $1', [slugFor('undeletable')]);
  assert.ok(row);
});

test('reloading is an admin action', async () => {
  clearDir();
  await cleanupSlugs();
  resetTemplateFileCache();
  writeFile('reloaded.json', spec('reloaded'));

  const denied = await app.inject({
    method: 'POST',
    url: '/api/template-files/reload',
    headers: cookieHeader(operator),
  });
  assert.equal(denied.statusCode, 403);

  const allowed = await app.inject({
    method: 'POST',
    url: '/api/template-files/reload',
    headers: cookieHeader(admin),
  });
  assert.equal(allowed.statusCode, 200);
  const body = allowed.json() as { inserted: number; status: { entries: unknown[] } };
  assert.equal(body.inserted, 1);
  assert.ok(body.status.entries.length >= 1);

  // and the audit trail recorded it
  const audited = await one<{ action: string }>(
    "select action from audit_log where action = 'template.reload_files' order by created_at desc limit 1",
  );
  assert.ok(audited, 'the reload should be audited');
});

test('reloadTemplateFiles forces a scan even when nothing changed', async () => {
  clearDir();
  await cleanupSlugs();
  resetTemplateFileCache();
  writeFile('forced.json', spec('forced'));
  await maybeResyncTemplateFiles(tmpDir);
  assert.equal(await maybeResyncTemplateFiles(tmpDir), null, 'the stamp should now be current');

  const forced = await reloadTemplateFiles(tmpDir);
  assert.equal(forced.templates, 1);
});
