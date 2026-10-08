// Dockyard — docker layer tests (owner: agent 1).
//
// Covers: stats math, error normalisation, multiplexed log demuxing, and a full container
// lifecycle against the in-memory mock daemon. A guarded live test creates and removes a real
// alpine:3.20 container when a daemon is reachable (skips cleanly otherwise).

import { test, describe, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { startMockDocker } from './mock-docker.ts';

const here = path.dirname(fileURLToPath(import.meta.url));
const dockerIndexUrl = pathToFileURL(path.join(here, '..', 'src', 'docker', 'index.ts')).href;

// --- Point the docker layer at the mock BEFORE it (and config) is imported. ---
const mock = await startMockDocker();
process.env.NODE_ENV = 'test';
process.env.DOCKER_HOST = mock.url;

const docker = await import('../src/docker/index.ts');
const containers = await import('../src/docker/containers.ts');
const errorsMod = await import('../src/docker/errors.ts');
const statsMod = await import('../src/docker/stats.ts');

after(async () => {
  await mock.close();
});

function frame(type: 1 | 2, payload: string): Buffer {
  const data = Buffer.from(payload, 'utf8');
  const header = Buffer.alloc(8);
  header.writeUInt8(type, 0);
  header.writeUInt32BE(data.length, 4);
  return Buffer.concat([header, data]);
}

function readAll(stream: NodeJS.ReadableStream): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    stream.on('data', (c: Buffer | string) => chunks.push(Buffer.isBuffer(c) ? c : Buffer.from(c)));
    stream.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    stream.on('error', reject);
  });
}

describe('stats math', () => {
  test('computes cpu%, memory, network, blkio and pids from a canned frame', () => {
    const frameData = {
      cpu_stats: {
        cpu_usage: { total_usage: 300, percpu_usage: [1, 2, 3, 4] },
        system_cpu_usage: 2000,
        online_cpus: 4,
      },
      precpu_stats: { cpu_usage: { total_usage: 100 }, system_cpu_usage: 1000 },
      memory_stats: { usage: 1000, limit: 4000, stats: { cache: 200 } },
      networks: {
        eth0: { rx_bytes: 10, tx_bytes: 20 },
        eth1: { rx_bytes: 5, tx_bytes: 7 },
      },
      blkio_stats: {
        io_service_bytes_recursive: [
          { op: 'Read', value: 100 },
          { op: 'Write', value: 200 },
          { op: 'Read', value: 50 },
          { op: 'Sync', value: 999 },
        ],
      },
      pids_stats: { current: 7 },
    };
    const s = statsMod.computeContainerStats(frameData);
    assert.equal(s.cpuPercent, 80); // (200/1000)*4*100
    assert.equal(s.memUsed, 800); // 1000 - 200 cache
    assert.equal(s.memLimit, 4000);
    assert.equal(s.memPercent, 20);
    assert.equal(s.netRx, 15);
    assert.equal(s.netTx, 27);
    assert.equal(s.blkRead, 150);
    assert.equal(s.blkWrite, 200);
    assert.equal(s.pids, 7);
    assert.match(s.readAt, /^\d{4}-\d{2}-\d{2}T/);
  });

  test('guards systemDelta <= 0 and cpuDelta < 0', () => {
    const zeroDelta = statsMod.computeContainerStats({
      cpu_stats: { cpu_usage: { total_usage: 100 }, system_cpu_usage: 1000, online_cpus: 2 },
      precpu_stats: { cpu_usage: { total_usage: 100 }, system_cpu_usage: 1000 },
    });
    assert.equal(zeroDelta.cpuPercent, 0);

    const negDelta = statsMod.computeContainerStats({
      cpu_stats: { cpu_usage: { total_usage: 10 }, system_cpu_usage: 2000, online_cpus: 2 },
      precpu_stats: { cpu_usage: { total_usage: 100 }, system_cpu_usage: 1000 },
    });
    assert.equal(negDelta.cpuPercent, 0);
  });

  test('falls back to percpu_usage length for online cpus and clamps negative memory', () => {
    const s = statsMod.computeContainerStats({
      cpu_stats: { cpu_usage: { total_usage: 200, percpu_usage: [1, 2] }, system_cpu_usage: 2000 },
      precpu_stats: { cpu_usage: { total_usage: 100 }, system_cpu_usage: 1000 },
      memory_stats: { usage: 100, limit: 1000, stats: { cache: 500 } },
    });
    assert.equal(s.cpuPercent, 20); // (100/1000)*2*100
    assert.equal(s.memUsed, 0); // 100 - 500 clamped
  });
});

