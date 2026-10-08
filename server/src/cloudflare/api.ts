// Dockyard — Cloudflare API v4 client (owner: agent 3).
//
// Base https://api.cloudflare.com/client/v4, Bearer auth, unwraps the
// { success, result, errors } envelope and throws CloudflareError with the first error
// message. Credentials come from the `settings` table (token decrypted with secrets.ts),
// falling back to config.cloudflareApiToken / config.cloudflareAccountId.
//
// The token is never logged or returned. Only its fingerprint is ever logged.
//
// CLOUDFLARE_API_BASE may override the base URL (used by tests with a mock API).

import { config } from '../config.ts';
import { logger } from '../logger.ts';
import { decryptSecret, fingerprint } from '../secrets.ts';
import { one } from '../db/pool.ts';

export type CloudflareCreds = { apiToken: string; accountId: string };

export class CloudflareError extends Error {
  status: number | null;
  errors: unknown[];

  constructor(message: string, status: number | null = null, errors: unknown[] = []) {
    super(message);
    this.name = 'CloudflareError';
    this.status = status;
    this.errors = errors;
  }
}

const DEFAULT_BASE = 'https://api.cloudflare.com/client/v4';
const REQUEST_TIMEOUT_MS = Number(process.env.CLOUDFLARE_API_TIMEOUT_MS ?? 15_000);

function apiBase(): string {
  const override = (process.env.CLOUDFLARE_API_BASE ?? '').trim();
  return (override || DEFAULT_BASE).replace(/\/+$/, '');
}

type CfEnvelope<T> = {
  success?: boolean;
  result?: T;
  errors?: Array<{ code?: number; message?: string }>;
};

/** Read a raw `settings` value by key (jsonb -> JS value). */
async function readSetting(key: string): Promise<unknown> {
  try {
    const row = await one<{ value: unknown }>('select value from settings where key = $1', [key]);
    return row ? row.value : null;
  } catch (err) {
    logger.warn('could not read a cloudflare setting', {
      key,
      error: err instanceof Error ? err.message : String(err),
    });
    return null;
  }
}

function asString(value: unknown): string {
  if (typeof value === 'string') return value.trim();
  if (value && typeof value === 'object' && typeof (value as { value?: unknown }).value === 'string') {
    return ((value as { value: string }).value ?? '').trim();
  }
  return '';
}

