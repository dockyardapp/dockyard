// Dockyard — templates pulled from a repository (owner: agent 4).
//
// The feature under test is "push a template to the repository and every install gets it". That
// makes the interesting cases the unhappy ones: the network is down, the repository moved a file,
// the repository is broken. The properties that matter are
//
//   1. a failed fetch never removes a template, and
//   2. pulling can never undo a local file or a template edited in the panel.
//
// Nothing here touches the real network. A local HTTP server plays GitHub: the tree endpoint under
// /repos/... and the raw host for file bodies, which is all the client uses.
//
//   export PATH=/root/.hermes/node/bin:$PATH
//   DOCKYARD_LOGIN_RATE_MAX=1000 node --test server/test/template-remote.test.ts

import test, { after, before } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import type { FastifyInstance, FastifyRequest } from 'fastify';

import { buildApp } from '../src/app.ts';
import { runMigrations } from '../src/db/migrate.ts';
import { closePool, one, query } from '../src/db/pool.ts';
import { hashPassword } from '../src/auth/password.ts';
import { createSession } from '../src/auth/sessions.ts';
import { config } from '../src/config.ts';
import { builtinTemplates, syncBuiltinTemplates } from '../src/templates/catalog.ts';
import type { TemplateSpec } from '../src/templates/schema.ts';
import {
  maybeSyncRemoteTemplates,
  pullRemoteTemplates,
  resetRemoteTemplates,
  syncRemoteTemplates,
} from '../src/templates/remote.ts';
import { resetTemplateFileCache } from '../src/templates/files.ts';

const RUN = randomBytes(4).toString('hex');
const PASSWORD = 'test-password-123';
/** Every slug this file creates carries the run id, so cleanup cannot touch anything else. */
const PREFIX = `tr${RUN}`;

const ORIGINAL = {
  templatesRepo: config.templatesRepo,
  templatesBranch: config.templatesBranch,
  templateRemoteDir: config.templateRemoteDir,
  templatesApiBase: config.templatesApiBase,
  templatesRawBase: config.templatesRawBase,
  templatesRefreshMinutes: config.templatesRefreshMinutes,
};

let tmpDir: string;
let app: FastifyInstance;
let server: http.Server;
let base = '';
const createdUserIds: string[] = [];

/** What the fake repository is serving. `fail` makes the tree call return an error. */
const upstream = {
  files: new Map<string, string>(),
  fail: null as null | { status: number; body: string },
  rawFails: new Set<string>(),
  requests: [] as string[],
};

function spec(name: string, extra: Partial<TemplateSpec> = {}): TemplateSpec {
  return {
    schemaVersion: 1,
    slug: `${PREFIX}-${name}`,
    name: `Remote ${name}`,
    category: 'devtools',
    icon: 'x',
    description: 'a template from the repository',
    image: 'traefik/whoami',
    tag: 'v1.11.0',
    ports: [],
    env: [],
    volumes: [],
    restartPolicy: 'unless-stopped',
    ...extra,
  };
}

function publish(filePath: string, contents: unknown): void {
  upstream.files.set(filePath, typeof contents === 'string' ? contents : JSON.stringify(contents, null, 2));
}

function resetUpstream(): void {
  upstream.files.clear();
  upstream.fail = null;
  upstream.rawFails.clear();
  upstream.requests.length = 0;
}

function startFakeGithub(): Promise<string> {
  server = http.createServer((req, res) => {
    const url = req.url ?? '/';
    upstream.requests.push(url);

    // The tree endpoint: /repos/<owner>/<repo>/git/trees/<branch>?recursive=1
    if (/^\/repos\/[^/]+\/[^/]+\/git\/trees\//.test(url)) {
      if (upstream.fail) {
        res.writeHead(upstream.fail.status, { 'content-type': 'application/json' });
        res.end(upstream.fail.body);
        return;
      }
      const tree = [...upstream.files.keys()].sort().map((p) => ({
        path: p,
        type: 'blob',
        sha: '0'.repeat(40),
        size: upstream.files.get(p)?.length ?? 0,
      }));
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ sha: 'a'.repeat(40), tree, truncated: false }));
      return;
    }

    // The raw host: /<owner>/<repo>/<branch>/<path...>
    const parts = url.replace(/^\//, '').split('/');
    const filePath = parts.slice(3).join('/');
    if (upstream.rawFails.has(filePath)) {
      res.writeHead(404);
      res.end('not found');
      return;
    }
    const text = upstream.files.get(filePath);
    if (text === undefined) {
      res.writeHead(404);
      res.end('not found');
      return;
    }
    res.writeHead(200, { 'content-type': 'text/plain' });
    res.end(text);
  });

  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address() as AddressInfo;
      resolve(`http://127.0.0.1:${port}`);
    });
  });
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

