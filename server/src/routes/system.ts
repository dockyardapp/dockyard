// Dockyard — system routes (owner: agent 2). Mounted under /api.
//
//   GET /system/health  public                          -> { ok: true, uptime }
//   GET /system/info    public (redacted when anon)     -> SystemInfo
//
// Contract §6 note: `/api/system/info` is reachable unauthenticated so the login screen can
// show host status, but for an anonymous caller `counts` is zeroed and `docker.containers`
// is omitted. `mode` is 'demo' whenever the Docker engine is unreachable.

import { execFile } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import type { FastifyInstance } from 'fastify';
import { config, repoRoot } from '../config.ts';
import { logger } from '../logger.ts';
import { one } from '../db/pool.ts';
import { dbHealth } from '../db/pool.ts';
import { dockerPing, listNetworks, listVolumes } from '../docker/index.ts';
import { authenticate } from '../auth/sessions.ts';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

let cachedVersion: string | null = null;
function appVersion(): string {
  if (cachedVersion) return cachedVersion;
  for (const rel of ['package.json', path.join('server', 'package.json')]) {
    try {
      const pkg = JSON.parse(fs.readFileSync(path.join(repoRoot, rel), 'utf8')) as { version?: string };
      if (pkg.version) {
        cachedVersion = String(pkg.version);
        return cachedVersion;
      }
    } catch {
      /* try the next candidate */
    }
  }
  cachedVersion = '0.0.0';
  return cachedVersion;
}

type CloudflaredInfo = { ok: boolean; version?: string; path: string; error?: string };
let cloudflaredCache: { at: number; value: CloudflaredInfo } | null = null;

function probeCloudflared(): Promise<CloudflaredInfo> {
  if (cloudflaredCache && Date.now() - cloudflaredCache.at < 30_000) return Promise.resolve(cloudflaredCache.value);
  const bin = config.cloudflaredBin;
  return new Promise((resolve) => {
    execFile(bin, ['--version'], { timeout: 4000 }, (err, stdout, stderr) => {
      let value: CloudflaredInfo;
      if (err) {
        value = { ok: false, path: bin, error: (err as NodeJS.ErrnoException).code ?? err.message };
      } else {
        const out = `${stdout ?? ''}\n${stderr ?? ''}`.trim();
        const m = /cloudflared version (\S+)/i.exec(out) ?? /(\d+\.\d+\.\d+\S*)/.exec(out);
        value = { ok: true, path: bin, version: m ? m[1] : out.split('\n')[0] || undefined };
      }
      cloudflaredCache = { at: Date.now(), value };
      resolve(value);
    });
  });
}

async function readSettingString(key: string): Promise<string | null> {
  try {
    const row = await one<{ value: unknown }>('select value from settings where key = $1', [key]);
    if (!row) return null;
    const v = row.value as unknown;
    if (typeof v === 'string') return v;
    if (v && typeof v === 'object' && typeof (v as { value?: unknown }).value === 'string') {
      return (v as { value: string }).value;
    }
    return null;
  } catch {
    return null;
  }
}

type CloudflareStatus = { configured: boolean; verified: boolean; accountId: string | null; error?: string };
let cfVerifyCache: { at: number; verified: boolean; error?: string } | null = null;

async function cloudflareStatus(): Promise<CloudflareStatus> {
  const token = (await readSettingString('cloudflare.api_token')) ?? (config.cloudflareApiToken || null);
  const accountId = (await readSettingString('cloudflare.account_id')) ?? (config.cloudflareAccountId || null);
  const configured = Boolean(token && accountId);
  if (!configured) return { configured: false, verified: false, accountId: accountId ?? null };

  if (cfVerifyCache && Date.now() - cfVerifyCache.at < 60_000) {
    return { configured: true, verified: cfVerifyCache.verified, accountId, ...(cfVerifyCache.error ? { error: cfVerifyCache.error } : {}) };
  }

  try {
    const spec = '../cloudflare/api.ts';
    const mod: any = await import(spec);
    const fn = mod?.cfVerifyToken;
    if (typeof fn !== 'function') {
      cfVerifyCache = { at: Date.now(), verified: false };
      return { configured: true, verified: false, accountId };
    }
    const res = await fn();
    const verified = Boolean(res?.ok);
    cfVerifyCache = { at: Date.now(), verified, error: res?.error };
    return { configured: true, verified, accountId, ...(res?.error ? { error: String(res.error) } : {}) };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    cfVerifyCache = { at: Date.now(), verified: false, error: message };
    return { configured: true, verified: false, accountId, error: message };
  }
}

async function safeCount(sql: string): Promise<number> {
  try {
    const row = await one<{ n: number }>(sql);
    return Number(row?.n ?? 0);
  } catch {
    return 0;
  }
}

async function safeLen(fn: () => Promise<unknown[]>): Promise<number> {
  try {
    return (await fn()).length;
  } catch {
    return 0;
  }
}

// ---------------------------------------------------------------------------
// Routes
// ---------------------------------------------------------------------------

export default async function systemRoutes(app: FastifyInstance): Promise<void> {
  app.get('/system/health', async (_req, reply) => {
    return reply.code(200).send({ ok: true, uptime: Math.round(process.uptime()) });
  });

  app.get('/system/info', { preHandler: authenticate }, async (req, reply) => {
    const authed = Boolean(req.user);

    const [docker, db, cloudflared, cloudflare] = await Promise.all([
      dockerPing(),
      dbHealth(),
      probeCloudflared(),
      cloudflareStatus(),
    ]);

    const dockerOut: Record<string, unknown> = { ok: docker.ok };
    if (docker.version !== undefined) dockerOut.version = docker.version;
    if (docker.apiVersion !== undefined) dockerOut.apiVersion = docker.apiVersion;
    if (docker.os !== undefined) dockerOut.os = docker.os;
    if (docker.arch !== undefined) dockerOut.arch = docker.arch;
    if (docker.error !== undefined) dockerOut.error = docker.error;
    if (authed) {
      if (docker.containers !== undefined) dockerOut.containers = docker.containers;
      if (docker.images !== undefined) dockerOut.images = docker.images;
    }

    const counts = authed
      ? {
          containers: docker.containers?.total ?? 0,
          running: docker.containers?.running ?? 0,
          images: docker.images ?? 0,
          volumes: await safeLen(() => listVolumes()),
          networks: await safeLen(() => listNetworks()),
          tunnels: await safeCount('select count(*)::int as n from tunnels'),
          tunnelsActive: await safeCount("select count(*)::int as n from tunnels where status = 'running'"),
          stacks: await safeCount('select count(*)::int as n from stacks'),
          templates: await safeCount('select count(*)::int as n from templates'),
        }
      : { containers: 0, running: 0, images: 0, volumes: 0, networks: 0, tunnels: 0, tunnelsActive: 0, stacks: 0, templates: 0 };

    const info = {
      version: appVersion(),
      uptime: Math.round(process.uptime()),
      publicUrl: config.publicUrl,
      docker: dockerOut,
      db: { ok: db.ok, ...(db.serverVersion ? { serverVersion: db.serverVersion } : {}), ...(db.error ? { error: db.error } : {}) },
      cloudflared,
      cloudflare: { configured: cloudflare.configured, verified: cloudflare.verified, accountId: cloudflare.accountId },
      counts,
      mode: (docker.ok ? 'real' : 'demo') as 'real' | 'demo',
    };

    if (!docker.ok) logger.debug('system info: docker unreachable', { error: docker.error });
    return reply.code(200).send(info);
  });
}
