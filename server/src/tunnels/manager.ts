// Dockyard — tunnel manager (owner: agent 3).
//
// One supervisor for both modes. The DB `tunnels` row is the durable record; an in-memory
// map holds the live child process. Every state change updates the row and publishes a
// `{ type: 'tunnel', action, data }` event on the bus.
//
//   quick  — cloudflared prints an ephemeral trycloudflare URL; the tunnel dies with it.
//   named  — cfCreateTunnel -> cfGetTunnelToken -> write files -> `cloudflared tunnel
//            --config <config.yml> run <name>` -> cfRouteDns.

import path from 'node:path';
import { config } from '../config.ts';
import { logger } from '../logger.ts';
import { many, one, query } from '../db/pool.ts';
import { bus } from '../events.ts';
import { listContainers, resolveContainer } from '../docker/index.ts';
import type { ContainerSummary } from '../docker/index.ts';
import {
  CloudflareError,
  cfCreateTunnel,
  cfDeleteTunnel,
  cfGetTunnelToken,
  cfRouteDns,
  resolveCreds,
} from '../cloudflare/api.ts';
import {
  buildNamedTunnelConfig,
  removeTunnelFiles,
  slugify,
  writeTunnelFiles,
} from './named.ts';
import { startQuickTunnel } from './quick.ts';
import { spawnCloudflared } from './supervisor.ts';
import type { SpawnedTunnel } from './supervisor.ts';

export type TunnelMode = 'quick' | 'named';
export type TunnelStatus = 'stopped' | 'starting' | 'running' | 'error';

export type Tunnel = {
  id: string;
  name: string;
  mode: TunnelMode;
  target_url: string;
  container_id: string | null;
  container_name: string | null;
  port: number | null;
  hostname: string | null;
  tunnel_id: string | null;
  status: TunnelStatus;
  url: string | null;
  pid: number | null;
  last_error: string | null;
  auto_start: boolean;
  created_at: string;
  updated_at: string;
};

export type CreateTunnelInput = {
  name: string;
  mode: TunnelMode;
  target_url?: string;
  container_id?: string;
  port?: number;
  hostname?: string;
  zone_id?: string;
  auto_start?: boolean;
};

export class TunnelError extends Error {
  statusCode: number;
  code: string;

  constructor(message: string, statusCode = 500, code = 'internal') {
    super(message);
    this.name = 'TunnelError';
    this.statusCode = statusCode;
    this.code = code;
  }
}

type TunnelRow = {
  id: string;
  name: string;
  mode: TunnelMode;
  target_url: string;
  container_id: string | null;
  port: number | null;
  hostname: string | null;
  zone_id: string | null;
  tunnel_id: string | null;
  credentials_path: string | null;
  config_path: string | null;
  status: TunnelStatus;
  url: string | null;
  pid: number | null;
  last_error: string | null;
  auto_start: boolean;
  created_at: Date | string;
  updated_at: Date | string;
};

type LiveEntry = {
  process: SpawnedTunnel | null;
  url: string | null;
  status: TunnelStatus;
  error: string | null;
  stopping: boolean;
};

const live = new Map<string, LiveEntry>();

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

function iso(value: Date | string): string {
  return value instanceof Date ? value.toISOString() : String(value);
}

/**
 * The host a container-targeted tunnel points at. The frozen contract puts
 * `tunnelTargetHost` on config; agent 1's config.ts currently omits it, so read it
 * defensively and fall back to 127.0.0.1.
 */
function tunnelTargetHost(): string {
  const raw = (config as unknown as { tunnelTargetHost?: string }).tunnelTargetHost;
  return (raw ?? '').trim() || '127.0.0.1';
}

function rowToTunnel(row: TunnelRow, containerName: string | null = null): Tunnel {
  return {
    id: row.id,
    name: row.name,
    mode: row.mode,
    target_url: row.target_url,
    container_id: row.container_id,
    container_name: containerName,
    port: row.port,
    hostname: row.hostname,
    tunnel_id: row.tunnel_id,
    status: row.status,
    url: row.url,
    pid: row.pid,
    last_error: row.last_error,
    auto_start: row.auto_start,
    created_at: iso(row.created_at),
    updated_at: iso(row.updated_at),
  };
}

async function loadRow(id: string): Promise<TunnelRow> {
  const row = await one<TunnelRow>('select * from tunnels where id = $1', [id]);
  if (!row) throw new TunnelError(`tunnel '${id}' was not found`, 404, 'not_found');
  return row;
}

type RowPatch = Partial<{
  status: TunnelStatus;
  url: string | null;
  pid: number | null;
  last_error: string | null;
  tunnel_id: string;
  credentials_path: string;
  config_path: string;
  hostname: string;
}>;