async function insertUser(role: 'admin' | 'operator'): Promise<string> {
  const email = `tr-${role}-${randomBytes(3).toString('hex')}-${RUN}@dockyard.test`;
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
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dockyard-remote-'));
  base = await startFakeGithub();

  config.templatesRepo = 'testowner/testrepo';
  config.templatesBranch = 'main';
  config.templateRemoteDir = path.join(tmpDir, 'cache');
  config.templatesApiBase = base;
  config.templatesRawBase = base;
  config.templatesRefreshMinutes = 15;
  resetRemoteTemplates();
  resetTemplateFileCache();

  app = await buildApp();
  admin = await sessionFor(await insertUser('admin'));
  operator = await sessionFor(await insertUser('operator'));
});

after(async () => {
  await cleanupSlugs();
  await syncBuiltinTemplates();
  Object.assign(config, ORIGINAL);
  resetRemoteTemplates();
  resetTemplateFileCache();
  for (const id of createdUserIds) await query('delete from users where id = $1', [id]);
  await new Promise<void>((resolve) => server.close(() => resolve()));
  fs.rmSync(tmpDir, { recursive: true, force: true });
  await closePool();
});

// ---------------------------------------------------------------------------
// 1. Pulling
// ---------------------------------------------------------------------------

test('a pull writes the cache and stores the templates as source=remote', async () => {
  resetUpstream();
  await cleanupSlugs();
  resetRemoteTemplates();
  fs.rmSync(config.templateRemoteDir, { recursive: true, force: true });

  publish('templates/one.json', spec('one', { name: 'From the repo' }));
  publish('templates/two.json', [spec('two'), spec('three')]);

  const { pull, reconcile, cached } = await syncRemoteTemplates();

  assert.equal(pull.fetched, true);
  assert.equal(pull.stale, false);
  assert.equal(pull.commit, 'a'.repeat(40));
  assert.equal(pull.files, 2);
  assert.deepEqual(pull.errors, []);

  assert.equal(reconcile.inserted, 3);
  assert.equal(cached, 3);

  const { rows } = await query<{ slug: string; source: string }>(
    'select slug, source from templates where slug like $1 order by slug',
    [`${PREFIX}-%`],
  );
  assert.equal(rows.length, 3);
  assert.ok(rows.every((r) => r.source === 'remote'));

  const named = await one<{ name: string }>('select name from templates where slug = $1', [`${PREFIX}-one`]);
  assert.equal(named?.name, 'From the repo');

  // The cache is a real directory of files, so the operator can look at what was pulled.
  const cachedFiles = fs.readdirSync(config.templateRemoteDir).sort();
  assert.deepEqual(cachedFiles, ['one.json', 'two.json']);
});

test('files that are not templates are ignored', async () => {
  resetUpstream();
  await cleanupSlugs();
  resetRemoteTemplates();
  fs.rmSync(config.templateRemoteDir, { recursive: true, force: true });

  publish('package.json', { name: 'some app' });
  publish('app/tsconfig.json', { compilerOptions: {} });
  publish('README.md', '# not json');
  publish('_parked.json', spec('parked'));
  publish('templates/real.json', spec('real'));

  const { pull, reconcile } = await syncRemoteTemplates();

  assert.equal(pull.files, 1, 'only the one real template file should be read');
  assert.equal(reconcile.inserted, 1);
  const row = await one('select slug from templates where slug = $1', [`${PREFIX}-real`]);
  assert.ok(row);
  const parked = await one('select slug from templates where slug = $1', [`${PREFIX}-parked`]);
  assert.equal(parked, null, 'a parked file must not be loaded');
});

test('two files with the same basename are refused rather than silently shadowing each other', async () => {
  resetUpstream();
  await cleanupSlugs();
  resetRemoteTemplates();
  fs.rmSync(config.templateRemoteDir, { recursive: true, force: true });

  publish('templates/a/thing.json', spec('thing-a'));
  publish('templates/b/thing.json', spec('thing-b'));

  const { pull } = await syncRemoteTemplates();
  assert.equal(pull.fetched, false);
  assert.equal(pull.stale, true);
  assert.match(pull.message ?? '', /both named thing\.json/);
});

