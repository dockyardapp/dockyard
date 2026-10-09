// Dockyard — version and update tests.
//
// Covers the three pieces that carry a decision and can be exercised without a network or a
// database: the build stamp the panel reports, the compare payload mapping (a local commit ahead
// of origin must not read as an available update), and the request/status handshake the host
// updater shares with the panel.
//
// The GitHub call itself is deliberately not exercised: it dials api.github.com, which would make
// the suite depend on a third party and on a rate limit.

import { test, describe, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { config, repoRoot } from '../src/config.ts';
import { buildInfo } from '../src/version.ts';
import { readJob, updaterInfo, writeRequest } from '../src/update/spool.ts';
import { summariseCompare } from '../src/update/check.ts';

const originalSpool = config.updateSpoolDir;
const tmpDirs: string[] = [];

function useTempSpool(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dy-update-'));
  tmpDirs.push(dir);
  config.updateSpoolDir = dir;
  return dir;
}

after(() => {
  config.updateSpoolDir = originalSpool;
  for (const dir of tmpDirs) fs.rmSync(dir, { recursive: true, force: true });
});

describe('buildInfo', () => {
  test('reports the version from the root package.json', () => {
    const pkg = JSON.parse(fs.readFileSync(path.join(repoRoot, 'package.json'), 'utf8')) as {
      version: string;
    };
    assert.equal(buildInfo.version, pkg.version);
  });

  test('a commit is either absent or a full sha, and pinned follows it', () => {
    if (buildInfo.commit === '') {
      assert.equal(buildInfo.pinned, false, 'no commit means the build is not pinned');
      assert.equal(buildInfo.commitShort, '');
      return;
    }
    assert.match(buildInfo.commit, /^[0-9a-f]{40}$/);
    assert.equal(buildInfo.commitShort, buildInfo.commit.slice(0, 7));
    assert.equal(buildInfo.pinned, true);
  });

  test('builtAt is either absent or an ISO timestamp', () => {
    if (buildInfo.builtAt === null) return;
    assert.ok(!Number.isNaN(Date.parse(buildInfo.builtAt)), `unparseable builtAt ${buildInfo.builtAt}`);
  });
});

describe('summariseCompare', () => {
  const commit = (sha: string, subject: string) => ({
    sha,
    html_url: `https://github.com/x/y/commit/${sha}`,
    commit: { message: `${subject}\n\nbody`, author: { name: 'elias', date: '2026-10-09T06:00:00Z' } },
  });

  test('identical means current, with nothing to install', () => {
    const out = summariseCompare({ status: 'identical', ahead_by: 0, behind_by: 0 });
    assert.equal(out.status, 'current');
    assert.equal(out.behindBy, 0);
    assert.deepEqual(out.commits, []);
  });

  test('a branch ahead of the running commit is an update, incoming commits newest first', () => {
    // Shaped like GitHub's answer to compare/<running commit>...<branch>. The payload describes the
    // branch relative to the running build, so its `ahead_by` is how far the panel is behind.
    const out = summariseCompare({
      status: 'ahead',
      ahead_by: 2,
      behind_by: 0,
      // GitHub lists these oldest first.
      commits: [commit('a'.repeat(40), 'older'), commit('b'.repeat(40), 'newer')],
    });
    assert.equal(out.status, 'behind', 'the branch being ahead of us is us being behind');
    assert.equal(out.behindBy, 2);
    assert.deepEqual(
      out.commits.map((c) => c.subject),
      ['newer', 'older'],
    );
    assert.equal(out.commits[0]?.commitShort, 'b'.repeat(7));
    assert.equal(out.commits[0]?.author, 'elias');
    assert.equal(out.commits[0]?.subject, 'newer', 'the body must not leak into the subject');
  });

  test('a branch behind the running commit is not an update', () => {
    const out = summariseCompare({ status: 'behind', ahead_by: 0, behind_by: 3 });
    assert.equal(out.status, 'ahead');
    assert.equal(out.aheadBy, 3);
    assert.equal(out.behindBy, 0);
    assert.deepEqual(out.commits, [], 'nothing is pulled when the build is ahead');
  });

  test('diverged is reported as diverged, not as behind', () => {
    // Both sides carry commits, so an update is not a fast-forward and the updater would refuse it.
    const out = summariseCompare({ status: 'diverged', ahead_by: 1, behind_by: 4 });
    assert.equal(out.status, 'diverged');
    assert.equal(out.behindBy, 1, 'commits the branch has that this build does not');
    assert.equal(out.aheadBy, 4, 'commits this build has that the branch does not');
    assert.deepEqual(out.commits, []);
  });

  test('the recorded live payload reads as an available update', () => {
    // Captured from GET /repos/fastify/fastify/compare/<an older commit>...main, verbatim shape.
    // This is the case that was read backwards: the branch was 4 ahead of the running commit and
    // the card still said there was nothing to install.
    const out = summariseCompare({
      status: 'ahead',
      ahead_by: 4,
      behind_by: 0,
      total_commits: 4,
      commits: [
        commit('d174a98e1a541639878d9f25b3738c78aa5c0165', 'docs: list fastify-mariadb as a community plugin (#7062)'),
        commit('19d5be0daf1c3f9e0d4b8e3e5a5f1f5f5f5f5f5f', 'fix: resolve reply.mediaType from raw response headers'),
      ],
    });
    assert.equal(out.status, 'behind');
    assert.equal(out.behindBy, 4);
    assert.equal(out.aheadBy, 0);
    assert.equal(out.commits.length, 2, 'the incoming commits are the ones to show');
  });

  test('an unrecognised status falls to unknown rather than to behind', () => {
    // Anything else would offer an update on the strength of a string GitHub never promised.
    assert.equal(summariseCompare({ status: 'weird' }).status, 'unknown');
    assert.equal(summariseCompare({}).status, 'unknown');
  });

  test('missing counts read as zero instead of NaN', () => {
    const out = summariseCompare({ status: 'ahead' });
    assert.equal(out.behindBy, 0);
    assert.equal(out.aheadBy, 0);
  });
});

describe('update spool', () => {
  test('no request and no status means no job', () => {
    useTempSpool();
    assert.equal(readJob(), null);
  });

  test('a written request reads back as a queued job', () => {
    const dir = useTempSpool();
    const request = writeRequest({
      branch: 'main',
      by: 'admin@dockyard.local',
      version: '0.2.0',
      commit: 'c'.repeat(40),
    });

    assert.ok(fs.existsSync(path.join(dir, 'request.json')));
    const job = readJob();
    assert.equal(job?.state, 'queued');
    assert.equal(job?.id, request.id);
    assert.equal(job?.requestedBy, 'admin@dockyard.local');
    assert.equal(job?.from.commit, 'c'.repeat(40));
    assert.equal(job?.to.commit, null);
  });

  test('a request newer than a finished run wins, so the button is not inert', () => {
    const dir = useTempSpool();
    // A terminal status left behind by the previous update.
    fs.writeFileSync(
      path.join(dir, 'status.json'),
      JSON.stringify({
        id: 'old',
        state: 'success',
        step: 'done',
        message: 'Updated.',
        requestedAt: '2026-10-09T05:00:00.000Z',
        requestedBy: 'admin@dockyard.local',
        startedAt: '2026-10-09T05:00:01.000Z',
        finishedAt: '2026-10-09T05:04:00.000Z',
        from: { version: '0.1.0', commit: 'a'.repeat(40) },
        to: { version: '0.1.0', commit: 'a'.repeat(40) },
        log: null,
      }),
    );
    assert.equal(readJob()?.state, 'success', 'the old run is what the panel shows first');

    writeRequest({ branch: 'main', by: 'admin@dockyard.local', version: '0.1.0', commit: 'a'.repeat(40) });
    assert.equal(readJob()?.state, 'queued', 'the fresh request must not be masked by the old run');
  });

  test('a run that stopped reporting goes stale instead of spinning forever', () => {
    const dir = useTempSpool();
    const longAgo = new Date(Date.now() - 45 * 60 * 1000).toISOString();
    fs.writeFileSync(
      path.join(dir, 'status.json'),
      JSON.stringify({
        id: 'stuck',
        state: 'running',
        step: 'build',
        message: null,
        startedAt: longAgo,
        from: { version: '0.1.0', commit: 'a'.repeat(40) },
        to: { version: null, commit: null },
      }),
    );
    const job = readJob();
    assert.equal(job?.state, 'stale');
    assert.match(String(job?.message), /systemctl status dockyard-updater/);
  });

  test('a running job inside the timeout is reported as running', () => {
    const dir = useTempSpool();
    fs.writeFileSync(
      path.join(dir, 'status.json'),
      JSON.stringify({
        id: 'live',
        state: 'running',
        step: 'health',
        startedAt: new Date(Date.now() - 30 * 1000).toISOString(),
        from: { version: '0.1.0', commit: 'a'.repeat(40) },
        to: { version: '0.2.0', commit: 'b'.repeat(40) },
      }),
    );
    assert.equal(readJob()?.state, 'running');
  });

  test('an unknown state in the file does not reach the UI', () => {
    const dir = useTempSpool();
    fs.writeFileSync(path.join(dir, 'status.json'), JSON.stringify({ id: 'x', state: 'exploded' }));
    const job = readJob();
    assert.equal(job?.state, 'stale', 'an unrecognised state must not read as queued work');
    assert.match(String(job?.message), /different versions/);
  });

  test('a corrupt status file does not throw', () => {
    const dir = useTempSpool();
    fs.writeFileSync(path.join(dir, 'status.json'), '{not json');
    assert.equal(readJob(), null);
  });

  test('the updater marker decides whether the button is offered', () => {
    const dir = useTempSpool();
    assert.equal(updaterInfo().installed, false);
    fs.writeFileSync(path.join(dir, 'updater.json'), JSON.stringify({ installedAt: '2026-10-09T06:00:00Z' }));
    const info = updaterInfo();
    assert.equal(info.installed, true);
    assert.equal(info.installedAt, '2026-10-09T06:00:00Z');
    assert.equal(info.spoolDir, dir);
  });
});

test('routes: system registers the version and update paths', async () => {
  const Fastify = (await import('fastify')).default;
  const { default: systemRoutes } = await import('../src/routes/system.ts');

  const app = Fastify({ logger: false });
  await app.register(systemRoutes, { prefix: '/api' });
  await app.ready();

  for (const url of ['/api/system/health', '/api/system/info', '/api/system/update']) {
    assert.ok(app.hasRoute({ method: 'GET', url }), `missing route GET ${url}`);
  }
  assert.ok(app.hasRoute({ method: 'POST', url: '/api/system/update' }), 'missing POST /api/system/update');

  // The trigger is admin-only and the check needs a session. Both refusals happen before any
  // database access, so this needs no Postgres.
  const anonymous = await app.inject({ method: 'POST', url: '/api/system/update' });
  assert.equal(anonymous.statusCode, 401);
  assert.equal(anonymous.json().error.code, 'unauthorized');

  const readAnonymous = await app.inject({ method: 'GET', url: '/api/system/update' });
  assert.equal(readAnonymous.statusCode, 401);

  await app.close();
});
