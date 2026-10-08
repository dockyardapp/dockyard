// Dockyard — tunnel subsystem tests (owner: agent 3).
//
// Covers: secret storage round-trip/failure/masking, real cloudflared output parsing
// (including ANSI and a URL split across chunks), named-tunnel YAML + file modes, an opt-in
// LIVE quick tunnel fetched through its public URL (DOCKYARD_LIVE_TUNNEL_TESTS=1), and the
// manager state machine driven by a stubbed cloudflared binary against a mocked Cloudflare
// API and the real database.

import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import type { AddressInfo } from 'node:net';
import YAML from 'yaml';

import { config } from '../src/config.ts';
import { many, one, pool, query } from '../src/db/pool.ts';
import { runMigrations } from '../src/db/migrate.ts';
import {
  SecretError,
  decryptSecret,
  encryptSecret,
  fingerprint,
  maskSecret,
} from '../src/secrets.ts';
import {
  createQuickUrlScanner,
  parseCloudflaredError,
  parseQuickTunnelUrl,
  stripAnsi,
} from '../src/tunnels/url-parse.ts';
import { buildNamedTunnelConfig, slugify, writeTunnelFiles } from '../src/tunnels/named.ts';
import { startQuickTunnel } from '../src/tunnels/quick.ts';
import { spawnCloudflared } from '../src/tunnels/supervisor.ts';

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

async function waitFor(pred: () => boolean, timeoutMs: number, stepMs = 250): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (pred()) return true;
    await sleep(stepMs);
  }
  return pred();
}

function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// 1. secrets
// ---------------------------------------------------------------------------

test('secrets: AES-256-GCM round-trip, format, wrong key, mask, fingerprint', () => {
  const plain = 'cf-token-abcdef0123456789-ZZ';
  const blob = encryptSecret(plain);

  assert.match(blob, /^v1:[A-Za-z0-9+/]+={0,2}:[A-Za-z0-9+/]+={0,2}:[A-Za-z0-9+/]+={0,2}$/);
  assert.equal(blob.split(':').length, 4);
  assert.equal(decryptSecret(blob), plain);

  // Non-deterministic IV: two encryptions of the same value differ, both decrypt.
  const blob2 = encryptSecret(plain);
  assert.notEqual(blob, blob2);
  assert.equal(decryptSecret(blob2), plain);

  // Wrong key: a blob encrypted with a different 32-byte key must fail authentication.
  const iv = crypto.randomBytes(12);
  const otherKey = crypto.randomBytes(32);
  const cipher = crypto.createCipheriv('aes-256-gcm', otherKey, iv);
  const ct = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  const foreign = `v1:${iv.toString('base64')}:${tag.toString('base64')}:${ct.toString('base64')}`;
  assert.throws(() => decryptSecret(foreign), (err: unknown) => {
    assert.ok(err instanceof SecretError);
    assert.match((err as Error).message, /authentication failed|wrong key/i);
    assert.ok(!(err as Error).message.includes(plain), 'error must not echo the secret');
    return true;
  });

  // Malformed blobs.
  assert.throws(() => decryptSecret('not-a-blob'), SecretError);
  assert.throws(() => decryptSecret('v2:a:b:c'), SecretError);
  assert.throws(() => decryptSecret('v1:!!!:b:c'), SecretError);

  // Tampered ciphertext -> auth tag mismatch.
  const parts = blob.split(':');
  const tampered = `${parts[0]}:${parts[1]}:${parts[2]}:${Buffer.from('nope').toString('base64')}`;
  assert.throws(() => decryptSecret(tampered), SecretError);

  // maskSecret
  assert.equal(maskSecret(null), null);
  assert.equal(maskSecret(undefined), null);
  assert.equal(maskSecret(''), '');
  assert.equal(maskSecret('abcdefghijklmnop'), 'abcd\u2026mnop');
  const short = maskSecret('secret');
  assert.equal(short, '******');
  assert.ok(!(short as string).includes('s'), 'short values are fully masked');
  assert.ok(!(short as string).includes('e'));

  // fingerprint: first 16 hex chars of sha256
  const fp = fingerprint(plain);
  assert.equal(fp.length, 16);
  assert.match(fp, /^[0-9a-f]{16}$/);
  assert.equal(fp, crypto.createHash('sha256').update(plain).digest('hex').slice(0, 16));
  assert.equal(fingerprint(plain), fp);
});

