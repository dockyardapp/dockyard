// Dockyard — configuration (owner: agent 1).
//
// Loads <repoRoot>/.env itself (without overwriting variables already present in
// process.env), resolves the repo root by walking up from this module until it finds
// the directory containing CONTRACT.md, and exposes a single frozen `config` object.

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

export type Config = {
  env: 'development' | 'production' | 'test';
  port: number;
  host: string;
  logLevel: string;
  publicUrl: string;
  databaseUrl: string;
  dockerHost: string; // '' => default socket
  dockerTls?: { cert: string; key: string; ca: string };
  cloudflaredBin: string; // default 'cloudflared'
  tunnelDataDir: string; // default '<root>/data/tunnels'
  dataDir: string; // default '<root>/data'
  cloudflareApiToken: string;
  cloudflareAccountId: string;
  secretKey: string; // 64 hex chars
  sessionTtlHours: number;
  cookieSecure: boolean;
  adminEmail: string;
  adminPassword: string;
  /**
   * Login attempts allowed per IP per minute. Deliberately low by default; the
   * end-to-end suite raises it because it signs in many throwaway accounts.
   */
  loginRateMax: number;
};

const moduleDir = path.dirname(fileURLToPath(import.meta.url));

function findRepoRoot(start: string): string {
  let dir = path.resolve(start);
  for (let i = 0; i < 25; i++) {
    if (fs.existsSync(path.join(dir, 'CONTRACT.md'))) return dir;
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  // Fallback: server/src/config.ts -> repo root is two levels up.
  return path.resolve(start, '..', '..');
}

export const repoRoot: string = findRepoRoot(moduleDir);

/** Parse a .env file into process.env without clobbering already-set variables. */
export function loadEnvFile(envPath?: string): void {
  const file = envPath ?? path.join(repoRoot, '.env');
  let raw: string;
  try {
    raw = fs.readFileSync(file, 'utf8');
  } catch {
    return; // no .env — rely on the ambient environment
  }
  for (const line of raw.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eq = trimmed.indexOf('=');
    if (eq === -1) continue;
    const key = trimmed.slice(0, eq).trim();
    if (!key || !/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) continue;
    let value = trimmed.slice(eq + 1).trim();
    // Strip a single layer of surrounding quotes.
    if (
      (value.startsWith('"') && value.endsWith('"') && value.length >= 2) ||
      (value.startsWith("'") && value.endsWith("'") && value.length >= 2)
    ) {
      value = value.slice(1, -1);
    }
    if (!(key in process.env)) process.env[key] = value;
  }
}

function resolveDir(value: string | undefined, fallbackRel: string): string {
  const raw = (value ?? '').trim() || fallbackRel;
  return path.isAbsolute(raw) ? raw : path.resolve(repoRoot, raw);
}

function readMaybeFile(value: string | undefined): string | undefined {
  const raw = (value ?? '').trim();
  if (!raw) return undefined;
  // If it points at a readable file, use its contents; otherwise treat as inline PEM.
  try {
    if (fs.existsSync(raw) && fs.statSync(raw).isFile()) return fs.readFileSync(raw, 'utf8');
  } catch {
    /* fall through to inline */
  }
  return raw;
}

function buildDockerTls(): { cert: string; key: string; ca: string } | undefined {
  const cert = readMaybeFile(process.env.DOCKER_TLS_CERT);
  const key = readMaybeFile(process.env.DOCKER_TLS_KEY);
  if (!cert || !key) return undefined;
  const ca = readMaybeFile(process.env.DOCKER_TLS_CA) ?? '';
  return { cert, key, ca };
}

/**
 * Secure cookies fail closed.
 *
 * `COOKIE_SECURE` unset used to mean `false`, so a production host would send
 * the session cookie over plain HTTP while the operator believed TLS was
 * handled. Unset now means "secure in production", and an explicit `false` in
 * production is refused at boot rather than shipped.
 */
function resolveCookieSecure(env: Config['env']): boolean {
  const raw = (process.env.COOKIE_SECURE ?? '').trim().toLowerCase();
  const truthy = ['true', '1', 'yes'];
  const falsy = ['false', '0', 'no'];

  let enabled: boolean;
  if (raw === '') enabled = env === 'production';
  else if (truthy.includes(raw)) enabled = true;
  else if (falsy.includes(raw)) enabled = false;
  else throw new Error(`COOKIE_SECURE must be true or false, got '${raw}'`);

  if (env === 'production' && !enabled) {
    throw new Error(
      'COOKIE_SECURE=false with NODE_ENV=production would send the session cookie over plain ' +
        'HTTP. Terminate TLS in front of Dockyard and set COOKIE_SECURE=true.',
    );
  }
  return enabled;
}

/** Parse a positive integer from the environment, falling back when absent or junk. */
function positiveInt(value: string | undefined, fallback: number): number {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : fallback;
}

function buildConfig(): Config {
  const envRaw = (process.env.NODE_ENV ?? '').trim();
  const env: Config['env'] =
    envRaw === 'production' ? 'production' : envRaw === 'test' ? 'test' : 'development';

  const secretRaw = (process.env.SECRET_KEY ?? '').trim();
  const secretKey = secretRaw.length > 0 ? secretRaw : crypto.randomBytes(32).toString('hex');

  const dataDir = resolveDir(process.env.DOCKYARD_DATA_DIR ?? process.env.DATA_DIR, 'data');
  const tunnelDataDir = resolveDir(process.env.TUNNEL_DATA_DIR, path.join('data', 'tunnels'));

  return {
    env,
    port: Number(process.env.PORT ?? 8000),
    host: process.env.HOST ?? '0.0.0.0',
    logLevel: (process.env.LOG_LEVEL ?? 'info').toLowerCase(),
    publicUrl: (process.env.PUBLIC_URL ?? 'http://localhost:8000').replace(/\/+$/, ''),
    databaseUrl: (process.env.DATABASE_URL ?? '').trim(),
    dockerHost: (process.env.DOCKER_HOST ?? '').trim(),
    dockerTls: buildDockerTls(),
    cloudflaredBin: (process.env.CLOUDFLARED_BIN ?? '').trim() || 'cloudflared',
    tunnelDataDir,
    dataDir,
    cloudflareApiToken: (process.env.CLOUDFLARE_API_TOKEN ?? '').trim(),
    cloudflareAccountId: (process.env.CLOUDFLARE_ACCOUNT_ID ?? '').trim(),
    secretKey,
    sessionTtlHours: Number(process.env.SESSION_TTL_HOURS ?? 168),
    cookieSecure: resolveCookieSecure(env),
    adminEmail: (process.env.DOCKYARD_ADMIN_EMAIL ?? '').trim(),
    adminPassword: process.env.DOCKYARD_ADMIN_PASSWORD ?? '',
    loginRateMax: positiveInt(process.env.DOCKYARD_LOGIN_RATE_MAX, 10),
  };
}

loadEnvFile();

export const config: Config = buildConfig();