const PATCH_COLUMNS: Record<keyof RowPatch, string> = {
  status: 'status',
  url: 'url',
  pid: 'pid',
  last_error: 'last_error',
  tunnel_id: 'tunnel_id',
  credentials_path: 'credentials_path',
  config_path: 'config_path',
  hostname: 'hostname',
};

async function updateRow(id: string, patch: RowPatch): Promise<void> {
  const sets: string[] = [];
  const values: unknown[] = [];
  for (const key of Object.keys(PATCH_COLUMNS) as Array<keyof RowPatch>) {
    if (key in patch) {
      values.push(patch[key] as unknown);
      sets.push(`${PATCH_COLUMNS[key]} = $${values.length}`);
    }
  }
  if (sets.length === 0) return;
  sets.push('updated_at = now()');
  values.push(id);
  await query(`update tunnels set ${sets.join(', ')} where id = $${values.length}`, values);
}

async function emitById(action: string, id: string): Promise<Tunnel> {
  const row = await loadRow(id);
  const tunnel = rowToTunnel(row);
  bus.emit({ type: 'tunnel', action, data: tunnel });
  return tunnel;
}

function emitTunnel(action: string, tunnel: Tunnel): void {
  bus.emit({ type: 'tunnel', action, data: tunnel });
}

async function containerNameMap(ids: Array<string | null>): Promise<Map<string, string>> {
  const wanted = new Set(ids.filter((id): id is string => !!id));
  const out = new Map<string, string>();
  if (wanted.size === 0) return out;
  try {
    const containers = await listContainers({ all: true });
    for (const c of containers) {
      if (wanted.has(c.id)) out.set(c.id, c.name);
    }
  } catch (err) {
    logger.debug('could not resolve container names for tunnels', {
      error: err instanceof Error ? err.message : String(err),
    });
  }
  return out;
}

function pickPublishedPort(
  container: ContainerSummary,
  requested: number | undefined,
): { publishedPort: number; containerPort: number } {
  const published = container.ports.filter(
    (p): p is { privatePort: number; publicPort: number; type: string; ip?: string } =>
      typeof p.publicPort === 'number' && p.publicPort > 0,
  );
  if (published.length === 0) {
    throw new TunnelError(
      `container '${container.name}' has no published port; publish a port or pass target_url`,
      400,
      'validation_error',
    );
  }

  let chosen: (typeof published)[number] | undefined;
  if (requested !== undefined && requested !== null) {
    chosen =
      published.find((p) => p.privatePort === requested) ??
      published.find((p) => p.publicPort === requested);
    if (!chosen) {
      throw new TunnelError(
        `container '${container.name}' has no published port for port ${requested}`,
        400,
        'validation_error',
      );
    }
  } else if (published.length > 1) {
    const tcp = published.filter((p) => p.type === 'tcp');
    if (tcp.length === 1) {
      chosen = tcp[0];
    } else {
      throw new TunnelError(
        `container '${container.name}' publishes ${published.length} ports; specify which port to tunnel`,
        400,
        'validation_error',
      );
    }
  } else {
    chosen = published[0];
  }

  return { publishedPort: chosen.publicPort, containerPort: chosen.privatePort };
}

function waitForExit(proc: SpawnedTunnel, ms: number): Promise<boolean> {
  return new Promise<boolean>((resolve) => {
    let done = false;
    const timer = setTimeout(() => {
      if (!done) {
        done = true;
        resolve(false);
      }
    }, ms);
    if (typeof timer.unref === 'function') timer.unref();
    proc.onExit(() => {
      if (!done) {
        done = true;
        clearTimeout(timer);
        resolve(true);
      }
    });
  });
}

/** Resolve the account id used to build the credentials file (best effort). */
async function currentAccountId(): Promise<string> {
  const creds = await resolveCreds();
  return creds?.accountId ?? '';
}

/**
 * Turn the API tunnel token into a cloudflared credentials-file object. The token endpoint
 * returns a base64 JSON blob ({ a, t, s }); fall back to a minimal object when it does not.
 */
function tokenToCredentials(token: string, accountId: string, tunnelId: string): unknown {
  try {
    const decoded = Buffer.from(token, 'base64').toString('utf8');
    const obj = JSON.parse(decoded) as Record<string, unknown>;
    if (obj && typeof obj === 'object' && (obj.s || obj.TunnelSecret || obj.t)) {
      return {
        AccountTag: (obj.a as string) ?? accountId,
        TunnelID: (obj.t as string) ?? tunnelId,
        TunnelSecret: (obj.s as string) ?? (obj.TunnelSecret as string),
      };
    }
  } catch {
    /* not a base64 JSON token */
  }
  return { AccountTag: accountId, TunnelID: tunnelId, TunnelSecret: token };
}