// ---------------------------------------------------------------------------
// 2. url-parse against REAL cloudflared output
// ---------------------------------------------------------------------------

// Captured from `cloudflared tunnel --url http://127.0.0.1:9 --no-autoupdate` (v2026.9.3).
const REAL_URL = 'https://planets-conscious-suspended-nevertheless.trycloudflare.com';
const REAL_BANNER = [
  '2026-10-08T11:33:52Z INF +--------------------------------------------------------------------------------------------+',
  '2026-10-08T11:33:52Z INF |  Your quick Tunnel has been created! Visit it at (it may take some time to be reachable):  |',
  `2026-10-08T11:33:52Z INF |  ${REAL_URL}                        |`,
  '2026-10-08T11:33:52Z INF +--------------------------------------------------------------------------------------------+',
].join('\n');

// The same banner with ANSI SGR colour codes (cloudflared colours its output on a TTY).
const ANSI_BANNER = REAL_BANNER.split('\n')
  .map((l) => `\u001b[36m${l}\u001b[0m`)
  .join('\n');

test('url-parse: finds the URL in real cloudflared output, with ANSI, and split across chunks', () => {
  assert.equal(parseQuickTunnelUrl(REAL_BANNER), REAL_URL);
  assert.equal(parseQuickTunnelUrl(ANSI_BANNER), REAL_URL);
  assert.match(stripAnsi('\u001b[31mERR\u001b[0m'), /^ERR$/);
  assert.equal(parseQuickTunnelUrl('INF Requesting new quick Tunnel...'), null);
  assert.equal(parseQuickTunnelUrl(''), null);

  // URL split across two chunks: the pure parser sees only complete input; the rolling
  // scanner reassembles the fragments and yields the URL.
  const full = `INF |  ${REAL_URL}  |\n`;
  const cut = full.indexOf(REAL_URL) + 20;
  const chunkA = full.slice(0, cut);
  const chunkB = full.slice(cut);
  assert.equal(parseQuickTunnelUrl(chunkA), null);

  const scanner = createQuickUrlScanner();
  assert.equal(scanner.push(chunkA), null);
  assert.equal(scanner.push(chunkB), REAL_URL);

  // A whole line split mid-URL but delivered as one buffer still resolves.
  assert.equal(parseQuickTunnelUrl(chunkA + chunkB), REAL_URL);
});

test('url-parse: recognises real failure lines but ignores WRN/INF noise', () => {
  // Both ERR lines below were captured live from cloudflared 2026.9.3.
  const realErr1 =
    '2026-10-08T11:34:26Z ERR Couldn\'t start tunnel error="unknown protocol bogus, Available protocols: \'auto\' ..."';
  const realErr2 =
    '2026-10-08T11:34:35Z ERR Failed to dial a quic connection error="failed to dial to edge with quic: timeout: no recent network activity" connIndex=0 event=0 ip=127.0.0.1';
  const specErr =
    '2026-10-08T11:35:00Z ERR Failed to request quick Tunnel: Post "https://api.trycloudflare.com/tunnel": dial tcp: lookup api.trycloudflare.com: no such host';

  const e1 = parseCloudflaredError(realErr1);
  assert.ok(e1 && e1.includes("Couldn't start tunnel"), e1 ?? 'null');
  const e2 = parseCloudflaredError(realErr2);
  assert.ok(e2 && e2.includes('Failed to dial a quic connection'), e2 ?? 'null');
  const e3 = parseCloudflaredError(specErr);
  assert.ok(e3 && /failed to request quick Tunnel/i.test(e3), e3 ?? 'null');
  // Timestamp is stripped from the returned message.
  assert.ok(e1 && !e1.startsWith('2026-'));

  // Real WRN/INF lines with `error=` must NOT be treated as fatal.
  const warn =
    '2026-10-08T11:33:52Z WRN ICMP proxy feature is disabled error="cannot create ICMPv4 proxy: Group ID 0 is not between ping group 65534 to 65534 nor ICMPv6 proxy: socket: permission denied"';
  assert.equal(parseCloudflaredError(warn), null);
  assert.equal(
    parseCloudflaredError('2026-10-08T11:33:52Z INF Initial protocol quic'),
    null,
  );
});

// ---------------------------------------------------------------------------
// 3. named tunnel files
// ---------------------------------------------------------------------------

