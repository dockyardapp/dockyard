// Dockyard — LocalTunnel exposure (localtunnel.me).
//
// A third way to reach a container from outside, alongside the two Cloudflare
// modes: the client dials localtunnel.me, which hands back a public
// `https://<words>.loca.lt` URL and proxies it to the local target. No Cloudflare
// account, no DNS, no public IP. It is the lightest of the three to set up, and the
// least durable: the URL is assigned by a third party and changes on every start.
//
// Unlike the Cloudflare modes this is a library, not a child process, so the handle
// below implements the same `SpawnedTunnel` surface (pid/kill/onExit) the manager
// already drives. `pid` is null because there is no process to signal.

import { logger } from '../logger.ts';
import type { SpawnedTunnel } from './supervisor.ts';

export type StartedLocalTunnel = {
  process: SpawnedTunnel;
  url: string;
};

export type StartLocalTunnelOptions = {
  /** How long to wait for a public URL. Default 30s. */
  timeoutMs?: number;
  /**
   * A subdomain to ask for, so the URL can survive a restart. localtunnel.me may
   * refuse or ignore it; a refusal falls back to an assigned one rather than
   * failing the tunnel.
   */
  subdomain?: string;
};

/**
 * Split a target URL into the host and port localtunnel needs.
 *
 * The manager stores targets as URLs (`http://127.0.0.1:8080`), while localtunnel
 * wants a port and an optional local host.
 */
export function localTargetParts(target: string): { host: string; port: number } {
  let url: URL;
  try {
    url = new URL(target);
  } catch {
    throw new Error(
      `target '${target}' is not a URL; localtunnel needs a target like http://127.0.0.1:8080`,
    );
  }
  const port = url.port
    ? Number(url.port)
    : url.protocol === 'https:'
      ? 443
      : url.protocol === 'http:'
        ? 80
        : Number.NaN;
  if (!Number.isInteger(port) || port <= 0 || port > 65535) {
    throw new Error(`target '${target}' does not name a usable port`);
  }
  return { host: url.hostname || '127.0.0.1', port };
}

/**
 * Turn a tunnel name into something localtunnel.me will accept as a subdomain.
 * Returns undefined when there is nothing usable left, so the caller asks for an
 * assigned subdomain instead of sending a request that is certain to be refused.
 */
export function sanitiseSubdomain(name: string): string | undefined {
  const cleaned = name
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, '-')
    .replace(/-{2,}/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40);
  // Shorter than 3 characters is not a valid subdomain label.
  return cleaned.length >= 3 ? cleaned : undefined;
}

/** Wrap a live localtunnel client in the SpawnedTunnel surface the manager uses. */
function handleFor(client: { close(): void; on(event: string, cb: (arg?: unknown) => void): void }): SpawnedTunnel {
  let closed = false;
  let exitCode: number | null = null;
  let exitSignal: string | null = null;
  const exitCallbacks: Array<(code: number | null, signal: string | null) => void> = [];

  const finish = (code: number | null, signal: string | null): void => {
    if (closed) return;
    closed = true;
    exitCode = code;
    exitSignal = signal;
    for (const cb of exitCallbacks.splice(0)) {
      try {
        cb(code, signal);
      } catch (err) {
        logger.error('localtunnel onExit handler threw', {
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }
  };

  client.on('close', () => finish(0, null));
  client.on('error', (err) => {
    logger.warn('localtunnel reported an error', {
      error: err instanceof Error ? err.message : String(err),
    });
    finish(1, null);
  });

  return {
    pid: null,
    kill(): void {
      if (closed) return;
      try {
        client.close();
      } catch {
        /* already gone */
      }
      finish(0, null);
    },
    onExit(cb: (code: number | null, signal: string | null) => void): void {
      if (closed) {
        queueMicrotask(() => cb(exitCode, exitSignal));
        return;
      }
      exitCallbacks.push(cb);
    },
  };
}

async function open(subdomain: string | undefined, host: string, port: number) {
  const mod = (await import('localtunnel')) as unknown as {
    default?: (options: Record<string, unknown>) => Promise<{
      url: string;
      close(): void;
      on(event: string, cb: (arg?: unknown) => void): void;
    }>;
  };
  const localtunnel = mod.default;
  if (typeof localtunnel !== 'function') {
    throw new Error('the localtunnel module did not export a function; check the installed version');
  }
  return localtunnel({
    port,
    local_host: host,
    ...(subdomain ? { subdomain } : {}),
  });
}

/**
 * Open a LocalTunnel to `target` and resolve with the handle plus the public URL.
 *
 * Rejects if the target is unusable, if localtunnel.me cannot be reached, or if no
 * URL appears within the timeout.
 */
export function startLocalTunnel(
  target: string,
  opts: StartLocalTunnelOptions = {},
): Promise<StartedLocalTunnel> {
  const timeoutMs = opts.timeoutMs ?? 30_000;
  const { host, port } = localTargetParts(target);
  const requested = opts.subdomain ? sanitiseSubdomain(opts.subdomain) : undefined;

  return new Promise<StartedLocalTunnel>((resolve, reject) => {
    let settled = false;
    let handle: SpawnedTunnel | null = null;

    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      try {
        handle?.kill();
      } catch {
        /* already gone */
      }
      reject(new Error(`timed out after ${timeoutMs}ms waiting for a localtunnel URL`));
    }, timeoutMs);
    if (typeof timer.unref === 'function') timer.unref();

    const settle = (fn: () => void): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      fn();
    };

    void (async () => {
      let client: Awaited<ReturnType<typeof open>>;
      try {
        client = await open(requested, host, port);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        // A refused subdomain is not a reason to fail the tunnel: localtunnel.me
        // rejects a name that is taken or reserved, and an assigned one works.
        if (requested) {
          logger.warn('localtunnel refused the requested subdomain; asking for an assigned one', {
            subdomain: requested,
            error: message,
          });
          try {
            client = await open(undefined, host, port);
          } catch (retryErr) {
            const retryMessage = retryErr instanceof Error ? retryErr.message : String(retryErr);
            settle(() => reject(new Error(`localtunnel failed to open: ${retryMessage}`)));
            return;
          }
        } else {
          settle(() => reject(new Error(`localtunnel failed to open: ${message}`)));
          return;
        }
      }

      handle = handleFor(client);
      settle(() => resolve({ process: handle as SpawnedTunnel, url: client.url }));
    })();
  });
}