describe('error normalisation', () => {
  const { normalizeDockerError, DockerError } = errorsMod;

  test('maps status codes to API codes and preserves the daemon message', () => {
    const nf = normalizeDockerError({ statusCode: 404, json: { message: 'No such container: abc' } });
    assert.equal(nf.code, 'not_found');
    assert.equal(nf.statusCode, 404);
    assert.equal(nf.dockerStatus, 404);
    assert.equal(nf.message, 'No such container: abc');

    const conflict = normalizeDockerError({ statusCode: 409, reason: 'conflict' });
    assert.equal(conflict.code, 'conflict');
    assert.equal(conflict.statusCode, 409);

    const bad = normalizeDockerError({ statusCode: 400, json: { message: 'bad parameter' } });
    assert.equal(bad.code, 'validation_error');
    assert.equal(bad.statusCode, 400);
    assert.equal(bad.message, 'bad parameter');
  });

  test('maps connection errors to docker_unavailable/503', () => {
    for (const code of ['ECONNREFUSED', 'ENOENT', 'EACCES']) {
      const e = normalizeDockerError({ code, message: 'socket failed' });
      assert.equal(e.code, 'docker_unavailable', `${code} -> docker_unavailable`);
      assert.equal(e.statusCode, 503);
    }
  });

  test('defaults to docker_error/502 and passes DockerError through', () => {
    const e = normalizeDockerError(new Error('something odd'));
    assert.equal(e.code, 'docker_error');
    assert.equal(e.statusCode, 502);

    const orig = new DockerError('nope', { code: 'not_found', statusCode: 404 });
    assert.equal(normalizeDockerError(orig), orig);
  });
});

describe('log demuxing', () => {
  test('demuxes 8-byte framed stdout/stderr in order', () => {
    const buf = Buffer.concat([frame(1, 'hello '), frame(2, 'oops'), frame(1, 'world')]);
    const out = containers.demuxDockerStream(buf);
    assert.equal(out.stdout, 'hello world');
    assert.equal(out.stderr, 'oops');
    assert.equal(out.combined, 'hello oopsworld');
  });

  test('passes non-multiplexed (TTY) output through untouched', () => {
    const out = containers.demuxDockerStream(Buffer.from('plain tty output\n'));
    assert.equal(out.stdout, 'plain tty output\n');
    assert.equal(out.stderr, '');
    assert.equal(out.combined, 'plain tty output\n');
  });
});

