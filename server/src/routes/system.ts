// Dockyard — system routes (owner: agent 2). Mounted under /api.
//
//   GET /system/health  public                          -> { ok: true, uptime }
//   GET /system/info    public (redacted when anon)     -> SystemInfo
//
// Contract §6 note: `/api/system/info` is reachable unauthenticated so the login screen can
// show host status, but for an anonymous caller `counts` is zeroed and `docker.containers`
// is omitted. `mode` is 'demo' whenever the Docker engine is unreachable.

import { execFile } from 'node:child_process';
import type { FastifyInstance } from 'fastify';
import { config } from '../config.ts';
import { buildInfo } from '../version.ts';
import { checkForUpdate, getCheck } from '../update/check.ts';
import { readJob, updaterInfo, writeRequest } from '../update/spool.ts';
import { logger } from '../logger.ts';
import { one } from '../db/pool.ts';
import { many } from '../db/pool.ts';
import { dbHealth } from '../db/pool.ts';
import { dockerPing, listContainers, listImages, listNetworks, listVolumes } from '../docker/index.ts';
import { listStacks } from '../stacks.ts';
import { tunnelManager } from '../tunnels/manager.ts';
import { filterTunnels } from '../tunnels/visibility.ts';
import { authenticate } from '../auth/sessions.ts';
import { auditFromRequest } from '../auth/audit.ts';
import { can, requireAuth, requireRole, sendError } from '../auth/rbac.ts';
import { canSee, filterVisible, isUnrestricted } from '../auth/scope.ts';
import type { Scope } from '../auth/scope.ts';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

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

type Counts = {
  containers: number;
  running: number;
  images: number;
  volumes: number;
  networks: number;
  tunnels: number;
  tunnelsActive: number;
  stacks: number;
  templates: number;
};

const ZERO_COUNTS: Counts = {
  containers: 0,
  running: 0,
  images: 0,
  volumes: 0,
  networks: 0,
  tunnels: 0,
  tunnelsActive: 0,
  stacks: 0,
  templates: 0,
};

/**
 * Dashboard counts for a scoped user.
 *
 * These have to be recomputed rather than read off the engine, because the
 * totals in `dockerPing()` describe the whole host. Leaving them unscoped would
 * leak the size of everything the user cannot see — the counts are the one place
 * scoping is easy to forget.
 */
async function scopedCounts(scope: Scope): Promise<Counts> {
  const [containers, images, volumes, networks, stacks, tunnels, templates] = await Promise.all([
    listContainers({ all: true }).catch(() => []),
    listImages().catch(() => []),
    listVolumes().catch(() => []),
    listNetworks().catch(() => []),
    listStacks().catch(() => []),
    tunnelManager.list().catch(() => []),
    safeRows('select id, slug from templates'),
  ]);

  const visibleContainers = filterVisible(scope, 'container', containers, (c) => ({
    id: c.id,
    name: c.name,
    labels: c.labels,
  }));
  const visibleStacks = stacks.filter(
    (s) =>
      canSee(scope, 'stack', { id: s.id, name: s.name, slug: s.slug }) ||
      s.containers.some((c) =>
        canSee(scope, 'container', { id: c.id, name: c.name, labels: c.labels }),
      ),
  );
  const visibleTunnels = await filterTunnels(scope, tunnels);

  return {
    containers: visibleContainers.length,
    running: visibleContainers.filter((c) => c.state === 'running').length,
    images: filterVisible(scope, 'image', images, (i) => ({ id: i.id, repoTags: i.repoTags })).length,
    volumes: filterVisible(scope, 'volume', volumes, (v) => ({ name: v.name, labels: v.labels })).length,
    networks: filterVisible(scope, 'network', networks, (n) => ({ name: n.name, labels: n.labels })).length,
    tunnels: visibleTunnels.length,
    tunnelsActive: visibleTunnels.filter((t) => t.status === 'running').length,
    stacks: visibleStacks.length,
    templates: filterVisible(scope, 'template', templates, (t) => ({ id: t.id, slug: t.slug })).length,
  };
}