async function provisionNamed(
  row: TunnelRow,
): Promise<{ tunnelId: string; credentialsPath: string; configPath: string }> {
  if (!row.hostname) {
    throw new TunnelError('named tunnel is missing a hostname', 400, 'validation_error');
  }
  let tunnelId = row.tunnel_id;
  if (!tunnelId) {
    const created = await cfCreateTunnel(row.name);
    tunnelId = created.id;
  }

  const token = await cfGetTunnelToken(tunnelId);
  const accountId = await currentAccountId();

  const slug = slugify(row.name);
  const dir = path.join(config.tunnelDataDir, slug);
  const credentialsPath = path.join(dir, 'credentials.json');
  const configPath = path.join(dir, 'config.yml');

  const credentials = tokenToCredentials(token, accountId, tunnelId);
  const configYaml = buildNamedTunnelConfig({
    tunnelId,
    credentialsFile: credentialsPath,
    hostname: row.hostname,
    service: row.target_url,
  });
  const written = await writeTunnelFiles(slug, credentials, configYaml);

  await updateRow(row.id, {
    tunnel_id: tunnelId,
    credentials_path: written.credentialsPath,
    config_path: written.configPath,
  });

  return { tunnelId, credentialsPath: written.credentialsPath, configPath: written.configPath };
}

function registerLive(
  id: string,
  process: SpawnedTunnel,
  url: string | null,
  status: TunnelStatus,
): LiveEntry {
  const entry: LiveEntry = { process, url, status, error: null, stopping: false };
  live.set(id, entry);

  process.onExit((code, signal) => {
    const current = live.get(id);
    if (current !== entry) return; // superseded by a newer process
    if (entry.stopping) return; // stop()/shutdown() owns this transition
    live.delete(id);
    const message = `cloudflared exited unexpectedly (code=${code ?? 'null'}${
      signal ? `, signal=${signal}` : ''
    })`;
    logger.warn('tunnel process exited unexpectedly', { tunnelId: id, code, signal });
    void updateRow(id, { status: 'error', last_error: message, pid: null, url: null })
      .then(() => emitById('error', id))
      .catch((err) =>
        logger.warn('failed to record tunnel exit', {
          tunnelId: id,
          error: err instanceof Error ? err.message : String(err),
        }),
      );
  });

  return entry;
}

// ---------------------------------------------------------------------------
// public surface
// ---------------------------------------------------------------------------

async function list(): Promise<Tunnel[]> {
  const rows = await many<TunnelRow>('select * from tunnels order by created_at desc');
  const names = await containerNameMap(rows.map((r) => r.container_id));
  return rows.map((r) => rowToTunnel(r, r.container_id ? names.get(r.container_id) ?? null : null));
}

async function get(id: string): Promise<Tunnel | null> {
  const row = await one<TunnelRow>('select * from tunnels where id = $1', [id]);
  if (!row) return null;
  const names = await containerNameMap([row.container_id]);
  return rowToTunnel(row, row.container_id ? names.get(row.container_id) ?? null : null);
}

async function create(input: CreateTunnelInput): Promise<Tunnel> {
  const mode = input.mode;
  if (mode !== 'quick' && mode !== 'named') {
    throw new TunnelError("mode must be 'quick' or 'named'", 400, 'validation_error');
  }
  const name = (input.name ?? '').trim() || (mode === 'quick' ? 'quick tunnel' : 'tunnel');

  let targetUrl = (input.target_url ?? '').trim();
  let containerId = (input.container_id ?? '').trim() || null;
  let port: number | null = input.port ?? null;

  if (!targetUrl) {
    if (!containerId) {
      throw new TunnelError('target_url or container_id is required', 400, 'validation_error');
    }
    const resolved = await resolveContainer(containerId);
    if (!resolved) {
      throw new TunnelError(`container '${containerId}' was not found`, 400, 'validation_error');
    }
    containerId = resolved.id;
    const picked = pickPublishedPort(resolved, input.port);
    targetUrl = `http://${tunnelTargetHost()}:${picked.publishedPort}`;
    port = input.port ?? picked.containerPort;
  }

  const hostname = (input.hostname ?? '').trim() || null;
  if (mode === 'named' && !hostname) {
    throw new TunnelError('hostname is required for a named tunnel', 400, 'validation_error');
  }

  const row = await one<TunnelRow>(
    `insert into tunnels
       (name, mode, target_url, container_id, port, hostname, zone_id, auto_start, status, created_at, updated_at)
     values ($1, $2, $3, $4, $5, $6, $7, $8, 'starting', now(), now())
     returning *`,
    [
      name,
      mode,
      targetUrl,
      containerId,
      port,
      hostname,
      (input.zone_id ?? '').trim() || null,
      !!input.auto_start,
    ],
  );
  if (!row) throw new TunnelError('failed to create tunnel row', 500, 'internal');

  emitTunnel('created', rowToTunnel(row));

  return start(row.id);
}