describe('mock docker lifecycle', () => {
  test('dockerPing reports the mock daemon', async () => {
    const ping = await docker.dockerPing();
    assert.equal(ping.ok, true);
    assert.equal(ping.apiVersion, '1.45');
    assert.ok(ping.version?.includes('mock'));
    assert.ok(ping.containers);
  });

  test('create -> start -> inspect -> pause/unpause -> restart -> stop -> kill -> remove', async () => {
    const created = await containers.createContainer({
      name: 'dy-lifecycle',
      image: 'alpine:3.20',
      cmd: ['sleep', '300'],
      env: { FOO: 'bar' },
      ports: [{ host: 18080, container: 80 }],
      labels: { 'dockyard.managed': 'true', 'dockyard.stack': 'stk-1', 'dockyard.template': 'alpine' },
    });
    assert.ok(created.id, 'create returns an id');
    assert.equal(created.name, 'dy-lifecycle');
    assert.deepEqual(created.warnings, []);

    await containers.startContainer(created.id);

    const list = await containers.listContainers({ all: true });
    const summary = list.find((c) => c.id === created.id);
    assert.ok(summary, 'created container appears in the list');
    assert.equal(summary!.name, 'dy-lifecycle'); // no leading slash
    assert.equal(summary!.managed, true);
    assert.equal(summary!.stackId, 'stk-1');
    assert.equal(summary!.templateSlug, 'alpine');
    assert.equal(summary!.state, 'running');
    assert.equal(summary!.ports[0].privatePort, 80);
    assert.equal(summary!.ports[0].publicPort, 18080);

    const detail = await containers.getContainer(created.id);
    assert.equal(detail.command, 'sleep 300');
    assert.ok(detail.env.includes('FOO=bar'));
    assert.equal(detail.restartPolicy, 'no');
    assert.ok(detail.networks.some((n) => n.name === 'bridge'));

    await containers.pauseContainer(created.id);
    assert.equal((await containers.getContainer(created.id)).state, 'paused');
    await containers.unpauseContainer(created.id);
    assert.equal((await containers.getContainer(created.id)).state, 'running');

    await containers.restartContainer(created.id);
    assert.equal((await containers.getContainer(created.id)).state, 'running');

    await containers.stopContainer(created.id);
    assert.equal((await containers.getContainer(created.id)).state, 'exited');

    await containers.startContainer(created.id);
    await containers.killContainer(created.id);
    assert.equal((await containers.getContainer(created.id)).state, 'exited');

    await containers.removeContainer(created.id, { force: true });
    assert.equal((await containers.listContainers({ all: true })).find((c) => c.id === created.id), undefined);
  });

  test('getContainer on a missing id throws DockerError 404', async () => {
    await assert.rejects(
      () => containers.getContainer('deadbeefdeadbeef'),
      (err: any) => err instanceof errorsMod.DockerError && err.statusCode === 404 && err.code === 'not_found',
    );
  });

  test('removing a running container without force maps to conflict/409', async () => {
    const created = await containers.createContainer({ name: 'dy-conflict', image: 'alpine:3.20', pull: false });
    await containers.startContainer(created.id);
    await assert.rejects(
      () => containers.removeContainer(created.id),
      (err: any) => err instanceof errorsMod.DockerError && err.statusCode === 409 && err.code === 'conflict',
    );
    await containers.removeContainer(created.id, { force: true });
  });

  test('resolveContainer finds by name, id prefix and /name', async () => {
    const id = mock.seedContainer({ name: 'dy-resolve', image: 'alpine:3.20', state: 'running' });
    const byName = await containers.resolveContainer('dy-resolve');
    assert.equal(byName?.id, id);
    const byPrefix = await containers.resolveContainer(id.slice(0, 12));
    assert.equal(byPrefix?.id, id);
    const bySlash = await containers.resolveContainer('/dy-resolve');
    assert.equal(bySlash?.id, id);
    assert.equal(await containers.resolveContainer('nope-nope'), null);
  });

  test('listContainers q filter matches name/image/id case-insensitively', async () => {
    mock.seedContainer({ name: 'FilterMe', image: 'nginx:latest', state: 'running' });
    const byName = await containers.listContainers({ q: 'filterme' });
    assert.ok(byName.some((c) => c.name === 'FilterMe'));
    const byImage = await containers.listContainers({ q: 'NGINX' });
    assert.ok(byImage.some((c) => c.image === 'nginx:latest'));
  });

  test('containerLogs demuxes stdout+stderr, containerLogsStream streams them', async () => {
    const id = mock.seedContainer({
      name: 'dy-logs',
      state: 'running',
      tty: false,
      logs: 'line one\nline two\n',
      stderrLogs: 'a warning\n',
    });
    const logs = await containers.containerLogs(id, { tail: 200 });
    assert.match(logs, /line one/);
    assert.match(logs, /a warning/);

    const stream = await containers.containerLogsStream(id, { tail: 200 });
    const streamed = await readAll(stream);
    assert.match(streamed, /line one/);
    assert.match(streamed, /a warning/);
  });

  test('containerLogs respects TTY (no framing)', async () => {
    const id = mock.seedContainer({ name: 'dy-tty', state: 'running', tty: true, logs: 'raw tty\n' });
    const logs = await containers.containerLogs(id);
    assert.equal(logs, 'raw tty\n');
  });

  test('containerStats computes from the mock frame', async () => {
    const id = mock.seedContainer({ name: 'dy-stats', state: 'running' });
    const s = await containers.containerStats(id);
    assert.equal(s.cpuPercent, 40); // (1e9/5e9)*2*100
    assert.equal(s.memUsed, 40_000_000);
    assert.equal(s.memLimit, 1_000_000_000);
    assert.equal(s.netRx, 1000);
    assert.equal(s.netTx, 2000);
    assert.equal(s.blkRead, 4096);
    assert.equal(s.blkWrite, 8192);
    assert.equal(s.pids, 5);
  });

  test('containerStatsStream returns a raw readable frame', async () => {
    const id = mock.seedContainer({ name: 'dy-stats-stream', state: 'running' });
    const stream = await containers.containerStatsStream(id);
    const raw = await readAll(stream);
    const parsed = JSON.parse(raw);
    assert.ok(parsed.cpu_stats, 'streamed frame carries cpu_stats');
    assert.ok(parsed.memory_stats, 'streamed frame carries memory_stats');
  });

  test('execInContainer returns stdout/stderr/exitCode', async () => {
    const id = mock.seedContainer({
      name: 'dy-exec',
      state: 'running',
      exec: { stdout: 'hi there\n', stderr: 'warn\n', exitCode: 3 },
    });
    const res = await containers.execInContainer(id, ['echo', 'hi there']);
    assert.equal(res.stdout, 'hi there\n');
    assert.equal(res.stderr, 'warn\n');
    assert.equal(res.exitCode, 3);
  });

  test('execInContainer times out instead of hanging', async () => {
    const id = mock.seedContainer({ name: 'dy-exec-hang', state: 'running', exec: { hang: true } });
    const res = await containers.execInContainer(id, ['sleep', '999'], { timeoutMs: 200 });
    assert.equal(res.exitCode, 124);
    assert.match(res.stderr, /timed out/);
  });

  test('createContainer pulls a missing image when pull is not disabled', async () => {
    const created = await containers.createContainer({ name: 'dy-pull-create', image: 'nginx:1.27' });
    assert.ok(created.id);
    assert.ok((await docker.listImages()).some((i) => i.repoTags.includes('nginx:1.27')));
  });

  test('images: list, pull and remove', async () => {
    const before = await docker.listImages();
    assert.ok(before.some((i) => i.repoTags.includes('alpine:3.20')));
    assert.equal(before.find((i) => i.repoTags.includes('alpine:3.20'))!.dangling, false);

    const pulled = await docker.pullImage('busybox:1.36');
    assert.equal(pulled.ref, 'busybox:1.36');
    const after = await docker.listImages();
    assert.ok(after.some((i) => i.repoTags.includes('busybox:1.36')));

    await docker.removeImage('busybox:1.36');
    const final = await docker.listImages();
    assert.ok(!final.some((i) => i.repoTags.includes('busybox:1.36')));
  });

  test('volumes and networks: create, list, remove', async () => {
    const vol = await docker.createVolume('dy-vol', { 'dockyard.managed': 'true' });
    assert.equal(vol.name, 'dy-vol');
    assert.equal(vol.labels['dockyard.managed'], 'true');
    assert.ok((await docker.listVolumes()).some((v) => v.name === 'dy-vol'));
    await docker.removeVolume('dy-vol');
    assert.ok(!(await docker.listVolumes()).some((v) => v.name === 'dy-vol'));

    const net = await docker.createNetwork('dy-net', { driver: 'bridge' });
    assert.ok(net.id);
    assert.ok((await docker.listNetworks()).some((n) => n.name === 'dy-net'));
    await docker.removeNetwork(net.id);
    assert.ok(!(await docker.listNetworks()).some((n) => n.name === 'dy-net'));
  });
});

