// Dockyard — container operations (owner: agent 1).

import { PassThrough } from 'node:stream';
import type { Readable } from 'node:stream';
import { getDocker } from './index.ts';
import { DockerError, normalizeDockerError } from './errors.ts';
import { computeContainerStats } from './stats.ts';
import type { ContainerStats } from './stats.ts';

export type ContainerState =
  | 'running'
  | 'exited'
  | 'created'
  | 'paused'
  | 'restarting'
  | 'dead'
  | 'removing';

export type ContainerSummary = {
  id: string;
  name: string;
  image: string;
  imageId: string;
  state: ContainerState;
  status: string;
  created: number;
  health: string | null;
  ports: Array<{ ip?: string; privatePort: number; publicPort?: number; type: string }>;
  labels: Record<string, string>;
  managed: boolean;
  stackId: string | null;
  templateSlug: string | null;
};

export type ContainerDetail = ContainerSummary & {
  command: string;
  entrypoint: string;
  env: string[];
  mounts: Array<{ source: string; destination: string; mode: string; rw: boolean; type: string }>;
  networks: Array<{ name: string; ip: string | null }>;
  restartPolicy: string;
  startedAt: string | null;
  finishedAt: string | null;
  exitCode: number | null;
  platform: string;
};

export type CreateContainerInput = {
  name: string;
  image: string;
  cmd?: string[];
  entrypoint?: string[];
  env?: Record<string, string>;
  ports?: Array<{ host?: number; container: number; proto?: 'tcp' | 'udp' }>;
  volumes?: Array<{ host?: string; container: string; mode?: string }>;
  restartPolicy?: 'no' | 'always' | 'unless-stopped' | 'on-failure';
  labels?: Record<string, string>;
  network?: string;
  pull?: boolean;
};

export type { ContainerStats };

// ---------------------------------------------------------------------------
// Multiplexed stream demux (8-byte header: [type,0,0,0,len4])
// ---------------------------------------------------------------------------

function isZeroTime(s: unknown): boolean {
  return typeof s !== 'string' || s === '' || s.startsWith('0001-01-01');
}

export function demuxDockerStream(buf: Buffer): { stdout: string; stderr: string; combined: string } {
  const stdout: Buffer[] = [];
  const stderr: Buffer[] = [];
  const combined: Buffer[] = [];
  let off = 0;
  let framed = false;

  while (off + 8 <= buf.length) {
    const type = buf.readUInt8(off);
    if (type > 2) break; // not a valid multiplex header
    const len = buf.readUInt32BE(off + 4);
    if (off + 8 + len > buf.length) break; // truncated frame
    const payload = buf.subarray(off + 8, off + 8 + len);
    framed = true;
    combined.push(payload);
    if (type === 1) stdout.push(payload);
    else if (type === 2) stderr.push(payload);
    off += 8 + len;
  }

  if (!framed) {
    // TTY / non-multiplexed output: everything is plain stdout.
    const s = buf.toString('utf8');
    return { stdout: s, stderr: '', combined: s };
  }
  return {
    stdout: Buffer.concat(stdout).toString('utf8'),
    stderr: Buffer.concat(stderr).toString('utf8'),
    combined: Buffer.concat(combined).toString('utf8'),
  };
}

/** Incrementally demux a raw Docker stream into a single readable (stdout+stderr in order). */
export function demuxToReadable(source: Readable, tty: boolean): Readable {
  const out = new PassThrough();
  if (tty) {
    source.pipe(out);
    return out;
  }
  let buf = Buffer.alloc(0);
  let passthrough = false;

  source.on('data', (chunk: Buffer) => {
    if (passthrough) {
      out.write(chunk);
      return;
    }
    buf = Buffer.concat([buf, chunk]);
    while (buf.length >= 8) {
      const type = buf.readUInt8(0);
      if (type > 2) {
        // Header is invalid — stream is not multiplexed. Emit the rest verbatim.
        out.write(buf);
        buf = Buffer.alloc(0);
        passthrough = true;
        return;
      }
      const len = buf.readUInt32BE(4);
      if (buf.length < 8 + len) break;
      out.write(buf.subarray(8, 8 + len));
      buf = buf.subarray(8 + len);
    }
  });
  source.on('end', () => {
    if (buf.length && !passthrough) out.write(buf);
    out.end();
  });
  source.on('error', (err) => out.destroy(err));
  return out;
}

