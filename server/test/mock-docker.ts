// ============================================================================
// TEST DOUBLE — this is NOT a real Docker daemon.
//
// mock-docker.ts is an in-memory HTTP server that implements the subset of the
// Docker Engine API that Dockyard uses, so the whole stack is testable with no
// daemon present. Point the app at it with DOCKER_HOST=tcp://127.0.0.1:<port>.
// It is intentionally permissive and deterministic; the real daemon is always
// preferred whenever one is reachable.
// ============================================================================

import http from 'node:http';
import type { AddressInfo } from 'node:net';
import crypto from 'node:crypto';

const VERSION = '26.1.5-mock';
const API_VERSION = '1.45';

export type MockContainerState = 'created' | 'running' | 'exited' | 'paused' | 'dead';

export type SeedContainerInput = {
  id?: string;
  name: string;
  image?: string;
  state?: MockContainerState;
  labels?: Record<string, string>;
  env?: Record<string, string>;
  cmd?: string[];
  ports?: Array<{ host?: number; container: number; proto?: string }>;
  logs?: string;
  stderrLogs?: string;
  tty?: boolean;
  exitCode?: number;
  restartPolicy?: string;
  exec?: { stdout?: string; stderr?: string; exitCode?: number; hang?: boolean };
  mounts?: Array<{ source: string; destination: string; mode?: string; rw?: boolean; type?: string }>;
  networks?: Record<string, { ip?: string }>;
};

type MockContainer = {
  Id: string;
  Name: string; // without leading slash
  Image: string;
  ImageID: string;
  Command: string;
  Created: number;
  State: MockContainerState;
  Labels: Record<string, string>;
  Ports: Array<{ IP: string; PrivatePort: number; PublicPort: number; Type: string }>;
  Config: any;
  HostConfig: any;
  Mounts: any[];
  Networks: Record<string, { IPAddress: string }>;
  ExitCode: number;
  StartedAt: string;
  FinishedAt: string;
  stdout: string;
  stderr: string;
  Tty: boolean;
  exec: { stdout?: string; stderr?: string; exitCode?: number; hang?: boolean };
};

type MockImage = {
  Id: string;
  RepoTags: string[];
  RepoDigests: string[];
  Size: number;
  Created: number;
  Containers: number;
};

type MockVolume = { Name: string; Driver: string; Mountpoint: string; CreatedAt: string; Labels: Record<string, string> };
type MockNetwork = {
  Id: string;
  Name: string;
  Driver: string;
  Scope: string;
  Internal: boolean;
  Labels: Record<string, string>;
  Containers: Record<string, { Name: string }>;
};

export type MockDockerState = {
  containers: Map<string, MockContainer>;
  images: Map<string, MockImage>;
  volumes: Map<string, MockVolume>;
  networks: Map<string, MockNetwork>;
  execs: Map<string, { containerId: string; cmd: string[]; exitCode: number; stdout: string; stderr: string; hang?: boolean }>;
};

export type MockDocker = {
  url: string;
  port: number;
  state: MockDockerState;
  seedContainer(input: SeedContainerInput): string;
  seedImage(ref: string, id?: string): string;
  close(): Promise<void>;
};

function newId(): string {
  return crypto.randomBytes(32).toString('hex');
}

function frame(type: 1 | 2, payload: string): Buffer {
  const data = Buffer.from(payload, 'utf8');
  const header = Buffer.alloc(8);
  header.writeUInt8(type, 0);
  header.writeUInt32BE(data.length, 4);
  return Buffer.concat([header, data]);
}

function nowIso(): string {
  return new Date().toISOString();
}

function readBody(req: http.IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

function jsonBody(buf: Buffer): any {
  if (!buf || buf.length === 0) return {};
  try {
    return JSON.parse(buf.toString('utf8'));
  } catch {
    return {};
  }
}

function sendJson(res: http.ServerResponse, status: number, obj: unknown): void {
  const body = JSON.stringify(obj);
  res.writeHead(status, { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) });
  res.end(body);
}

function sendEmpty(res: http.ServerResponse, status = 204): void {
  res.writeHead(status);
  res.end();
}