// ---------------------------------------------------------------------------
// 2. The property that matters: a failure never destroys anything
// ---------------------------------------------------------------------------

test('a failed fetch leaves the cache and the rows exactly as they were', async () => {
  resetUpstream();
  await cleanupSlugs();
  resetRemoteTemplates();
  fs.rmSync(config.templateRemoteDir, { recursive: true, force: true });

  publish('templates/keeper.json', spec('keeper', { name: 'Still here' }));
  await syncRemoteTemplates();

  const before = await one<{ name: string }>('select name from templates where slug = $1', [`${PREFIX}-keeper`]);
  assert.equal(before?.name, 'Still here');

  // Now the network goes away.
  upstream.fail = { status: 503, body: JSON.stringify({ message: 'Service Unavailable' }) };
  resetRemoteTemplates();

  const state = await maybeSyncRemoteTemplates();
  assert.equal(state?.pull?.stale, true);
  assert.match(state?.pull?.message ?? '', /503/);

  // The template is still there, still served, and the cache is untouched.
  const after = await one<{ name: string; source: string }>(
    'select name, source from templates where slug = $1',
    [`${PREFIX}-keeper`],
  );
  assert.equal(after?.name, 'Still here');
  assert.equal(after?.source, 'remote');
  assert.deepEqual(fs.readdirSync(config.templateRemoteDir), ['keeper.json']);
});

test('a failed first pull with no cache does not delete anything', async () => {
  resetUpstream();
  await cleanupSlugs();
  resetRemoteTemplates();
  fs.rmSync(config.templateRemoteDir, { recursive: true, force: true });

  // A row exists (as if a previous install had pulled it) but the cache is gone and the network is
  // down. Reconciling against the missing directory would read as "everything was deleted".
  await query(
    `insert into templates (slug, name, category, icon, description, spec, source)
     values ($1, 'Orphan', 'other', 'x', '', '{}'::jsonb, 'remote')`,
    [`${PREFIX}-orphan`],
  );

  upstream.fail = { status: 500, body: JSON.stringify({ message: 'boom' }) };
  const state = await maybeSyncRemoteTemplates();

  assert.equal(state?.pull?.stale, true);
  assert.equal(state?.reconcile, null, 'no reconcile should have run');
  const row = await one('select slug from templates where slug = $1', [`${PREFIX}-orphan`]);
  assert.ok(row, 'the row must survive a network failure');
});

test('a 404 explains that a private repository looks the same as a missing one', async () => {
  resetUpstream();
  resetRemoteTemplates();
  upstream.fail = { status: 404, body: JSON.stringify({ message: 'Not Found' }) };

  const pull = await pullRemoteTemplates();
  assert.equal(pull.fetched, false);
  assert.match(pull.message ?? '', /public/);
});

test('a 403 explains the anonymous rate limit', async () => {
  resetUpstream();
  resetRemoteTemplates();
  upstream.fail = { status: 403, body: JSON.stringify({ message: 'rate limit exceeded' }) };

  const pull = await pullRemoteTemplates();
  assert.match(pull.message ?? '', /DOCKYARD_TEMPLATES_TOKEN/);
});

test('one unreadable file fails the whole pull, so a partial set is never applied', async () => {
  resetUpstream();
  await cleanupSlugs();
  resetRemoteTemplates();
  fs.rmSync(config.templateRemoteDir, { recursive: true, force: true });

  publish('templates/fine.json', spec('fine'));
  publish('templates/gone.json', spec('gone'));
  upstream.rawFails.add('templates/gone.json');

  const { pull } = await syncRemoteTemplates();
  assert.equal(pull.fetched, false);
  assert.equal(pull.stale, true);
  assert.match(pull.message ?? '', /gone\.json/);
  assert.equal(fs.existsSync(config.templateRemoteDir), false, 'nothing should have been cached');
});

// ---------------------------------------------------------------------------
// 3. Changes upstream
// ---------------------------------------------------------------------------