async function safeRows(sql: string): Promise<Array<{ id: string; slug: string }>> {
  try {
    return await many<{ id: string; slug: string }>(sql);
  } catch {
    return [];
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

    let counts: Counts;
    if (!authed) {
      counts = { ...ZERO_COUNTS };
    } else if (isUnrestricted(req.scope)) {
      counts = {
        containers: docker.containers?.total ?? 0,
        running: docker.containers?.running ?? 0,
        images: docker.images ?? 0,
        volumes: await safeLen(() => listVolumes()),
        networks: await safeLen(() => listNetworks()),
        tunnels: await safeCount('select count(*)::int as n from tunnels'),
        tunnelsActive: await safeCount("select count(*)::int as n from tunnels where status = 'running'"),
        stacks: await safeCount('select count(*)::int as n from stacks'),
        templates: await safeCount('select count(*)::int as n from templates'),
      };
    } else {
      counts = await scopedCounts(req.scope);
      // The engine totals describe the whole host, so a scoped caller must not
      // receive them either.
      if (docker.containers !== undefined) {
        dockerOut.containers = { total: counts.containers, running: counts.running };
      }
      if (docker.images !== undefined) dockerOut.images = counts.images;
    }

    const info = {
      version: buildInfo.version,
      build: buildInfo,
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

  // -------------------------------------------------------------------------
  // Version and updates
  // -------------------------------------------------------------------------

  /**
   * What is running, what is upstream, and how the last update went.
   *
   * Requires a session, unlike `/system/info`: an anonymous caller has no use for it and every
   * read drives a GitHub API call against a shared rate limit.
   *
   * Always 200 with `build` present, even when GitHub cannot be reached: the caller draws the
   * running version from this same payload, so a failed check must not blank the UI.
   */
  app.get('/system/update', { preHandler: requireAuth() }, async (req, reply) => {
    const check = await getCheck();
    return reply.code(200).send({
      build: buildInfo,
      check,
      job: readJob(),
      updater: updaterInfo(),
      canUpdate: can(req.user?.role ?? null, 'admin'),
    });
  });

  /**
   * Ask the host to update.
   *
   * The panel does not rebuild itself: it writes a request the host updater picks up. Refusing
   * when nothing would collect the request is the whole point — a button that silently does
   * nothing is worse than a disabled one.
   */
  app.post('/system/update', { preHandler: requireRole('admin') }, async (req, reply) => {
    if (!config.updateEnabled) {
      return sendError(reply, 409, 'conflict', 'updates are disabled on this host (DOCKYARD_UPDATE_ENABLED=false)');
    }

    const updater = updaterInfo();
    if (!updater.installed) {
      return sendError(
        reply,
        409,
        'conflict',
        'no updater is installed on this host, so a request would never be collected. Run ' +
          'deploy/install-updater.sh on the host, or deploy/update.sh to update by hand.',
      );
    }

    const check = await checkForUpdate(true);
    if (check.error) {
      // The frozen code list has no "upstream unreachable" entry, and a new code would be a
      // contract change for a transient condition. The refusal is reported as a conflict with
      // the cause in the message; GET /system/update carries the detail.
      return sendError(reply, 409, 'conflict', `could not check for updates: ${check.error}`);
    }
    if (check.status === 'current') {
      return sendError(reply, 409, 'conflict', `this build is already the tip of ${check.branch}`);
    }
    if (check.status === 'ahead' || check.status === 'diverged') {
      return sendError(
        reply,
        409,
        'conflict',
        `this build is ${check.status} of ${check.branch}, so pulling the branch tip would not ` +
          'fast-forward. Update the checkout by hand.',
      );
    }
    if (check.status === 'unknown') {
      return sendError(
        reply,
        409,
        'conflict',
        'the running commit could not be compared with the branch tip, so an update cannot be ' +
          'shown to be a fast-forward.',
      );
    }

    const request = writeRequest({
      branch: config.updateBranch,
      by: req.user?.email ?? 'unknown',
      version: buildInfo.version,
      commit: buildInfo.commit,
    });
    await auditFromRequest(req, 'system.update', 'system', request.id, {
      branch: request.branch,
      from: buildInfo.commitShort || null,
      to: check.latest?.commitShort ?? null,
      behindBy: check.behindBy,
    });

    return reply.code(202).send({ requested: true, request, job: readJob() });
  });
}