export async function startMockDocker(opts?: { port?: number; seed?: SeedContainerInput[] }): Promise<MockDocker> {
  const state: MockDockerState = {
    containers: new Map(),
    images: new Map(),
    volumes: new Map(),
    networks: new Map(),
    execs: new Map(),
  };

  // A default network like a fresh daemon.
  const defaultNetId = newId();
  state.networks.set(defaultNetId, {
    Id: defaultNetId,
    Name: 'bridge',
    Driver: 'bridge',
    Scope: 'local',
    Internal: false,
    Labels: {},
    Containers: {},
  });

  const findContainer = (idOrName: string): MockContainer | undefined => {
    const key = idOrName.replace(/^\//, '');
    if (state.containers.has(key)) return state.containers.get(key);
    for (const c of state.containers.values()) {
      if (c.Id.startsWith(key) || c.Name === key) return c;
    }
    return undefined;
  };

  const seedContainer = (input: SeedContainerInput): string => {
    const id = input.id ?? newId();
    const labels = input.labels ?? {};
    const ports = (input.ports ?? []).map((p) => ({
      IP: '0.0.0.0',
      PrivatePort: p.container,
      PublicPort: p.host ?? 0,
      Type: p.proto ?? 'tcp',
    }));
    const env = Object.entries(input.env ?? {}).map(([k, v]) => `${k}=${v}`);
    const mounts = (input.mounts ?? []).map((m) => ({
      Type: m.type ?? 'bind',
      Source: m.source,
      Destination: m.destination,
      Mode: m.mode ?? '',
      RW: m.rw ?? true,
      Name: m.type === 'volume' ? m.source : undefined,
    }));
    const networks: Record<string, { IPAddress: string }> = {};
    for (const [name, n] of Object.entries(input.networks ?? {})) {
      networks[name] = { IPAddress: n.ip ?? '172.17.0.2' };
    }
    if (Object.keys(networks).length === 0) networks['bridge'] = { IPAddress: '172.17.0.2' };

    const st: MockContainerState = input.state ?? 'running';
    const c: MockContainer = {
      Id: id,
      Name: input.name.replace(/^\//, ''),
      Image: input.image ?? 'alpine:3.20',
      ImageID: 'sha256:' + id.slice(0, 12),
      Command: (input.cmd ?? ['/bin/sh']).join(' '),
      Created: Math.floor(Date.now() / 1000),
      State: st,
      Labels: labels,
      Ports: ports,
      Config: {
        Image: input.image ?? 'alpine:3.20',
        Cmd: input.cmd ?? ['/bin/sh'],
        Entrypoint: null,
        Env: env,
        Labels: labels,
        Tty: input.tty ?? false,
      },
      HostConfig: { RestartPolicy: { Name: input.restartPolicy ?? 'no' }, NetworkMode: 'bridge' },
      Mounts: mounts,
      Networks: networks,
      ExitCode: input.exitCode ?? 0,
      StartedAt: st === 'running' || st === 'paused' ? nowIso() : '0001-01-01T00:00:00Z',
      FinishedAt: st === 'exited' ? nowIso() : '0001-01-01T00:00:00Z',
      stdout: input.logs ?? '',
      stderr: input.stderrLogs ?? '',
      Tty: input.tty ?? false,
      exec: input.exec ?? {},
    };
    state.containers.set(id, c);
    return id;
  };

  const seedImage = (ref: string, id?: string): string => {
    const imageId = id ?? 'sha256:' + crypto.randomBytes(32).toString('hex');
    state.images.set(imageId, {
      Id: imageId,
      RepoTags: [ref],
      RepoDigests: [],
      Size: 7_000_000,
      Created: Math.floor(Date.now() / 1000),
      Containers: 0,
    });
    return imageId;
  };

  // Seed the alpine image so lifecycle tests do not need a pull.
  seedImage('alpine:3.20');

  const server = http.createServer((req, res) => {
    void handle(req, res);
  });

  async function handle(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    const url = new URL(req.url ?? '/', 'http://localhost');
    // Strip an optional /v1.xx version prefix.
    let path = url.pathname.replace(/^\/v[0-9.]+/, '');
    if (path === '') path = '/';
    const method = req.method ?? 'GET';
    const q = url.searchParams;

    // --- ping / version / info ---
    if (method === 'GET' && path === '/_ping') {
      res.writeHead(200, { 'Content-Type': 'text/plain', 'API-Version': API_VERSION, 'Docker-Experimental': 'false' });
      res.end('OK');
      return;
    }
    if (method === 'GET' && path === '/version') {
      sendJson(res, 200, {
        Version: VERSION,
        ApiVersion: API_VERSION,
        MinAPIVersion: '1.24',
        Os: 'linux',
        Arch: 'amd64',
        KernelVersion: 'mock',
        GoVersion: 'go1.22',
      });
      return;
    }
    if (method === 'GET' && path === '/info') {
      const all = [...state.containers.values()];
      sendJson(res, 200, {
        Containers: all.length,
        ContainersRunning: all.filter((c) => c.State === 'running').length,
        ContainersPaused: all.filter((c) => c.State === 'paused').length,
        ContainersStopped: all.filter((c) => c.State === 'exited' || c.State === 'created').length,
        Images: state.images.size,
        Driver: 'overlay2',
        ServerVersion: VERSION,
      });
      return;
    }

    // --- images ---
    if (method === 'GET' && path === '/images/json') {
      sendJson(res, 200, [...state.images.values()]);
      return;
    }
    if (method === 'POST' && path === '/images/create') {
      const fromImage = q.get('fromImage') ?? '';
      const tag = q.get('tag') ?? 'latest';
      const ref = fromImage.includes(':') ? fromImage : `${fromImage}:${tag}`;
      seedImage(ref);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      const lines = [
        { status: `Pulling from ${fromImage}`, id: tag },
        { status: 'Download complete', id: tag },
        { status: `Status: Downloaded newer image for ${ref}` },
      ];
      for (const l of lines) res.write(JSON.stringify(l) + '\n');
      res.end();
      return;
    }
    if (method === 'POST' && path === '/images/prune') {
      sendJson(res, 200, { ImagesDeleted: [], SpaceReclaimed: 0 });
      return;
    }
    const imageInspect = /^\/images\/([^/]+)\/json$/.exec(path);
    if (method === 'GET' && imageInspect) {
      const ref = decodeURIComponent(imageInspect[1]);
      const img =
        state.images.get(ref) ??
        [...state.images.values()].find((i) => i.RepoTags.includes(ref) || i.Id.startsWith(ref));
      if (!img) {
        sendJson(res, 404, { message: `No such image: ${ref}` });
        return;
      }
      sendJson(res, 200, { ...img, Architecture: 'amd64', Os: 'linux' });
      return;
    }
    const imageDelete = /^\/images\/([^/]+)$/.exec(path);
    if (method === 'DELETE' && imageDelete) {
      const ref = decodeURIComponent(imageDelete[1]);
      for (const [id, img] of state.images) {
        if (id === ref || img.RepoTags.includes(ref) || id.startsWith(ref)) {
          state.images.delete(id);
          sendJson(res, 200, [{ Deleted: id }]);
          return;
        }
      }
      sendJson(res, 404, { message: `No such image: ${ref}` });
      return;
    }

    // --- volumes ---
    if (method === 'GET' && path === '/volumes') {
      sendJson(res, 200, { Volumes: [...state.volumes.values()], Warnings: [] });
      return;
    }
    if (method === 'POST' && path === '/volumes/create') {
      const body = jsonBody(await readBody(req));
      const name = body.Name ?? newId().slice(0, 16);
      const vol: MockVolume = {
        Name: name,
        Driver: body.Driver ?? 'local',
        Mountpoint: `/var/lib/docker/volumes/${name}/_data`,
        CreatedAt: nowIso(),
        Labels: body.Labels ?? {},
      };
      state.volumes.set(name, vol);
      sendJson(res, 201, vol);
      return;
    }
    if (method === 'POST' && path === '/volumes/prune') {
      sendJson(res, 200, { VolumesDeleted: [], SpaceReclaimed: 0 });
      return;
    }
    const volumeInspect = /^\/volumes\/([^/]+)$/.exec(path);
    if (method === 'GET' && volumeInspect) {
      const name = decodeURIComponent(volumeInspect[1]);
      const vol = state.volumes.get(name);
      if (!vol) {
        sendJson(res, 404, { message: `no such volume: ${name}` });
        return;
      }
      sendJson(res, 200, vol);
      return;
    }
    const volumeDelete = /^\/volumes\/([^/]+)$/.exec(path);
    if (method === 'DELETE' && volumeDelete) {
      const name = decodeURIComponent(volumeDelete[1]);
      if (!state.volumes.has(name)) {
        sendJson(res, 404, { message: `no such volume: ${name}` });
        return;
      }
      state.volumes.delete(name);
      sendEmpty(res, 204);
      return;
    }

    // --- networks ---
    if (method === 'GET' && path === '/networks') {
      sendJson(res, 200, [...state.networks.values()]);
      return;
    }
    if (method === 'POST' && path === '/networks/create') {
      const body = jsonBody(await readBody(req));
      if ([...state.networks.values()].some((n) => n.Name === body.Name)) {
        sendJson(res, 409, { message: `network with name ${body.Name} already exists` });
        return;
      }
      const id = newId();
      state.networks.set(id, {
        Id: id,
        Name: body.Name,
        Driver: body.Driver ?? 'bridge',
        Scope: 'local',
        Internal: Boolean(body.Internal),
        Labels: body.Labels ?? {},
        Containers: {},
      });
      sendJson(res, 201, { Id: id, Warning: '' });
      return;
    }
    const networkInspect = /^\/networks\/([^/]+)$/.exec(path);
    if (method === 'GET' && networkInspect) {
      const id = decodeURIComponent(networkInspect[1]);
      const net =
        state.networks.get(id) ?? [...state.networks.values()].find((n) => n.Name === id || n.Id.startsWith(id));
      if (!net) {
        sendJson(res, 404, { message: `network ${id} not found` });
        return;
      }
      sendJson(res, 200, net);
      return;
    }
    const networkDelete = /^\/networks\/([^/]+)$/.exec(path);
    if (method === 'DELETE' && networkDelete) {
      const id = decodeURIComponent(networkDelete[1]);
      const net =
        state.networks.get(id) ?? [...state.networks.values()].find((n) => n.Name === id || n.Id.startsWith(id));
      if (!net) {
        sendJson(res, 404, { message: `network ${id} not found` });
        return;
      }
      if (net.Name === 'bridge') {
        sendJson(res, 403, { message: 'bridge is a pre-defined network and cannot be removed' });
        return;
      }
      state.networks.delete(net.Id);
      sendEmpty(res, 204);
      return;
    }

    // --- containers: create / list / prune ---
    if (method === 'POST' && path === '/containers/create') {
      const body = jsonBody(await readBody(req));
      const name = q.get('name') ?? body.name ?? newId().slice(0, 12);
      if ([...state.containers.values()].some((c) => c.Name === name.replace(/^\//, ''))) {
        sendJson(res, 409, { message: `Conflict. The container name "/${name}" is already in use` });
        return;
      }
      const id = seedContainer({
        name,
        image: body.Image,
        state: 'created',
        labels: body.Labels ?? {},
        env: Object.fromEntries(
          (Array.isArray(body.Env) ? body.Env : []).map((e: string) => {
            const i = e.indexOf('=');
            return [i === -1 ? e : e.slice(0, i), i === -1 ? '' : e.slice(i + 1)];
          }),
        ),
        cmd: body.Cmd,
        tty: Boolean(body.Tty),
        restartPolicy: body.HostConfig?.RestartPolicy?.Name ?? 'no',
      });
      const c = state.containers.get(id)!;
      c.HostConfig = body.HostConfig ?? c.HostConfig;
      const pb = body.HostConfig?.PortBindings ?? {};
      c.Ports = Object.entries(pb).map(([key, bindings]: [string, any]) => {
        const [port, type] = key.split('/');
        const host = Array.isArray(bindings) && bindings[0]?.HostPort ? Number(bindings[0].HostPort) : 0;
        return { IP: '0.0.0.0', PrivatePort: Number(port), PublicPort: host, Type: type ?? 'tcp' };
      });
      sendJson(res, 201, { Id: id, Warnings: [] });
      return;
    }
    if (method === 'GET' && path === '/containers/json') {
      const all = q.get('all');
      const wantAll = all === '1' || all === 'true' || all === 'True';
      const list = [...state.containers.values()].filter((c) => wantAll || c.State === 'running');
      sendJson(
        res,
        200,
        list.map((c) => ({
          Id: c.Id,
          Names: [`/${c.Name}`],
          Image: c.Image,
          ImageID: c.ImageID,
          Command: c.Command,
          Created: c.Created,
          Ports: c.Ports,
          Labels: c.Labels,
          State: c.State,
          Status: statusText(c),
          Mounts: c.Mounts,
          NetworkSettings: { Networks: c.Networks },
        })),
      );
      return;
    }
    if (method === 'POST' && path === '/containers/prune') {
      const removed: string[] = [];
      for (const [id, c] of state.containers) {
        if (c.State === 'exited' || c.State === 'created' || c.State === 'dead') {
          state.containers.delete(id);
          removed.push(id);
        }
      }
      sendJson(res, 200, { ContainersDeleted: removed, SpaceReclaimed: 0 });
      return;
    }

    // --- containers: per-id ---
    const containerAction = /^\/containers\/([^/]+)\/(json|start|stop|restart|kill|pause|unpause|logs|stats|exec|wait)$/.exec(path);
    const containerDelete = /^\/containers\/([^/]+)$/.exec(path);

    if (method === 'DELETE' && containerDelete) {
      const c = findContainer(decodeURIComponent(containerDelete[1]));
      if (!c) {
        sendJson(res, 404, { message: 'No such container' });
        return;
      }
      const force = q.get('force') === '1' || q.get('force') === 'true';
      if (c.State === 'running' && !force) {
        sendJson(res, 409, { message: 'You cannot remove a running container. Stop the container before attempting removal or force remove' });
        return;
      }
      state.containers.delete(c.Id);
      sendEmpty(res, 204);
      return;
    }

    if (containerAction) {
      const c = findContainer(decodeURIComponent(containerAction[1]));
      const action = containerAction[2];
      if (!c) {
        sendJson(res, 404, { message: `No such container: ${containerAction[1]}` });
        return;
      }

      if (action === 'json' && method === 'GET') {
        sendJson(res, 200, inspectOf(c));
        return;
      }
      if (action === 'start' && method === 'POST') {
        if (c.State === 'running') {
          sendEmpty(res, 304);
          return;
        }
        c.State = 'running';
        c.StartedAt = nowIso();
        c.ExitCode = 0;
        sendEmpty(res, 204);
        return;
      }
      if (action === 'stop' && method === 'POST') {
        if (c.State !== 'running') {
          sendEmpty(res, 304);
          return;
        }
        c.State = 'exited';
        c.FinishedAt = nowIso();
        sendEmpty(res, 204);
        return;
      }
      if (action === 'restart' && method === 'POST') {
        c.State = 'running';
        c.StartedAt = nowIso();
        sendEmpty(res, 204);
        return;
      }
      if (action === 'kill' && method === 'POST') {
        if (c.State !== 'running' && c.State !== 'paused') {
          sendJson(res, 409, { message: 'Container is not running' });
          return;
        }
        c.State = 'exited';
        c.ExitCode = 137;
        c.FinishedAt = nowIso();
        sendEmpty(res, 204);
        return;
      }
      if (action === 'pause' && method === 'POST') {
        if (c.State !== 'running') {
          sendJson(res, 500, { message: 'Container is not running' });
          return;
        }
        c.State = 'paused';
        sendEmpty(res, 204);
        return;
      }
      if (action === 'unpause' && method === 'POST') {
        if (c.State !== 'paused') {
          sendJson(res, 500, { message: 'Container is not paused' });
          return;
        }
        c.State = 'running';
        sendEmpty(res, 204);
        return;
      }
      if (action === 'wait' && method === 'POST') {
        sendJson(res, 200, { StatusCode: c.ExitCode });
        return;
      }
      if (action === 'logs' && method === 'GET') {
        if (c.Tty) {
          res.writeHead(200, { 'Content-Type': 'application/vnd.docker.raw-stream' });
          res.end(c.stdout + c.stderr);
          return;
        }
        const parts: Buffer[] = [];
        if (c.stdout) parts.push(frame(1, c.stdout));
        if (c.stderr) parts.push(frame(2, c.stderr));
        const buf = Buffer.concat(parts);
        res.writeHead(200, { 'Content-Type': 'application/vnd.docker.multiplexed-stream', 'Content-Length': buf.length });
        res.end(buf);
        return;
      }
      if (action === 'stats' && method === 'GET') {
        const statsFrame = buildStats(c);
        const stream = q.get('stream');
        if (stream === 'false') {
          sendJson(res, 200, statsFrame);
        } else {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.write(JSON.stringify(statsFrame));
          res.end();
        }
        return;
      }
      if (action === 'exec' && method === 'POST') {
        if (c.State !== 'running') {
          sendJson(res, 409, { message: 'Container is not running' });
          return;
        }
        const body = jsonBody(await readBody(req));
        const execId = newId();
        state.execs.set(execId, {
          containerId: c.Id,
          cmd: Array.isArray(body.Cmd) ? body.Cmd : [],
          exitCode: c.exec.exitCode ?? 0,
          stdout: c.exec.stdout ?? '',
          stderr: c.exec.stderr ?? '',
          hang: c.exec.hang,
        });
        sendJson(res, 201, { Id: execId });
        return;
      }
    }

    // --- exec ---
    const execStart = /^\/exec\/([^/]+)\/start$/.exec(path);
    if (method === 'POST' && execStart) {
      const e = state.execs.get(decodeURIComponent(execStart[1]));
      if (!e) {
        sendJson(res, 404, { message: 'No such exec instance' });
        return;
      }
      res.writeHead(200, { 'Content-Type': 'application/vnd.docker.multiplexed-stream' });
      if (e.hang) {
        // Simulate a container that dies / never returns mid-exec. Flush headers so the client
        // receives the stream, then release the socket when the client gives up.
        res.flushHeaders();
        req.on('close', () => res.destroy());
        return;
      }
      if (e.stdout) res.write(frame(1, e.stdout));
      if (e.stderr) res.write(frame(2, e.stderr));
      res.end();
      return;
    }
    const execInspect = /^\/exec\/([^/]+)\/json$/.exec(path);
    if (method === 'GET' && execInspect) {
      const e = state.execs.get(decodeURIComponent(execInspect[1]));
      if (!e) {
        sendJson(res, 404, { message: 'No such exec instance' });
        return;
      }
      sendJson(res, 200, { ID: execInspect[1], Running: false, ExitCode: e.exitCode, ContainerID: e.containerId });
      return;
    }

    sendJson(res, 404, { message: `mock-docker: no route for ${method} ${path}` });
  }

  function statusText(c: MockContainer): string {
    switch (c.State) {
      case 'running':
        return 'Up 1 second';
      case 'paused':
        return 'Up 1 second (Paused)';
      case 'exited':
        return `Exited (${c.ExitCode}) 1 second ago`;
      case 'created':
        return 'Created';
      default:
        return c.State;
    }
  }

  function inspectOf(c: MockContainer): any {
    return {
      Id: c.Id,
      Name: `/${c.Name}`,
      Created: new Date(c.Created * 1000).toISOString(),
      Path: c.Command,
      Image: c.ImageID,
      State: {
        Status: c.State,
        Running: c.State === 'running',
        Paused: c.State === 'paused',
        Restarting: false,
        StartedAt: c.StartedAt,
        FinishedAt: c.FinishedAt,
        ExitCode: c.ExitCode,
      },
      Config: c.Config,
      HostConfig: c.HostConfig,
      Mounts: c.Mounts,
      NetworkSettings: {
        Networks: Object.fromEntries(
          Object.entries(c.Networks).map(([name, n]) => [name, { IPAddress: n.IPAddress }]),
        ),
        Ports: portsMap(c),
      },
      Platform: 'linux',
    };
  }

  function portsMap(c: MockContainer): Record<string, Array<{ HostIp: string; HostPort: string }> | null> {
    const out: Record<string, Array<{ HostIp: string; HostPort: string }> | null> = {};
    for (const p of c.Ports) {
      const key = `${p.PrivatePort}/${p.Type}`;
      out[key] = p.PublicPort ? [{ HostIp: p.IP, HostPort: String(p.PublicPort) }] : null;
    }
    return out;
  }

  function buildStats(c: MockContainer): any {
    return {
      read: nowIso(),
      preread: nowIso(),
      pids_stats: { current: 5, limit: 100 },
      blkio_stats: {
        io_service_bytes_recursive: [
          { major: 8, minor: 0, op: 'Read', value: 4096 },
          { major: 8, minor: 0, op: 'Write', value: 8192 },
        ],
      },
      cpu_stats: {
        cpu_usage: { total_usage: 5_000_000_000, percpu_usage: [2_500_000_000, 2_500_000_000] },
        system_cpu_usage: 1_000_000_000_000,
        online_cpus: 2,
      },
      precpu_stats: {
        cpu_usage: { total_usage: 4_000_000_000 },
        system_cpu_usage: 995_000_000_000,
      },
      memory_stats: {
        usage: 50_000_000,
        limit: 1_000_000_000,
        stats: { cache: 10_000_000 },
      },
      networks: {
        eth0: { rx_bytes: 1000, tx_bytes: 2000, rx_packets: 10, tx_packets: 20 },
      },
      name: `/mock-${c.Name}`,
      id: c.Id,
    };
  }

  await new Promise<void>((resolve) => server.listen(opts?.port ?? 0, '127.0.0.1', resolve));
  const port = (server.address() as AddressInfo).port;

  for (const seed of opts?.seed ?? []) seedContainer(seed);

  return {
    url: `tcp://127.0.0.1:${port}`,
    port,
    state,
    seedContainer,
    seedImage,
    close(): Promise<void> {
      return new Promise((resolve) => {
        server.close(() => resolve());
        // Drop any lingering keep-alive / hung sockets so close() cannot block forever.
        server.closeAllConnections?.();
      });
    },
  };
}