function collectStream(stream: Readable): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    stream.on('data', (c: Buffer) => chunks.push(Buffer.isBuffer(c) ? c : Buffer.from(c)));
    stream.on('end', () => resolve(Buffer.concat(chunks)));
    stream.on('error', reject);
  });
}

// ---------------------------------------------------------------------------
// Mapping helpers
// ---------------------------------------------------------------------------

function parseHealth(status: string | undefined): string | null {
  if (!status) return null;
  const m = /\((healthy|unhealthy|starting)\)/.exec(status);
  return m ? m[1] : null;
}

function labelsOf(raw: unknown): Record<string, string> {
  if (!raw || typeof raw !== 'object') return {};
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(raw as Record<string, unknown>)) out[k] = String(v);
  return out;
}

function mapPorts(raw: unknown): ContainerSummary['ports'] {
  if (!Array.isArray(raw)) return [];
  const out: ContainerSummary['ports'] = [];
  for (const p of raw as any[]) {
    if (!p) continue;
    const entry: { ip?: string; privatePort: number; publicPort?: number; type: string } = {
      privatePort: Number(p.PrivatePort ?? 0),
      type: String(p.Type ?? 'tcp'),
    };
    if (p.IP) entry.ip = String(p.IP);
    if (p.PublicPort) entry.publicPort = Number(p.PublicPort);
    out.push(entry);
  }
  return out;
}

