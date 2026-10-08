// Dockyard — Docker engine layer entry point (owner: agent 1).
//
// Memoizes ONE dockerode client from config, exposes dockerPing/dockerVersion, and
// re-exports the whole service surface (containers, images, volumes, networks, errors, stats).

import Docker from 'dockerode';
import { config } from '../config.ts';
import { normalizeDockerError } from './errors.ts';

export * from './containers.ts';
export * from './images.ts';
export * from './volumes.ts';
export * from './networks.ts';
export * from './errors.ts';
export * from './stats.ts';

type DockerOptions = ConstructorParameters<typeof Docker>[0];

function parseDockerHost(): DockerOptions {
  const host = config.dockerHost;
  const tls = config.dockerTls;

  if (!host) {
    return { socketPath: '/var/run/docker.sock' } as DockerOptions;
  }
  if (host.startsWith('unix://')) {
    return { socketPath: host.slice('unix://'.length) } as DockerOptions;
  }
  if (host.startsWith('npipe://')) {
    return { socketPath: host.slice('npipe://'.length) } as DockerOptions;
  }

  let protocol = 'http';
  let rest = host;
  if (host.startsWith('tcp://')) rest = host.slice('tcp://'.length);
  else if (host.startsWith('http://')) rest = host.slice('http://'.length);
  else if (host.startsWith('https://')) {
    rest = host.slice('https://'.length);
    protocol = 'https';
  }

  const [h, p] = rest.split(':');
  const opts: Record<string, unknown> = {
    host: h,
    port: Number(p || (protocol === 'https' ? 2376 : 2375)),
    protocol,
  };

  if (tls) {
    opts.protocol = 'https';
    opts.cert = tls.cert;
    opts.key = tls.key;
    if (tls.ca) opts.ca = tls.ca;
  }
  return opts as DockerOptions;
}

let cached: Docker | null = null;

/** Memoized dockerode client built from config.dockerHost / config.dockerTls. */
export function getDocker(): Docker {
  if (!cached) cached = new Docker(parseDockerHost());
  return cached;
}

export type DockerPing = {
  ok: boolean;
  version?: string;
  apiVersion?: string;
  os?: string;
  arch?: string;
  containers?: { total: number; running: number; paused: number; stopped: number };
  images?: number;
  error?: string;
};

export async function dockerPing(): Promise<DockerPing> {
  try {
    const docker = getDocker();
    await docker.ping();
    const v = (await docker.version()) as any;

    let info: any = null;
    try {
      info = await docker.info();
    } catch {
      info = null;
    }

    return {
      ok: true,
      version: v?.Version,
      apiVersion: v?.ApiVersion,
      os: v?.Os,
      arch: v?.Arch,
      containers: info
        ? {
            total: Number(info.Containers ?? 0),
            running: Number(info.ContainersRunning ?? 0),
            paused: Number(info.ContainersPaused ?? 0),
            stopped: Number(info.ContainersStopped ?? 0),
          }
        : undefined,
      images: info ? Number(info.Images ?? 0) : undefined,
    };
  } catch (err) {
    return { ok: false, error: normalizeDockerError(err).message };
  }
}

export async function dockerVersion(): Promise<{ ok: boolean; version?: string; error?: string }> {
  try {
    const v = (await getDocker().version()) as any;
    return { ok: true, version: v?.Version };
  } catch (err) {
    return { ok: false, error: normalizeDockerError(err).message };
  }
}