test('named: slugify, YAML config round-trip, credentials written mode 0600', async () => {
  assert.equal(slugify('My App Tunnel!'), 'my-app-tunnel');
  assert.equal(slugify('  --weird__name--  '), 'weird-name');
  assert.equal(slugify('###'), 'tunnel');
  assert.equal(slugify(''), 'tunnel');

  const yamlText = buildNamedTunnelConfig({
    tunnelId: '11111111-2222-3333-4444-555555555555',
    credentialsFile: '/tmp/creds.json',
    hostname: 'app.example.com',
    service: 'http://127.0.0.1:8080',
  });
  const parsed = YAML.parse(yamlText) as {
    tunnel: string;
    'credentials-file': string;
    ingress: Array<Record<string, string>>;
  };
  assert.equal(parsed.tunnel, '11111111-2222-3333-4444-555555555555');
  assert.equal(parsed['credentials-file'], '/tmp/creds.json');
  assert.equal(parsed.ingress.length, 2);
  assert.equal(parsed.ingress[0].hostname, 'app.example.com');
  assert.equal(parsed.ingress[0].service, 'http://127.0.0.1:8080');
  assert.equal(parsed.ingress[parsed.ingress.length - 1].service, 'http_status:404');

  // Write into a scratch dir by temporarily pointing config at it.
  const savedDir = config.tunnelDataDir;
  const tmp = await fsp.mkdtemp(path.join(os.tmpdir(), 'dy-named-'));
  config.tunnelDataDir = tmp;
  try {
    const { credentialsPath, configPath } = await writeTunnelFiles(
      'demo',
      { AccountTag: 'a', TunnelID: 'b', TunnelSecret: 'c' },
      yamlText,
    );
    assert.ok(fs.existsSync(credentialsPath));
    assert.ok(fs.existsSync(configPath));
    assert.equal(fs.statSync(credentialsPath).mode & 0o777, 0o600);
    assert.equal(fs.statSync(configPath).mode & 0o777, 0o644);
    const creds = JSON.parse(fs.readFileSync(credentialsPath, 'utf8')) as Record<string, string>;
    assert.equal(creds.TunnelID, 'b');
    assert.ok(YAML.parse(fs.readFileSync(configPath, 'utf8')));
  } finally {
    config.tunnelDataDir = savedDir;
    await fsp.rm(tmp, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// 3b. supervisor: missing binary reports a clear error, not an unhandled throw
// ---------------------------------------------------------------------------

test('supervisor: a missing cloudflared binary reports ENOENT cleanly', async () => {
  const saved = config.cloudflaredBin;
  config.cloudflaredBin = '/nonexistent/definitely-not-cloudflared';
  try {
    const lines: string[] = [];
    const proc = spawnCloudflared(['tunnel', '--url', 'http://127.0.0.1:9'], {
      onLine: (line) => lines.push(line),
    });
    const exit = await new Promise<{ code: number | null }>((resolve) => {
      proc.onExit((code) => resolve({ code }));
    });
    assert.equal(exit.code, 127);
    assert.ok(
      lines.some((l) => /not found|ENOENT/i.test(l)),
      `expected an ENOENT message, got: ${JSON.stringify(lines)}`,
    );
  } finally {
    config.cloudflaredBin = saved;
  }
});

// ---------------------------------------------------------------------------
// 4. LIVE quick tunnel end to end
// ---------------------------------------------------------------------------
//
// Opt-in, because it needs more than "the internet is up": it needs a public
// trycloudflare.com hostname to route back to this machine. A sandbox that can
// reach api.cloudflare.com and still cannot be reached inbound passes the probe
// below and then fails on the fetch, which reads as a broken tunnel. Set
// DOCKYARD_LIVE_TUNNEL_TESTS=1 (npm run test:live) to include it.

const LIVE_ENABLED = process.env.DOCKYARD_LIVE_TUNNEL_TESTS === '1';

test('LIVE: quick tunnel is reachable through its public URL, then stops', { timeout: 180_000 }, async (t) => {
  if (!LIVE_ENABLED) {
    t.skip('live tunnel test is opt-in — set DOCKYARD_LIVE_TUNNEL_TESTS=1 to run it');
    return;
  }

  // Probe outbound internet; skip rather than fail when there is none.
  let online = false;
  try {
    const res = await fetch('https://api.cloudflare.com/client/v4/user/tokens/verify', {
      signal: AbortSignal.timeout(10_000),
    });
    online = res.status > 0;
  } catch {
    online = false;
  }
  if (!online) {
    t.skip('outbound internet unavailable — live quick-tunnel test skipped');
    return;
  }

  const marker = `DOCKYARD_LIVE_${crypto.randomBytes(6).toString('hex')}`;
  const server = http.createServer((_req, res) => {
    res.writeHead(200, { 'content-type': 'text/plain' });
    res.end(`hello from the local dockyard test server ${marker}`);
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as AddressInfo).port;

  let proc: { pid: number | null; kill: () => void } | null = null;
  try {
    const quick = await startQuickTunnel(`http://127.0.0.1:${port}`, { timeoutMs: 60_000 });
    proc = quick.process;
    console.log(`LIVE_TUNNEL_URL=${quick.url}`);
    assert.match(quick.url, /^https:\/\/[a-z0-9-]+\.trycloudflare\.com$/);

    const pid = quick.process.pid;
    assert.ok(pid && pid > 0, 'cloudflared has a pid');
    assert.ok(pidAlive(pid as number), 'cloudflared is alive after reporting the URL');

    // Fetch through the public URL until the tunnel is reachable.
    let body = '';
    let reached = false;
    for (let attempt = 0; attempt < 25 && !reached; attempt++) {
      try {
        const res = await fetch(quick.url, { signal: AbortSignal.timeout(10_000) });
        body = await res.text();
        reached = res.ok;
      } catch {
        reached = false;
      }
      if (!reached) await sleep(2_000);
    }
    assert.ok(reached, `public URL did not become reachable: ${quick.url}`);
    assert.ok(body.includes(marker), 'the request reached the local test server through the tunnel');
    console.log(`LIVE_FETCH_BODY=${body}`);
  } finally {
    const pid = proc?.pid ?? null;
    if (proc) proc.kill();
    if (pid) {
      const gone = await waitFor(() => !pidAlive(pid), 12_000);
      assert.ok(gone, 'cloudflared process is gone after kill');
    }
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

// ---------------------------------------------------------------------------
// 5. manager state machine: stubbed cloudflared + mocked Cloudflare API + real DB
// ---------------------------------------------------------------------------

test('manager: named + quick lifecycle against the real DB with a stub binary', { timeout: 120_000 }, async () => {
  await runMigrations();

  const { tunnelManager } = await import('../src/tunnels/manager.ts');
  const { encryptSecret } = await import('../src/secrets.ts');

  // --- stub cloudflared: prints a quick URL for --url, otherwise just stays alive ---
  const binDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'dy-cf-stub-'));
  const stubBin = path.join(binDir, 'cloudflared');
  await fsp.writeFile(
    stubBin,
    [
      '#!/bin/sh',
      'for a in "$@"; do',
      '  if [ "$a" = "--url" ]; then',
      '    echo "INF |  https://stub-tunnel-dockyard-test.trycloudflare.com |" 1>&2',
      '  fi',
      'done',
      "trap 'exit 0' TERM INT",
      'while true; do sleep 0.5; done',
      '',
    ].join('\n'),
    { mode: 0o755 },
  );

  // --- mock Cloudflare API ---
  const calls: string[] = [];
  const mock = http.createServer((req, res) => {
    req.resume();
    const url = new URL(req.url ?? '/', 'http://localhost');
    const p = url.pathname;
    calls.push(`${req.method} ${p}`);
    const send = (result: unknown): void => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ success: true, result, errors: [], messages: [] }));
    };
    if (p === '/user/tokens/verify') return send({ id: 'tok1', status: 'active' });
    if (p === '/accounts') return send([{ id: 'acct1', name: 'Test Account' }]);
    if (p === '/zones') return send([{ id: 'zone1', name: 'example.com', account: { id: 'acct1' } }]);
    if (p === '/accounts/acct1/cfd_tunnel' && req.method === 'POST') {
      return send({ id: 'tun-123', name: 'dy-test' });
    }
    if (p === '/accounts/acct1/cfd_tunnel' && req.method === 'GET') return send([]);
    if (p === '/accounts/acct1/cfd_tunnel/tun-123/token') {
      const token = Buffer.from(
        JSON.stringify({ a: 'acct1', t: 'tun-123', s: 'c2VjcmV0' }),
      ).toString('base64');
      return send(token);
    }
    if (p === '/accounts/acct1/cfd_tunnel/tun-123' && req.method === 'DELETE') return send({});
    if (p === '/zones/zone1/dns_records' && req.method === 'POST') return send({ id: 'dns-1' });
    res.writeHead(404, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ success: false, result: null, errors: [{ code: 0, message: `no route ${p}` }] }));
  });
  await new Promise<void>((resolve) => mock.listen(0, '127.0.0.1', resolve));
  const mockPort = (mock.address() as AddressInfo).port;

  // --- save + set environment/config; snapshot any existing CF settings ---
  const savedBin = config.cloudflaredBin;
  const savedDir = config.tunnelDataDir;
  const savedBase = process.env.CLOUDFLARE_API_BASE;
  const tmpTunnels = await fsp.mkdtemp(path.join(os.tmpdir(), 'dy-tunnels-'));
  const priorSettings = await many<{ key: string; value: unknown; secret: boolean }>(
    'select key, value, secret from settings where key in ($1, $2)',
    ['cloudflare.api_token', 'cloudflare.account_id'],
  );

  config.cloudflaredBin = stubBin;
  config.tunnelDataDir = tmpTunnels;
  process.env.CLOUDFLARE_API_BASE = `http://127.0.0.1:${mockPort}`;

  const uniq = crypto.randomBytes(4).toString('hex');
  const namedName = `dy-named-${uniq}`;

  try {
    // Store credentials the way the settings route would.
    await query(
      `insert into settings (key, value, secret, updated_at) values ($1, $2, true, now())
       on conflict (key) do update set value = excluded.value, secret = true, updated_at = now()`,
      ['cloudflare.api_token', JSON.stringify(encryptSecret('mock-cf-token-123'))],
    );
    await query(
      `insert into settings (key, value, secret, updated_at) values ($1, $2, false, now())
       on conflict (key) do update set value = excluded.value, secret = false, updated_at = now()`,
      ['cloudflare.account_id', JSON.stringify('acct1')],
    );

    // ---- named tunnel: create (auto-starts) ----
    const created = await tunnelManager.create({
      name: namedName,
      mode: 'named',
      hostname: 'tunnel.example.com',
      zone_id: 'zone1',
      target_url: 'http://127.0.0.1:9999',
    });
    assert.equal(created.mode, 'named');
    assert.equal(created.status, 'running');
    assert.equal(created.url, 'https://tunnel.example.com');
    assert.ok(created.tunnel_id, 'tunnel_id assigned from the API');
    assert.ok(created.pid && created.pid > 0, 'cloudflared has a pid');

    const row = await one<{
      status: string;
      tunnel_id: string;
      credentials_path: string;
      config_path: string;
      pid: number | null;
      url: string | null;
    }>('select status, tunnel_id, credentials_path, config_path, pid, url from tunnels where id = $1', [
      created.id,
    ]);
    assert.ok(row);
    assert.equal(row.status, 'running');
    assert.equal(row.tunnel_id, 'tun-123');
    assert.ok(row.credentials_path && fs.existsSync(row.credentials_path), 'credentials.json exists');
    assert.ok(row.config_path && fs.existsSync(row.config_path), 'config.yml exists');
    assert.equal(fs.statSync(row.credentials_path).mode & 0o777, 0o600, 'credentials mode 0600');

    const cfg = YAML.parse(fs.readFileSync(row.config_path, 'utf8')) as {
      tunnel: string;
      ingress: Array<Record<string, string>>;
    };
    assert.equal(cfg.tunnel, 'tun-123');
    assert.equal(cfg.ingress[0].hostname, 'tunnel.example.com');
    assert.equal(cfg.ingress[cfg.ingress.length - 1].service, 'http_status:404');
    const creds = JSON.parse(fs.readFileSync(row.credentials_path, 'utf8')) as Record<string, string>;
    assert.equal(creds.TunnelID, 'tun-123');
    assert.equal(creds.TunnelSecret, 'c2VjcmV0');

    assert.ok(calls.some((c) => c === 'POST /accounts/acct1/cfd_tunnel'), 'cfCreateTunnel called');
    assert.ok(calls.some((c) => c === 'POST /zones/zone1/dns_records'), 'cfRouteDns called');

    // reconcile() must leave a live process alone.
    await tunnelManager.reconcile();
    const stillRunning = await one<{ status: string }>('select status from tunnels where id = $1', [
      created.id,
    ]);
    assert.equal(stillRunning?.status, 'running');

    // ---- stop ----
    const namedPid = created.pid as number;
    const stopped = await tunnelManager.stop(created.id);
    assert.equal(stopped.status, 'stopped');
    assert.equal(stopped.pid, null);
    assert.equal(stopped.url, null);
    assert.ok(await waitFor(() => !pidAlive(namedPid), 10_000), 'named process gone after stop');

    // ---- remove (deletes the CF tunnel + files) ----
    const filesDir = path.dirname(row.credentials_path);
    await tunnelManager.remove(created.id);
    assert.equal(await one('select 1 from tunnels where id = $1', [created.id]), null);
    assert.ok(
      calls.some((c) => c === 'DELETE /accounts/acct1/cfd_tunnel/tun-123'),
      'cfDeleteTunnel called',
    );
    assert.equal(fs.existsSync(filesDir), false, 'tunnel files removed');

    // ---- quick tunnel through the stub ----
    const quick = await tunnelManager.create({
      name: `dy-quick-${uniq}`,
      mode: 'quick',
      target_url: 'http://127.0.0.1:9999',
    });
    assert.equal(quick.mode, 'quick');
    assert.equal(quick.status, 'running');
    assert.match(quick.url ?? '', /^https:\/\/stub-tunnel-dockyard-test\.trycloudflare\.com$/);
    const quickPid = quick.pid as number;
    assert.ok(quickPid > 0);
    const quickStopped = await tunnelManager.stop(quick.id);
    assert.equal(quickStopped.status, 'stopped');
    assert.ok(await waitFor(() => !pidAlive(quickPid), 10_000), 'quick stub process gone');
    await tunnelManager.remove(quick.id);
    assert.equal(await one('select 1 from tunnels where id = $1', [quick.id]), null);

    // ---- reconcile marks a stale 'running' row stopped ----
    const stale = await one<{ id: string }>(
      `insert into tunnels (name, mode, target_url, status) values ($1, 'quick', 'http://127.0.0.1:9', 'running') returning id`,
      [`dy-stale-${uniq}`],
    );
    assert.ok(stale);
    await tunnelManager.reconcile();
    const staleRow = await one<{ status: string }>('select status from tunnels where id = $1', [stale.id]);
    assert.equal(staleRow?.status, 'stopped');
  } finally {
    config.cloudflaredBin = savedBin;
    config.tunnelDataDir = savedDir;
    if (savedBase === undefined) delete process.env.CLOUDFLARE_API_BASE;
    else process.env.CLOUDFLARE_API_BASE = savedBase;

    await query("delete from tunnels where name like 'dy-%'").catch(() => undefined);
    await query('delete from settings where key in ($1, $2)', [
      'cloudflare.api_token',
      'cloudflare.account_id',
    ]).catch(() => undefined);
    for (const row of priorSettings) {
      await query(
        `insert into settings (key, value, secret, updated_at) values ($1, $2, $3, now())
         on conflict (key) do update set value = excluded.value, secret = excluded.secret, updated_at = now()`,
        [row.key, JSON.stringify(row.value), row.secret],
      ).catch(() => undefined);
    }

    await new Promise<void>((resolve) => mock.close(() => resolve()));
    await fsp.rm(binDir, { recursive: true, force: true });
    await fsp.rm(tmpTunnels, { recursive: true, force: true });
  }
});

test('routes: tunnels + settings register the frozen paths and roles', async () => {
  const Fastify = (await import('fastify')).default;
  const { default: tunnelRoutes } = await import('../src/routes/tunnels.ts');
  const { default: settingsRoutes } = await import('../src/routes/settings.ts');

  const app = Fastify({ logger: false });
  await app.register(tunnelRoutes);
  await app.register(settingsRoutes);
  await app.ready();

  const expected: Array<[string, string]> = [
    ['GET', '/api/tunnels'],
    ['POST', '/api/tunnels'],
    ['GET', '/api/tunnels/:id'],
    ['POST', '/api/tunnels/:id/:action'],
    ['DELETE', '/api/tunnels/:id'],
    ['GET', '/api/settings'],
    ['PATCH', '/api/settings'],
    ['GET', '/api/cloudflare/status'],
    ['POST', '/api/cloudflare/credentials'],
    ['DELETE', '/api/cloudflare/credentials'],
  ];
  for (const [method, url] of expected) {
    assert.ok(app.hasRoute({ method: method as 'GET', url }), `missing route ${method} ${url}`);
  }
  await app.close();
});

after(async () => {
  await pool.end().catch(() => undefined);
});