test('a template added upstream appears on the next pull', async () => {
  resetUpstream();
  await cleanupSlugs();
  resetRemoteTemplates();
  fs.rmSync(config.templateRemoteDir, { recursive: true, force: true });

  publish('templates/first.json', spec('first'));
  await syncRemoteTemplates();
  assert.equal(await one('select slug from templates where slug = $1', [`${PREFIX}-later`]), null);

  publish('templates/later.json', spec('later', { name: 'Pushed later' }));
  resetRemoteTemplates();
  const { reconcile } = await syncRemoteTemplates();

  assert.equal(reconcile.inserted, 1);
  const row = await one<{ name: string }>('select name from templates where slug = $1', [`${PREFIX}-later`]);
  assert.equal(row?.name, 'Pushed later');
});

test('a template removed upstream is removed here', async () => {
  resetUpstream();
  await cleanupSlugs();
  resetRemoteTemplates();
  fs.rmSync(config.templateRemoteDir, { recursive: true, force: true });

  publish('templates/stays.json', spec('stays'));
  publish('templates/goes.json', spec('goes'));
  await syncRemoteTemplates();
  assert.ok(await one('select slug from templates where slug = $1', [`${PREFIX}-goes`]));

  upstream.files.delete('templates/goes.json');
  resetRemoteTemplates();
  const { reconcile } = await syncRemoteTemplates();

  assert.deepEqual(reconcile.removed, [`${PREFIX}-goes`]);
  assert.equal(await one('select slug from templates where slug = $1', [`${PREFIX}-goes`]), null);
  assert.ok(await one('select slug from templates where slug = $1', [`${PREFIX}-stays`]));
});

test('an edit upstream updates the row in place', async () => {
  resetUpstream();
  await cleanupSlugs();
  resetRemoteTemplates();
  fs.rmSync(config.templateRemoteDir, { recursive: true, force: true });

  publish('templates/edit.json', spec('edit', { tag: 'v1' }));
  await syncRemoteTemplates();

  publish('templates/edit.json', spec('edit', { tag: 'v2', name: 'Edited upstream' }));
  resetRemoteTemplates();
  const { reconcile } = await syncRemoteTemplates();

  assert.equal(reconcile.updated, 1);
  const row = await one<{ name: string; tag: string }>(
    'select name, spec->>$1 as tag from templates where slug = $2',
    ['tag', `${PREFIX}-edit`],
  );
  assert.equal(row?.name, 'Edited upstream');
  assert.equal(row?.tag, 'v2');
});

test('a malformed file upstream is reported and skipped, and the rest still load', async () => {
  resetUpstream();
  await cleanupSlugs();
  resetRemoteTemplates();
  fs.rmSync(config.templateRemoteDir, { recursive: true, force: true });

  publish('templates/good.json', spec('good'));
  publish('templates/bad.json', '{ not json at all');

  const { reconcile } = await syncRemoteTemplates();

  assert.equal(reconcile.inserted, 1);
  assert.equal(reconcile.errors.length, 1);
  assert.equal(reconcile.errors[0].file, 'bad.json');
  assert.ok(await one('select slug from templates where slug = $1', [`${PREFIX}-good`]));
});

// ---------------------------------------------------------------------------
// 4. Precedence: a pull never undoes local work
// ---------------------------------------------------------------------------

test('a local file overrides the repository, and the repository row comes back when it goes', async () => {
  resetUpstream();
  await cleanupSlugs();
  resetRemoteTemplates();
  resetTemplateFileCache();
  fs.rmSync(config.templateRemoteDir, { recursive: true, force: true });

  const localDir = path.join(tmpDir, 'local');
  fs.mkdirSync(localDir, { recursive: true });
  const localFile = path.join(localDir, 'override.json');
  const slug = `${PREFIX}-contested`;

  publish('templates/contested.json', spec('contested', { name: 'From the repo', tag: 'repo-tag' }));
  await syncRemoteTemplates();

  let row = await one<{ name: string; source: string }>('select name, source from templates where slug = $1', [slug]);
  assert.equal(row?.source, 'remote');
  assert.equal(row?.name, 'From the repo');

  // The operator drops a local file claiming the same slug. This goes through the API rather than
  // calling the reconciler directly, because the restoring cascade lives in the route helper: a
  // local file that shadows a repository template has to give it back when it is removed.
  fs.writeFileSync(localFile, JSON.stringify(spec('contested', { name: 'From a local file', tag: 'local-tag' })));
  config.templateDir = localDir;
  resetTemplateFileCache();

  await app.inject({ method: 'GET', url: '/api/templates', headers: cookieHeader(admin) });

  row = await one<{ name: string; source: string }>('select name, source from templates where slug = $1', [slug]);
  assert.equal(row?.source, 'file');
  assert.equal(row?.name, 'From a local file');

  // And a pull must not take it back.
  resetRemoteTemplates();
  await app.inject({ method: 'GET', url: '/api/templates', headers: cookieHeader(admin) });
  row = await one<{ name: string; source: string }>('select name, source from templates where slug = $1', [slug]);
  assert.equal(row?.source, 'file', 'a pull must not overwrite a local file');
  assert.equal(row?.name, 'From a local file');

  // Removing the local file lets the repository version back in.
  fs.rmSync(localFile);
  resetTemplateFileCache();
  await app.inject({ method: 'GET', url: '/api/templates', headers: cookieHeader(admin) });
  row = await one<{ name: string; source: string }>('select name, source from templates where slug = $1', [slug]);
  assert.equal(row?.source, 'remote');
  assert.equal(row?.name, 'From the repo');

  config.templateDir = path.join(tmpDir, 'unused-local');
});

