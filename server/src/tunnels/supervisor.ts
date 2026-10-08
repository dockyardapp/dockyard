// Dockyard — cloudflared process supervisor (owner: agent 3).
//
// Spawns config.cloudflaredBin with piped stdio, line-buffers stdout/stderr separately,
// strips ANSI, and delivers one callback per complete line. kill() is SIGTERM-then-SIGKILL
// and is safe to call more than once. A missing binary (ENOENT) is reported through onLine
// and the exit callbacks rather than throwing an unhandled exception.

import { spawn } from 'node:child_process';
import type { ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import { config } from '../config.ts';
import { logger } from '../logger.ts';
import { stripAnsi } from './url-parse.ts';

export type SpawnedTunnel = {
  pid: number | null;
  kill(signal?: NodeJS.Signals): void;
  onExit(cb: (code: number | null, signal: string | null) => void): void;
};

export type SpawnCloudflaredOptions = {
  env?: Record<string, string>;
  onLine: (line: string, stream: 'stdout' | 'stderr') => void;
};

const KILL_GRACE_MS = 5_000;

export function spawnCloudflared(args: string[], opts: SpawnCloudflaredOptions): SpawnedTunnel {
  try {
    fs.mkdirSync(config.dataDir, { recursive: true });
  } catch {
    /* best effort — spawn will surface a real failure below */
  }

  let child: ChildProcess | null = null;
  let exited = false;
  let exitCode: number | null = null;
  let exitSignal: string | null = null;
  let killTimer: NodeJS.Timeout | null = null;
  let terminating = false;
  const exitCallbacks: Array<(code: number | null, signal: string | null) => void> = [];

  const deliver = (line: string, stream: 'stdout' | 'stderr'): void => {
    try {
      opts.onLine(line, stream);
    } catch (err) {
      logger.error('cloudflared onLine handler threw', {
        error: err instanceof Error ? err.message : String(err),
      });
    }
  };

  const finish = (code: number | null, signal: string | null): void => {
    if (exited) return;
    exited = true;
    exitCode = code;
    exitSignal = signal;
    if (killTimer) {
      clearTimeout(killTimer);
      killTimer = null;
    }
    for (const cb of exitCallbacks.splice(0)) {
      try {
        cb(code, signal);
      } catch (err) {
        logger.error('cloudflared onExit handler threw', {
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }
  };

  const attachLineReader = (
    stream: NodeJS.ReadableStream | null,
    name: 'stdout' | 'stderr',
  ): void => {
    if (!stream) return;
    let buf = '';
    stream.setEncoding('utf8');
    stream.on('data', (chunk: string) => {
      buf += chunk;
      let idx: number;
      while ((idx = buf.indexOf('\n')) !== -1) {
        const line = buf.slice(0, idx).replace(/\r$/, '');
        buf = buf.slice(idx + 1);
        deliver(stripAnsi(line), name);
      }
      // Guard against a stream that never emits a newline.
      if (buf.length > 1_000_000) buf = buf.slice(-4096);
    });
    stream.on('end', () => {
      if (buf.length > 0) {
        deliver(stripAnsi(buf), name);
        buf = '';
      }
    });
  };

  try {
    child = spawn(config.cloudflaredBin, args, {
      stdio: ['ignore', 'pipe', 'pipe'],
      cwd: config.dataDir,
      env: { ...process.env, ...(opts.env ?? {}) } as NodeJS.ProcessEnv,
    });
  } catch (err) {
    const message = `failed to spawn cloudflared '${config.cloudflaredBin}': ${
      err instanceof Error ? err.message : String(err)
    }`;
    logger.error('cloudflared spawn threw', { error: message });
    deliver(message, 'stderr');
    queueMicrotask(() => finish(127, null));
  }

  if (child) {
    child.on('error', (err: NodeJS.ErrnoException) => {
      const message =
        err.code === 'ENOENT'
          ? `cloudflared binary not found at '${config.cloudflaredBin}' (ENOENT); install cloudflared or set CLOUDFLARED_BIN`
          : `cloudflared process error: ${err.message}`;
      logger.error('cloudflared process error', { error: message, code: err.code });
      deliver(message, 'stderr');
      finish(127, null);
    });
    child.on('exit', (code, signal) => finish(code, signal));
    child.on('close', (code, signal) => finish(code, signal));
    attachLineReader(child.stdout, 'stdout');
    attachLineReader(child.stderr, 'stderr');
  }

  const kill = (signal?: NodeJS.Signals): void => {
    if (exited || !child) return;
    if (signal) {
      try {
        child.kill(signal);
      } catch {
        /* already gone */
      }
      return;
    }
    if (terminating) return; // idempotent: a graceful stop is already in flight
    terminating = true;
    try {
      child.kill('SIGTERM');
    } catch {
      /* already gone */
    }
    killTimer = setTimeout(() => {
      if (exited || !child) return;
      logger.warn('cloudflared did not exit after SIGTERM; sending SIGKILL', { pid: child.pid });
      try {
        child.kill('SIGKILL');
      } catch {
        /* already gone */
      }
    }, KILL_GRACE_MS);
    if (typeof killTimer.unref === 'function') killTimer.unref();
  };

  const onExit = (cb: (code: number | null, signal: string | null) => void): void => {
    if (exited) {
      queueMicrotask(() => cb(exitCode, exitSignal));
      return;
    }
    exitCallbacks.push(cb);
  };

  return {
    get pid(): number | null {
      return child?.pid ?? null;
    },
    kill,
    onExit,
  };
}