describe('live daemon', () => {
  test('create + start + remove a real alpine:3.20 container', async (t) => {
    if (!fs.existsSync('/var/run/docker.sock')) {
      t.skip('no /var/run/docker.sock');
      return;
    }

    const script = `
      const d = await import(${JSON.stringify(dockerIndexUrl)});
      const ping = await d.dockerPing();
      if (!ping.ok) { console.log(JSON.stringify({ skipped: true, error: ping.error })); process.exit(0); }
      const name = 'dockyard-agent1-live-' + Date.now();
      const created = await d.createContainer({ name, image: 'alpine:3.20', cmd: ['sleep', '30'], pull: false });
      try {
        await d.startContainer(created.id);
        const detail = await d.getContainer(created.id);
        console.log(JSON.stringify({ ok: true, id: created.id, state: detail.state, image: detail.image }));
      } finally {
        await d.removeContainer(created.id, { force: true });
      }
      process.exit(0);
    `;

    const res = spawnSync(process.execPath, ['--input-type=module', '-e', script], {
      encoding: 'utf8',
      timeout: 60_000,
      env: { ...process.env, DOCKER_HOST: '' },
    });

    const lastLine = (res.stdout || '').trim().split('\n').filter(Boolean).pop() ?? '';
    let parsed: any = null;
    try {
      parsed = JSON.parse(lastLine);
    } catch {
      /* not JSON */
    }

    if (parsed?.skipped) {
      t.skip(`daemon unreachable: ${parsed.error}`);
      return;
    }
    assert.equal(res.status, 0, `child exited ${res.status}: ${res.stderr}`);
    assert.ok(parsed?.ok, `child output: ${res.stdout} ${res.stderr}`);
    assert.equal(parsed.state, 'running');
    assert.match(parsed.image, /alpine/);
  });
});