/** Resolve Cloudflare credentials: settings table first, then env/config. */
export async function resolveCreds(): Promise<CloudflareCreds | null> {
  let apiToken = '';
  let accountId = '';

  const tokenRaw = await readSetting('cloudflare.api_token');
  const tokenBlob = asString(tokenRaw);
  if (tokenBlob) {
    try {
      apiToken = decryptSecret(tokenBlob);
    } catch (err) {
      logger.warn('stored cloudflare api token could not be decrypted', {
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  accountId = asString(await readSetting('cloudflare.account_id'));

  if (!apiToken) apiToken = (config.cloudflareApiToken ?? '').trim();
  if (!accountId) accountId = (config.cloudflareAccountId ?? '').trim();

  if (!apiToken || !accountId) return null;

  logger.debug('cloudflare credentials resolved', {
    accountId,
    tokenFingerprint: fingerprint(apiToken),
  });
  return { apiToken, accountId };
}

async function cfRequest<T>(
  method: string,
  apiPath: string,
  body?: unknown,
  creds?: CloudflareCreds,
): Promise<T> {
  const resolved = creds ?? (await resolveCreds());
  if (!resolved) {
    throw new CloudflareError('Cloudflare credentials are not configured');
  }

  const url = `${apiBase()}${apiPath.startsWith('/') ? apiPath : `/${apiPath}`}`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

  let response: Response;
  try {
    response = await fetch(url, {
      method,
      headers: {
        Authorization: `Bearer ${resolved.apiToken}`,
        'Content-Type': 'application/json',
        Accept: 'application/json',
      },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: controller.signal,
    });
  } catch (err) {
    clearTimeout(timer);
    const aborted = (err as { name?: string } | null)?.name === 'AbortError';
    throw new CloudflareError(
      aborted
        ? `Cloudflare API request timed out after ${REQUEST_TIMEOUT_MS}ms`
        : `Cloudflare API request failed: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
  clearTimeout(timer);

  const text = await response.text();
  let envelope: CfEnvelope<T> | null = null;
  try {
    envelope = text ? (JSON.parse(text) as CfEnvelope<T>) : null;
  } catch {
    envelope = null;
  }

  if (!envelope || typeof envelope !== 'object') {
    throw new CloudflareError(
      `Cloudflare API returned a non-JSON response (HTTP ${response.status})`,
      response.status,
    );
  }

  if (!response.ok || envelope.success === false) {
    const errors = Array.isArray(envelope.errors) ? envelope.errors : [];
    const message = errors[0]?.message || `Cloudflare API error (HTTP ${response.status})`;
    throw new CloudflareError(message, response.status, errors);
  }

  return envelope.result as T;
}

async function requireAccountId(): Promise<string> {
  const creds = await resolveCreds();
  if (!creds) throw new CloudflareError('Cloudflare credentials are not configured');
  return creds.accountId;
}

/** GET /user/tokens/verify — never throws; reports the outcome. */
export async function cfVerifyToken(): Promise<{ ok: boolean; tokenId?: string; error?: string }> {
  try {
    const result = await cfRequest<{ id?: string; status?: string }>('GET', '/user/tokens/verify');
    return { ok: result?.status === 'active', tokenId: result?.id };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

export async function cfListAccounts(): Promise<Array<{ id: string; name: string }>> {
  const result = await cfRequest<Array<{ id: string; name: string }>>('GET', '/accounts');
  return (result ?? []).map((a) => ({ id: a.id, name: a.name }));
}

export async function cfListZones(): Promise<Array<{ id: string; name: string; accountId: string }>> {
  const result = await cfRequest<
    Array<{ id: string; name: string; account?: { id?: string } }>
  >('GET', '/zones');
  return (result ?? []).map((z) => ({
    id: z.id,
    name: z.name,
    accountId: z.account?.id ?? '',
  }));
}

export async function cfCreateTunnel(name: string): Promise<{ id: string; name: string }> {
  const accountId = await requireAccountId();
  const result = await cfRequest<{ id: string; name: string }>(
    'POST',
    `/accounts/${accountId}/cfd_tunnel`,
    { name, config_src: 'cloudflare' },
  );
  return { id: result.id, name: result.name };
}

export async function cfGetTunnelToken(tunnelId: string): Promise<string> {
  const accountId = await requireAccountId();
  const result = await cfRequest<string>(
    'GET',
    `/accounts/${accountId}/cfd_tunnel/${tunnelId}/token`,
  );
  if (typeof result !== 'string' || result.length === 0) {
    throw new CloudflareError('Cloudflare API did not return a tunnel token');
  }
  return result;
}

export async function cfDeleteTunnel(tunnelId: string): Promise<void> {
  const accountId = await requireAccountId();
  await cfRequest<unknown>('DELETE', `/accounts/${accountId}/cfd_tunnel/${tunnelId}`);
}

export async function cfRouteDns(
  zoneId: string,
  hostname: string,
  tunnelId: string,
): Promise<{ id: string }> {
  const result = await cfRequest<{ id: string }>('POST', `/zones/${zoneId}/dns_records`, {
    type: 'CNAME',
    name: hostname,
    content: `${tunnelId}.cfargotunnel.com`,
    proxied: true,
  });
  return { id: result.id };
}

export async function cfListTunnels(): Promise<
  Array<{ id: string; name: string; status: string; connections: number }>
> {
  const accountId = await requireAccountId();
  const result = await cfRequest<
    Array<{ id: string; name: string; status: string; connections?: unknown[] }>
  >('GET', `/accounts/${accountId}/cfd_tunnel`);
  return (result ?? []).map((t) => ({
    id: t.id,
    name: t.name,
    status: t.status,
    connections: Array.isArray(t.connections) ? t.connections.length : 0,
  }));
}