test('deleting a template authored here uncovers the one underneath', async () => {
  resetUpstream();
  await cleanupSlugs();
  resetRemoteTemplates();
  fs.rmSync(config.templateRemoteDir, { recursive: true, force: true });

  const slug = `${PREFIX}-covered`;
  publish('templates/covered.json', spec('covered', { name: 'From the repo' }));
  await syncRemoteTemplates();
  assert.equal(
    (await one<{ source: string }>('select source from templates where slug = $1', [slug]))?.source,
    'remote',
  );

  // An operator authors their own version in the panel, which shadows the repository one.
  await query(
    `update templates set name = 'Authored here', source = 'user' where slug = $1`,
    [slug],
  );

  const res = await app.inject({ method: 'DELETE', url: `/api/templates/${slug}`, headers: cookieHeader(admin) });
  assert.equal(res.statusCode, 200);

  // Deleting it has to bring the repository version back, not leave a hole.
  const row = await one<{ name: string; source: string }>('select name, source from templates where slug = $1', [slug]);
  assert.equal(row?.source, 'remote');
  assert.equal(row?.name, 'From the repo');
});

test('a template edited in the panel is never overwritten by a pull', async () => {
  resetUpstream();
  await cleanupSlugs();
  resetRemoteTemplates();
  fs.rmSync(config.templateRemoteDir, { recursive: true, force: true });

  const slug = `${PREFIX}-mine`;
  await query(
    `insert into templates (slug, name, category, icon, description, spec, source)
     values ($1, 'Authored here', 'other', 'x', '', '{}'::jsonb, 'user')`,
    [slug],
  );

  publish('templates/mine.json', spec('mine', { name: 'From the repo' }));
  const { reconcile } = await syncRemoteTemplates();

  assert.deepEqual(reconcile.skippedUser, [slug]);
  const row = await one<{ name: string; source: string }>('select name, source from templates where slug = $1', [slug]);
  assert.equal(row?.source, 'user');
  assert.equal(row?.name, 'Authored here');
});

test('the repository overrides a builtin of the same slug', async () => {
  resetUpstream();
  await cleanupSlugs();
  resetRemoteTemplates();
  fs.rmSync(config.templateRemoteDir, { recursive: true, force: true });

  const builtin = builtinTemplates()[0];
  try {
    publish('templates/builtin.json', { ...builtin, tag: 'repo-override-tag', name: 'Overridden by the repo' });
    const { reconcile } = await syncRemoteTemplates();

    assert.deepEqual(reconcile.overrides, [builtin.slug]);
    const row = await one<{ name: string; source: string; tag: string }>(
      'select name, source, spec->>$1 as tag from templates where slug = $2',
      ['tag', builtin.slug],
    );
    assert.equal(row?.source, 'remote');
    assert.equal(row?.name, 'Overridden by the repo');
    assert.equal(row?.tag, 'repo-override-tag');
  } finally {
    upstream.files.delete('templates/builtin.json');
    resetRemoteTemplates();
    await query('delete from templates where slug = $1', [builtin.slug]);
    await syncBuiltinTemplates();
  }
});

// ---------------------------------------------------------------------------
// 5. The refresh window
// ---------------------------------------------------------------------------

