// Dockyard — structured logger (owner: agent 1). Imported by every module.
//
// Emits single-line JSON to stdout. Level is taken from config.logLevel.
// `redact` deep-masks any key matching /token|password|secret|key|authorization/i.

import { config } from './config.ts';

export type LogMeta = Record<string, unknown>;

export type Logger = {
  debug(msg: string, meta?: LogMeta): void;
  info(msg: string, meta?: LogMeta): void;
  warn(msg: string, meta?: LogMeta): void;
  error(msg: string, meta?: LogMeta): void;
  child(bindings: LogMeta): Logger;
};

const LEVELS: Record<string, number> = { debug: 10, info: 20, warn: 30, error: 40, silent: 100 };
const REDACT_KEY = /token|password|secret|key|authorization/i;
const REDACTED = '***';

export function redact(obj: unknown): unknown {
  const seen = new WeakSet<object>();

  const walk = (value: unknown): unknown => {
    if (value === null || typeof value !== 'object') return value;
    if (seen.has(value as object)) return '[circular]';
    seen.add(value as object);

    if (Array.isArray(value)) return value.map((v) => walk(v));

    if (value instanceof Error) {
      return {
        name: value.name,
        message: value.message,
        stack: value.stack,
      };
    }
    if (value instanceof Date) return value.toISOString();

    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[k] = REDACT_KEY.test(k) ? REDACTED : walk(v);
    }
    return out;
  };

  return walk(obj);
}

function emit(level: keyof typeof LEVELS, bindings: LogMeta, msg: string, meta?: LogMeta): void {
  const threshold = LEVELS[config.logLevel] ?? LEVELS.info;
  if ((LEVELS[level] ?? 0) < threshold) return;

  const record: Record<string, unknown> = {
    time: new Date().toISOString(),
    level,
    msg,
    ...(redact(bindings) as Record<string, unknown>),
  };
  if (meta) Object.assign(record, redact(meta) as Record<string, unknown>);

  let line: string;
  try {
    line = JSON.stringify(record);
  } catch {
    line = JSON.stringify({ time: record.time, level, msg, meta: '[unserializable]' });
  }
  process.stdout.write(line + '\n');
}

function makeLogger(bindings: LogMeta): Logger {
  return {
    debug: (msg, meta) => emit('debug', bindings, msg, meta),
    info: (msg, meta) => emit('info', bindings, msg, meta),
    warn: (msg, meta) => emit('warn', bindings, msg, meta),
    error: (msg, meta) => emit('error', bindings, msg, meta),
    child: (extra) => makeLogger({ ...bindings, ...extra }),
  };
}

export const logger: Logger = makeLogger({});