async function start(id: string): Promise<Tunnel> {
  const row = await loadRow(id);

  const existing = live.get(id);
  if (row.status === 'running' && existing?.process && !existing.stopping) {
    return rowToTunnel(row);
  }

  await updateRow(id, { status: 'starting', pid: null, url: null, last_error: null });

  let spawned: SpawnedTunnel | null = null;
  try {
    if (row.mode === 'quick') {
      const { process, url } = await startQuickTunnel(row.target_url);
      spawned = process;
      registerLive(id, process, url, 'running');
      await updateRow(id, { status: 'running', url, pid: process.pid ?? null, last_error: null });
    } else {
      const provisioned = await provisionNamed(row);
      const args = ['tunnel', '--config', provisioned.configPath, 'run', row.name];
      spawned = spawnCloudflared(args, {
        onLine: (line, stream) =>
          logger.debug('cloudflared', { tunnelId: id, stream, line }),
      });
      const publicUrl = `https://${row.hostname}`;
      registerLive(id, spawned, publicUrl, 'running');

      const exitedEarly = await waitForExit(spawned, 1_500);
      if (exitedEarly) {
        throw new TunnelError(
          `cloudflared exited immediately for named tunnel '${row.name}'`,
          502,
          'tunnel_error',
        );
      }

      await updateRow(id, { status: 'running', url: publicUrl, pid: spawned.pid ?? null, last_error: null });

      if (row.zone_id) {
        try {
          await cfRouteDns(row.zone_id, row.hostname as string, provisioned.tunnelId);
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          logger.warn('failed to create the Cloudflare DNS route', { tunnelId: id, error: message });
          await updateRow(id, { last_error: `DNS route not created: ${message}` });
        }
      }
    }

    return await emitById('started', id);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (spawned) {
      try {
        spawned.kill();
      } catch {
        /* already gone */
      }
    }
    const entry = live.get(id);
    if (entry) entry.stopping = true;
    live.delete(id);
    await updateRow(id, { status: 'error', last_error: message, pid: null, url: null });
    await emitById('error', id);
    if (err instanceof TunnelError) throw err;
    if (err instanceof CloudflareError) throw new TunnelError(message, 502, 'cloudflare_error');
    throw new TunnelError(message, 502, 'tunnel_error');
  }
}

async function stop(id: string): Promise<Tunnel> {
  await loadRow(id);
  const entry = live.get(id);
  if (entry?.process) {
    entry.stopping = true;
    try {
      entry.process.kill();
    } catch {
      /* already gone */
    }
    await waitForExit(entry.process, 7_000);
  }
  live.delete(id);
  await updateRow(id, { status: 'stopped', pid: null, url: null, last_error: null });
  return emitById('stopped', id);
}

async function remove(id: string): Promise<void> {
  const row = await loadRow(id);
  const snapshot = rowToTunnel(row);

  await stop(id);

  if (row.mode === 'named') {
    if (row.tunnel_id) {
      try {
        await cfDeleteTunnel(row.tunnel_id);
      } catch (err) {
        logger.warn('failed to delete the Cloudflare tunnel', {
          tunnelId: id,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }
    try {
      await removeTunnelFiles(slugify(row.name));
    } catch (err) {
      logger.warn('failed to remove tunnel files', {
        tunnelId: id,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  await query('delete from tunnels where id = $1', [id]);
  live.delete(id);
  emitTunnel('removed', snapshot);
}

async function reconcile(): Promise<void> {
  const liveIds = [...live.entries()]
    .filter(([, entry]) => entry.process && !entry.stopping)
    .map(([id]) => id);
  const result = await query(
    `update tunnels
        set status = 'stopped', pid = null, updated_at = now()
      where status in ('starting', 'running')
        and not (id = any($1::uuid[]))`,
    [liveIds],
  );
  if (result.rowCount && result.rowCount > 0) {
    logger.info('reconciled stale tunnel rows', { count: result.rowCount });
  }
}

async function init(): Promise<void> {
  await reconcile();
  const rows = await many<TunnelRow>(
    `select * from tunnels where auto_start = true and status in ('stopped', 'error') order by created_at asc`,
  );
  for (const row of rows) {
    try {
      await start(row.id);
    } catch (err) {
      logger.warn('failed to auto-start tunnel', {
        tunnelId: row.id,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }
}

async function shutdown(): Promise<void> {
  const ids = [...live.keys()];
  for (const id of ids) {
    try {
      await stop(id);
    } catch (err) {
      logger.warn('failed to stop tunnel during shutdown', {
        tunnelId: id,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }
  live.clear();
}

export const tunnelManager = {
  init,
  list,
  get,
  create,
  start,
  stop,
  remove,
  shutdown,
  reconcile,
};