test('a second read inside the refresh window does not fetch again', async () => {
  resetUpstream();
  await cleanupSlugs();
  resetRemoteTemplates();
  fs.rmSync(config.templateRemoteDir, { recursive: true, force: true });

  publish('templates/window.json', spec('window'));

  await maybeSyncRemoteTemplates();
  const afterFirst = upstream.requests.filter((u) => u.includes('/git/trees/')).length;
  assert.equal(afterFirst, 1);

  // Two more reads, both inside the window.
  await maybeSyncRemoteTemplates();
  await maybeSyncRemoteTemplates();
  const afterMore = upstream.requests.filter((u) => u.includes('/git/trees/')).length;
  assert.equal(afterMore, 1, 'the tree call should have been made once');

  // An explicit pull ignores the window.
  await syncRemoteTemplates();
  const afterExplicit = upstream.requests.filter((u) => u.includes('/git/trees/')).length;
  assert.equal(afterExplicit, 2);
});

test('a repository with no templates folder is read from its root', async () => {
  resetUpstream();
  await cleanupSlugs();
  resetRemoteTemplates();
  fs.rmSync(config.templateRemoteDir, { recursive: true, force: true });

  // The other accepted layout: JSON at the root, no folder. Its own project files are still ignored.
  publish('alpha.json', spec('alpha'));
  publish('beta.json', spec('beta'));
  publish('package.json', { name: 'not a template' });
  publish('tsconfig.json', { compilerOptions: {} });
  publish('src/nested.json', spec('nested'));

  const { pull, reconcile } = await syncRemoteTemplates();
  assert.equal(pull.files, 2, 'only the two root-level templates');
  assert.equal(reconcile.inserted, 2);
  assert.equal(await one('select slug from templates where slug = $1', [`${PREFIX}-nested`]), null);
  assert.ok(await one('select slug from templates where slug = $1', [`${PREFIX}-alpha`]));
});

test('a warm refresh window still reconciles the cache', async () => {
  resetUpstream();
  await cleanupSlugs();
  resetRemoteTemplates();
  fs.rmSync(config.templateRemoteDir, { recursive: true, force: true });
  publish('templates/first-window.json', spec('first-window'));

  await maybeSyncRemoteTemplates();
  const treesAfterFirst = upstream.requests.filter((u) => u.includes('/git/trees/')).length;
  assert.equal(treesAfterFirst, 1);

  // The cache changes without a fetch, as it would if an operator edited it or a pull landed from
  // another request. The window suppresses the network call, not the reconcile.
  fs.writeFileSync(
    path.join(config.templateRemoteDir, 'added-by-hand.json'),
    JSON.stringify(spec('added-by-hand')),
  );

  const state = await maybeSyncRemoteTemplates();
  assert.equal(state?.reconcile?.inserted, 1);
  assert.equal(
    upstream.requests.filter((u) => u.includes('/git/trees/')).length,
    1,
    'the window should have suppressed the fetch',
  );
  assert.ok(await one('select slug from templates where slug = $1', [`${PREFIX}-added-by-hand`]));
});

// ---------------------------------------------------------------------------
// 6. Over HTTP
// ---------------------------------------------------------------------------

test('the sources route reports the repository to a viewer', async () => {
  resetUpstream();
  await cleanupSlugs();
  resetRemoteTemplates();
  fs.rmSync(config.templateRemoteDir, { recursive: true, force: true });
  publish('templates/visible.json', spec('visible'));

  const res = await app.inject({ method: 'GET', url: '/api/template-files', headers: cookieHeader(admin) });
  assert.equal(res.statusCode, 200);

  const body = res.json() as {
    remote: { enabled: boolean; repo: string; branch: string; cached: number; pull: { fetched: boolean } | null };
  };
  assert.equal(body.remote.enabled, true);
  assert.equal(body.remote.repo, 'testowner/testrepo');
  assert.equal(body.remote.branch, 'main');
  assert.ok(body.remote.cached >= 1);
  assert.equal(body.remote.pull?.fetched, true);

  // The token is never part of the payload, only whether one is set.
  assert.ok(!JSON.stringify(body).includes('templatesToken'));
});

