// Dockyard — ephemeral (quick) Cloudflare tunnels (owner: agent 3).
//
// `cloudflared tunnel --url <target> --no-autoupdate` creates an account-less tunnel and
// prints an assigned `https://<words>.trycloudflare.com` URL on stderr. The tunnel dies
// with the process. `--protocol http2` is added when DOCKYARD_CF_PROTOCOL=http2.

import { logger } from '../logger.ts';
import { createQuickUrlScanner, parseCloudflaredError } from './url-parse.ts';
import { spawnCloudflared } from './supervisor.ts';
import type { SpawnedTunnel } from './supervisor.ts';

export type QuickTunnel = {
  process: SpawnedTunnel;
  url: string;
};

export type StartQuickTunnelOptions = {
  /** How long to wait for the trycloudflare URL. Default 45s. */
  timeoutMs?: number;
};

/** Build the cloudflared argv for a quick tunnel against `target`. */
export function quickTunnelArgs(target: string): string[] {
  const args = ['tunnel', '--url', target, '--no-autoupdate'];
  if ((process.env.DOCKYARD_CF_PROTOCOL ?? '').trim().toLowerCase() === 'http2') {
    args.push('--protocol', 'http2');
  }
  return args;
}

/**
 * Start a quick tunnel and resolve with the process handle plus the public URL.
 * Rejects with a clear error if cloudflared exits first, reports a fatal error, or no URL
 * appears within the timeout.
 */
export function startQuickTunnel(
  target: string,
  opts: StartQuickTunnelOptions = {},
): Promise<QuickTunnel> {
  const timeoutMs = opts.timeoutMs ?? 45_000;
  const args = quickTunnelArgs(target);

  return new Promise<QuickTunnel>((resolve, reject) => {
    let settled = false;
    let timer: NodeJS.Timeout | null = null;
    let proc: SpawnedTunnel | undefined;
    const scanner = createQuickUrlScanner();

    const cleanup = (): void => {
      if (timer) {
        clearTimeout(timer);
        timer = null;
      }
    };

    const done = (fn: () => void): void => {
      if (settled) return;
      settled = true;
      cleanup();
      fn();
    };

    const fail = (message: string): void => {
      done(() => {
        try {
          proc?.kill();
        } catch {
          /* already gone */
        }
        reject(new Error(message));
      });
    };

    const onLine = (line: string, stream: 'stdout' | 'stderr'): void => {
      if (settled) return;
      logger.debug('cloudflared', { stream, line });
      const url = scanner.push(line + '\n');
      if (url) {
        done(() => resolve({ process: proc as SpawnedTunnel, url }));
        return;
      }
      const error = parseCloudflaredError(line);
      if (error) {
        logger.warn('cloudflared reported a fatal error before a URL', { error });
        fail(`cloudflared failed: ${error}`);
      }
    };

    proc = spawnCloudflared(args, { onLine });

    proc.onExit((code, signal) => {
      done(() =>
        reject(
          new Error(
            `cloudflared exited before providing a trycloudflare URL (code=${
              code ?? 'null'
            }${signal ? `, signal=${signal}` : ''})`,
          ),
        ),
      );
    });

    timer = setTimeout(() => {
      fail(`timed out after ${timeoutMs}ms waiting for a trycloudflare URL from cloudflared`);
    }, timeoutMs);
    if (typeof timer.unref === 'function') timer.unref();
  });
}