export function summaryFromListItem(item: any): ContainerSummary {
  const labels = labelsOf(item?.Labels);
  const names: string[] = Array.isArray(item?.Names) ? item.Names : [];
  const rawName = names[0] ?? '';
  return {
    id: String(item?.Id ?? ''),
    name: rawName.replace(/^\//, ''),
    image: String(item?.Image ?? ''),
    imageId: String(item?.ImageID ?? ''),
    state: String(item?.State ?? 'created') as ContainerState,
    status: String(item?.Status ?? ''),
    created: Number(item?.Created ?? 0),
    health: parseHealth(item?.Status),
    ports: mapPorts(item?.Ports),
    labels,
    managed: labels['dockyard.managed'] === 'true',
    stackId: labels['dockyard.stack'] ?? null,
    templateSlug: labels['dockyard.template'] ?? null,
  };
}

function portsFromInspect(insp: any): ContainerSummary['ports'] {
  const ports = insp?.NetworkSettings?.Ports;
  if (!ports || typeof ports !== 'object') return [];
  const out: ContainerSummary['ports'] = [];
  for (const [key, bindings] of Object.entries(ports as Record<string, any>)) {
    const [portStr, type] = key.split('/');
    const privatePort = Number(portStr);
    if (!Array.isArray(bindings) || bindings.length === 0) {
      out.push({ privatePort, type: type ?? 'tcp' });
      continue;
    }
    for (const b of bindings) {
      const entry: { ip?: string; privatePort: number; publicPort?: number; type: string } = {
        privatePort,
        type: type ?? 'tcp',
      };
      if (b?.HostIp) entry.ip = String(b.HostIp);
      if (b?.HostPort) entry.publicPort = Number(b.HostPort);
      out.push(entry);
    }
  }
  return out;
}

function summaryFromInspect(insp: any): ContainerSummary {
  const labels = labelsOf(insp?.Config?.Labels);
  const st = insp?.State ?? {};
  return {
    id: String(insp?.Id ?? ''),
    name: String(insp?.Name ?? '').replace(/^\//, ''),
    image: String(insp?.Config?.Image ?? ''),
    imageId: String(insp?.Image ?? ''),
    state: String(st?.Status ?? 'created') as ContainerState,
    status: String(st?.Status ?? ''),
    created: insp?.Created ? Math.floor(Date.parse(insp.Created) / 1000) : 0,
    health: st?.Health?.Status ?? null,
    ports: portsFromInspect(insp),
    labels,
    managed: labels['dockyard.managed'] === 'true',
    stackId: labels['dockyard.stack'] ?? null,
    templateSlug: labels['dockyard.template'] ?? null,
  };
}

function detailFromInspect(insp: any): ContainerDetail {
  const st = insp?.State ?? {};
  const networks = insp?.NetworkSettings?.Networks ?? {};
  const mounts = Array.isArray(insp?.Mounts)
    ? (insp.Mounts as any[]).map((m) => ({
        source: String(m?.Source ?? ''),
        destination: String(m?.Destination ?? ''),
        mode: String(m?.Mode ?? ''),
        rw: Boolean(m?.RW),
        type: String(m?.Type ?? ''),
      }))
    : [];
  return {
    ...summaryFromInspect(insp),
    command: Array.isArray(insp?.Config?.Cmd) ? insp.Config.Cmd.join(' ') : '',
    entrypoint: Array.isArray(insp?.Config?.Entrypoint) ? insp.Config.Entrypoint.join(' ') : '',
    env: Array.isArray(insp?.Config?.Env) ? insp.Config.Env.map((e: unknown) => String(e)) : [],
    mounts,
    networks: Object.entries(networks as Record<string, any>).map(([name, n]) => ({
      name,
      ip: n?.IPAddress ? String(n.IPAddress) : null,
    })),
    restartPolicy: String(insp?.HostConfig?.RestartPolicy?.Name ?? 'no'),
    startedAt: isZeroTime(st?.StartedAt) ? null : String(st.StartedAt),
    finishedAt: isZeroTime(st?.FinishedAt) ? null : String(st.FinishedAt),
    exitCode: typeof st?.ExitCode === 'number' ? st.ExitCode : null,
    platform: String(insp?.Platform ?? ''),
  };
}

// ---------------------------------------------------------------------------
// Queries
// ---------------------------------------------------------------------------

export async function listContainers(opts?: { all?: boolean; q?: string }): Promise<ContainerSummary[]> {
  try {
    const raw = (await getDocker().listContainers({ all: opts?.all ?? false })) as any[];
    let summaries = raw.map(summaryFromListItem);
    const q = opts?.q?.trim().toLowerCase();
    if (q) {
      summaries = summaries.filter(
        (c) =>
          c.name.toLowerCase().includes(q) ||
          c.image.toLowerCase().includes(q) ||
          c.id.toLowerCase().includes(q),
      );
    }
    return summaries;
  } catch (err) {
    throw normalizeDockerError(err);
  }
}

export async function inspectContainer(id: string): Promise<Record<string, unknown>> {
  try {
    return (await getDocker().getContainer(id).inspect()) as Record<string, unknown>;
  } catch (err) {
    throw normalizeDockerError(err);
  }
}

export async function getContainer(id: string): Promise<ContainerDetail> {
  const insp = await inspectContainer(id);
  return detailFromInspect(insp);
}

export async function resolveContainer(idOrName: string): Promise<ContainerSummary | null> {
  const target = idOrName.replace(/^\//, '');
  const all = await listContainers({ all: true });
  return (
    all.find((c) => c.id === target) ??
    all.find((c) => c.id.startsWith(target)) ??
    all.find((c) => c.name === target) ??
    all.find((c) => `/${c.name}` === idOrName) ??
    null
  );
}

// ---------------------------------------------------------------------------
// Lifecycle
// ---------------------------------------------------------------------------

async function ensureImage(image: string): Promise<void> {
  try {
    await getDocker().getImage(image).inspect();
    return;
  } catch {
    /* fall through to pull */
  }
  const { pullImage } = await import('./images.ts');
  await pullImage(image);
}

function buildCreateOptions(input: CreateContainerInput): Record<string, unknown> {
  const ExposedPorts: Record<string, unknown> = {};
  const PortBindings: Record<string, unknown> = {};
  for (const p of input.ports ?? []) {
    const proto = p.proto ?? 'tcp';
    const key = `${p.container}/${proto}`;
    ExposedPorts[key] = {};
    const binding: Record<string, string> = {};
    if (p.host != null) binding.HostPort = String(p.host);
    PortBindings[key] = [binding];
  }

  const Binds: string[] = [];
  const Volumes: Record<string, unknown> = {};
  for (const v of input.volumes ?? []) {
    if (v.host) Binds.push(`${v.host}:${v.container}:${v.mode ?? 'rw'}`);
    else Volumes[v.container] = {};
  }

  const Env = Object.entries(input.env ?? {}).map(([k, val]) => `${k}=${val}`);

  const opts: Record<string, unknown> = {
    name: input.name,
    Image: input.image,
    Env,
    Labels: input.labels ?? {},
    ExposedPorts,
    HostConfig: {
      PortBindings,
      Binds,
      RestartPolicy: { Name: input.restartPolicy ?? 'no' },
    },
  };
  if (input.cmd) opts.Cmd = input.cmd;
  if (input.entrypoint) opts.Entrypoint = input.entrypoint;
  if (Object.keys(Volumes).length > 0) opts.Volumes = Volumes;
  if (input.network) opts.NetworkingConfig = { EndpointsConfig: { [input.network]: {} } };
  return opts;
}

export async function createContainer(
  input: CreateContainerInput,
): Promise<{ id: string; name: string; warnings: string[] }> {
  try {
    const docker = getDocker();
    if (input.pull !== false) await ensureImage(input.image);

    const createOpts = buildCreateOptions(input);
    const data: any = await new Promise((resolve, reject) => {
      // dockerode's createContainer discards `Warnings`; dial the daemon directly to keep it.
      (docker as any).modem.dial(
        {
          path: '/containers/create?',
          method: 'POST',
          options: createOpts,
          statusCodes: {
            200: true,
            201: true,
            400: 'bad parameter',
            404: 'no such image',
            409: 'conflict',
            500: 'server error',
          },
        },
        (err: any, d: any) => (err ? reject(err) : resolve(d)),
      );
    });

    const id = data?.Id;
    if (!id) throw new DockerError('container create returned no id', { code: 'docker_error', statusCode: 502 });
    return {
      id: String(id),
      name: input.name,
      warnings: Array.isArray(data?.Warnings) ? data.Warnings.map(String) : [],
    };
  } catch (err) {
    throw normalizeDockerError(err);
  }
}

async function action(fn: () => Promise<unknown>): Promise<void> {
  try {
    await fn();
  } catch (err) {
    throw normalizeDockerError(err);
  }
}

export function startContainer(id: string): Promise<void> {
  return action(() => getDocker().getContainer(id).start());
}

export function stopContainer(id: string, timeoutSec?: number): Promise<void> {
  return action(() =>
    timeoutSec === undefined
      ? getDocker().getContainer(id).stop()
      : getDocker().getContainer(id).stop({ t: timeoutSec } as any),
  );
}

export function restartContainer(id: string, timeoutSec?: number): Promise<void> {
  return action(() =>
    timeoutSec === undefined
      ? getDocker().getContainer(id).restart()
      : getDocker().getContainer(id).restart({ t: timeoutSec } as any),
  );
}

export function killContainer(id: string, signal?: string): Promise<void> {
  return action(() => getDocker().getContainer(id).kill(signal ? ({ signal } as any) : ({} as any)));
}

export function pauseContainer(id: string): Promise<void> {
  return action(() => getDocker().getContainer(id).pause());
}

export function unpauseContainer(id: string): Promise<void> {
  return action(() => getDocker().getContainer(id).unpause());
}

export function removeContainer(id: string, opts?: { force?: boolean; volumes?: boolean }): Promise<void> {
  return action(() =>
    getDocker()
      .getContainer(id)
      .remove({ force: opts?.force ?? false, v: opts?.volumes ?? false } as any),
  );
}

export async function pruneContainers(): Promise<{ deleted: string[]; spaceReclaimed: number }> {
  try {
    const res = (await getDocker().pruneContainers()) as any;
    return {
      deleted: Array.isArray(res?.ContainersDeleted) ? res.ContainersDeleted.map(String) : [],
      spaceReclaimed: Number(res?.SpaceReclaimed ?? 0),
    };
  } catch (err) {
    throw normalizeDockerError(err);
  }
}

// ---------------------------------------------------------------------------
// Logs
// ---------------------------------------------------------------------------

async function isTty(id: string): Promise<boolean> {
  const insp = (await getDocker().getContainer(id).inspect()) as any;
  return Boolean(insp?.Config?.Tty);
}

export async function containerLogs(
  id: string,
  opts?: { tail?: number; since?: number; timestamps?: boolean },
): Promise<string> {
  try {
    const tty = await isTty(id);
    const buf = (await getDocker()
      .getContainer(id)
      .logs({
        stdout: true,
        stderr: true,
        follow: false,
        tail: opts?.tail ?? 200,
        since: opts?.since,
        timestamps: opts?.timestamps ?? false,
      } as any)) as unknown as Buffer;

    if (tty) return Buffer.isBuffer(buf) ? buf.toString('utf8') : String(buf ?? '');
    return demuxDockerStream(Buffer.isBuffer(buf) ? buf : Buffer.from(buf ?? '')).combined;
  } catch (err) {
    throw normalizeDockerError(err);
  }
}

export async function containerLogsStream(
  id: string,
  opts?: { tail?: number },
): Promise<NodeJS.ReadableStream> {
  try {
    const tty = await isTty(id);
    const raw = (await getDocker()
      .getContainer(id)
      .logs({ stdout: true, stderr: true, follow: true, tail: opts?.tail ?? 200 } as any)) as Readable;
    return demuxToReadable(raw, tty);
  } catch (err) {
    throw normalizeDockerError(err);
  }
}

// ---------------------------------------------------------------------------
// Stats
// ---------------------------------------------------------------------------

export async function containerStats(id: string): Promise<ContainerStats> {
  try {
    const frame = (await getDocker().getContainer(id).stats({ stream: false } as any)) as any;
    return computeContainerStats(frame);
  } catch (err) {
    throw normalizeDockerError(err);
  }
}

export async function containerStatsStream(id: string): Promise<NodeJS.ReadableStream> {
  try {
    const stream = (await getDocker().getContainer(id).stats({ stream: true } as any)) as Readable;
    return stream;
  } catch (err) {
    throw normalizeDockerError(err);
  }
}

// ---------------------------------------------------------------------------
// Exec
// ---------------------------------------------------------------------------

export async function execInContainer(
  id: string,
  cmd: string[],
  opts?: { timeoutMs?: number },
): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  const timeoutMs = opts?.timeoutMs ?? 30_000;
  try {
    const container = getDocker().getContainer(id);
    const exec = await container.exec({
      Cmd: cmd,
      AttachStdout: true,
      AttachStderr: true,
      Tty: false,
    } as any);

    const stream = (await exec.start({ Detach: false, Tty: false, hijack: false } as any)) as Readable;

    let timedOut = false;
    const collected = await new Promise<Buffer>((resolve) => {
      const chunks: Buffer[] = [];
      const timer = setTimeout(() => {
        timedOut = true;
        stream.destroy();
        resolve(Buffer.concat(chunks));
      }, timeoutMs);

      stream.on('data', (c: Buffer) => chunks.push(Buffer.isBuffer(c) ? c : Buffer.from(c)));
      stream.on('end', () => {
        clearTimeout(timer);
        resolve(Buffer.concat(chunks));
      });
      stream.on('error', () => {
        clearTimeout(timer);
        resolve(Buffer.concat(chunks));
      });
    });

    const demuxed = demuxDockerStream(collected);

    if (timedOut) {
      return {
        stdout: demuxed.stdout,
        stderr: demuxed.stderr + `\n[dockyard] exec timed out after ${timeoutMs}ms`,
        exitCode: 124,
      };
    }

    let exitCode = -1;
    try {
      const info = (await exec.inspect()) as any;
      if (typeof info?.ExitCode === 'number') exitCode = info.ExitCode;
    } catch {
      // container may have died mid-exec; leave -1
    }
    return { stdout: demuxed.stdout, stderr: demuxed.stderr, exitCode };
  } catch (err) {
    throw normalizeDockerError(err);
  }
}