test('a template from the repository is listed with source=remote', async () => {
  resetUpstream();
  await cleanupSlugs();
  resetRemoteTemplates();
  fs.rmSync(config.templateRemoteDir, { recursive: true, force: true });
  publish('templates/listed.json', spec('listed', { name: 'Listed from the repo' }));

  const res = await app.inject({ method: 'GET', url: '/api/templates', headers: cookieHeader(admin) });
  assert.equal(res.statusCode, 200);
  const rows = res.json() as Array<{ slug: string; source: string; name: string }>;
  const found = rows.find((t) => t.slug === `${PREFIX}-listed`);
  assert.ok(found, 'the remote template should be listed');
  assert.equal(found?.source, 'remote');

  const filtered = await app.inject({
    method: 'GET',
    url: '/api/templates?source=remote',
    headers: cookieHeader(admin),
  });
  const onlyRemote = filtered.json() as Array<{ source: string }>;
  assert.ok(onlyRemote.length >= 1);
  assert.ok(onlyRemote.every((t) => t.source === 'remote'));
});

test('pulling is an admin action, and it reconciles straight away', async () => {
  resetUpstream();
  await cleanupSlugs();
  resetRemoteTemplates();
  fs.rmSync(config.templateRemoteDir, { recursive: true, force: true });
  publish('templates/button.json', spec('button', { name: 'Pulled by the button' }));

  const denied = await app.inject({
    method: 'POST',
    url: '/api/template-remote/pull',
    headers: cookieHeader(operator),
  });
  assert.equal(denied.statusCode, 403);

  const allowed = await app.inject({
    method: 'POST',
    url: '/api/template-remote/pull',
    headers: cookieHeader(admin),
  });
  assert.equal(allowed.statusCode, 200);
  const body = allowed.json() as {
    pull: { fetched: boolean; files: number };
    reconcile: { inserted: number };
    cached: number;
  };
  assert.equal(body.pull.fetched, true);
  assert.equal(body.reconcile.inserted, 1);
  assert.equal(body.cached, 1);

  const row = await one<{ name: string }>('select name from templates where slug = $1', [`${PREFIX}-button`]);
  assert.equal(row?.name, 'Pulled by the button');

  const audited = await one<{ action: string }>(
    "select action from audit_log where action = 'template.pull_remote' order by created_at desc limit 1",
  );
  assert.ok(audited, 'the pull should be audited');
});

test('a failed pull through the API still answers, with the reason', async () => {
  resetUpstream();
  resetRemoteTemplates();
  upstream.fail = { status: 503, body: JSON.stringify({ message: 'down' }) };

  const res = await app.inject({
    method: 'POST',
    url: '/api/template-remote/pull',
    headers: cookieHeader(admin),
  });
  assert.equal(res.statusCode, 200, 'a pull that fails is still a completed request');
  const body = res.json() as { pull: { stale: boolean; message: string } };
  assert.equal(body.pull.stale, true);
  assert.match(body.pull.message, /503/);
});

test('a repository template cannot be deleted through the API', async () => {
  resetUpstream();
  await cleanupSlugs();
  resetRemoteTemplates();
  fs.rmSync(config.templateRemoteDir, { recursive: true, force: true });
  publish('templates/pinned.json', spec('pinned'));
  await app.inject({ method: 'GET', url: '/api/template-files', headers: cookieHeader(admin) });

  const res = await app.inject({
    method: 'DELETE',
    url: `/api/templates/${PREFIX}-pinned`,
    headers: cookieHeader(admin),
  });
  assert.equal(res.statusCode, 409);
  assert.match((res.json() as { error: { message: string } }).error.message, /template repository/);

  const row = await one('select id from templates where slug = $1', [`${PREFIX}-pinned`]);
  assert.ok(row, 'it should still be there');
});

test('the source can be switched off, and then a read touches nothing', async () => {
  resetUpstream();
  await cleanupSlugs();
  resetRemoteTemplates();
  fs.rmSync(config.templateRemoteDir, { recursive: true, force: true });
  publish('templates/off.json', spec('off'));
  await syncRemoteTemplates();
  assert.ok(await one('select slug from templates where slug = $1', [`${PREFIX}-off`]));

  config.templatesRepo = '';
  try {
    resetRemoteTemplates();
    const state = await maybeSyncRemoteTemplates();
    assert.equal(state, null, 'a disabled source should not reconcile');
    // Disabling must not delete: it is a configuration change, not a deletion.
    assert.ok(await one('select slug from templates where slug = $1', [`${PREFIX}-off`]));
    assert.equal(upstream.requests.filter((u) => u.includes('/git/trees/')).length, 1);
  } finally {
    config.templatesRepo = 'testowner/testrepo';
  }
});
