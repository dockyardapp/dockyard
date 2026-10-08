/**
 * Typed REST client for the Dockyard API (CONTRACT.md §6).
 * - Every request sends the session cookie (`credentials: 'include'`).
 * - Errors are parsed from the contract envelope
 *   `{ error: { code, message, details } }` and thrown as `ApiError`.
 */

import type {
  AdminUser,
  AuditEntry,
  CloudflareCredsResponse,
  CloudflareStatus,
  ContainerDetail,
  ContainerStats,
  ContainerSummary,
  CreateContainerInput,
  CreateContainerResponse,
  CreateTunnelInput,
  DeployResponse,
  ExecResponse,
  Grant,
  ImageSummary,
  LoginResponse,
  MeResponse,
  NetworkSummary,
  OkResponse,
  PublicUser,
  PullResponse,
  ResourceKind,
  ScopeMode,
  SettingsView,
  StackWithContainers,
  SystemInfo,
  Template,
  TemplateSpec,
  Tunnel,
  UserRole,
  VolumeSummary,
} from './types';

export class ApiError extends Error {
  status: number;
  code: string;
  details: unknown;

  constructor(status: number, code: string, message: string, details?: unknown) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

type Query = Record<string, string | number | boolean | undefined | null>;

function withQuery(path: string, query?: Query): string {
  if (!query) return path;
  const parts: string[] = [];
  for (const [k, v] of Object.entries(query)) {
    if (v === undefined || v === null || v === '') continue;
    parts.push(`${encodeURIComponent(k)}=${encodeURIComponent(String(v))}`);
  }
  return parts.length ? `${path}?${parts.join('&')}` : path;
}

async function parseError(res: Response): Promise<ApiError> {
  let code = 'internal';
  let message = `Request failed with status ${res.status}`;
  let details: unknown;
  const text = await res.text().catch(() => '');
  if (text) {
    try {
      const body = JSON.parse(text) as { error?: { code?: string; message?: string; details?: unknown } };
      if (body && typeof body === 'object' && body.error) {
        if (typeof body.error.code === 'string') code = body.error.code;
        if (typeof body.error.message === 'string') message = body.error.message;
        details = body.error.details;
      } else {
        message = text.slice(0, 300);
      }
    } catch {
      message = text.slice(0, 300);
    }
  }
  return new ApiError(res.status, code, message, details);
}

/**
 * Called when a request 401s outside the sign-in flow, which means the session
 * expired or was revoked. AuthProvider registers this so the app drops the user
 * and routes back to the login screen, instead of leaving every page showing a
 * load error with no way forward.
 */
let unauthorizedHandler: (() => void) | null = null;

export function setUnauthorizedHandler(fn: (() => void) | null): void {
  unauthorizedHandler = fn;
}

/** Paths where a 401 is the expected answer rather than a lost session. */
const SIGN_IN_PATHS = ['/api/auth/login', '/api/auth/bootstrap'];

function isSignInPath(path: string): boolean {
  return SIGN_IN_PATHS.includes(path);
}

async function request<T>(
  method: 'GET' | 'POST' | 'PATCH' | 'DELETE',
  path: string,
  opts: { query?: Query; body?: unknown; signal?: AbortSignal; text?: boolean } = {},
): Promise<T> {
  const init: RequestInit = {
    method,
    credentials: 'include',
    headers: { Accept: opts.text ? 'text/plain, */*' : 'application/json' },
    signal: opts.signal,
  };
  if (opts.body !== undefined) {
    (init.headers as Record<string, string>)['Content-Type'] = 'application/json';
    init.body = JSON.stringify(opts.body);
  }
  let res: Response;
  try {
    res = await fetch(withQuery(path, opts.query), init);
  } catch (err) {
    if (err instanceof DOMException && err.name === 'AbortError') throw err;
    throw new ApiError(0, 'network_error', 'Could not reach the Dockyard API.', String(err));
  }
  if (!res.ok) {
    const error = await parseError(res);
    if (error.status === 401 && !isSignInPath(path)) unauthorizedHandler?.();
    throw error;
  }
  if (res.status === 204) return undefined as T;
  if (opts.text) return (await res.text()) as unknown as T;
  const raw = await res.text();
  if (!raw) return undefined as T;
  return JSON.parse(raw) as T;
}

export const api = {
  get: <T>(path: string, query?: Query, signal?: AbortSignal) => request<T>('GET', path, { query, signal }),
  post: <T>(path: string, body?: unknown, query?: Query) => request<T>('POST', path, { body, query }),
  patch: <T>(path: string, body?: unknown) => request<T>('PATCH', path, { body }),
  del: <T>(path: string, query?: Query) => request<T>('DELETE', path, { query }),
  getText: (path: string, query?: Query, signal?: AbortSignal) =>
    request<string>('GET', path, { query, signal, text: true }),
};

/** Named, fully-typed endpoint bindings. */
export const endpoints = {
  system: {
    health: () => api.get<{ ok: true; uptime: number }>('/api/system/health'),
    info: () => api.get<SystemInfo>('/api/system/info'),
  },
  auth: {
    me: () => api.get<MeResponse>('/api/auth/me'),
    login: (email: string, password: string) => api.post<LoginResponse>('/api/auth/login', { email, password }),
    bootstrap: (email: string, password: string) =>
      api.post<LoginResponse>('/api/auth/bootstrap', { email, password }),
    logout: () => api.post<OkResponse>('/api/auth/logout'),
  },
  users: {
    list: () => api.get<AdminUser[]>('/api/users'),
    create: (input: {
      email: string;
      password: string;
      role: UserRole;
      scope_mode?: ScopeMode;
      can_exec?: boolean;
    }) => api.post<PublicUser>('/api/users', input),
    update: (
      id: string,
      input: { role?: UserRole; password?: string; scope_mode?: ScopeMode; can_exec?: boolean },
    ) => api.patch<PublicUser>(`/api/users/${encodeURIComponent(id)}`, input),
    remove: (id: string) => api.del<OkResponse>(`/api/users/${encodeURIComponent(id)}`),
    grants: (id: string) => api.get<Grant[]>(`/api/users/${encodeURIComponent(id)}/grants`),
    addGrant: (
      id: string,
      input: {
        resource_kind: ResourceKind;
        resource_id?: string;
        label_key?: string;
        label_value?: string;
      },
    ) => api.post<Grant>(`/api/users/${encodeURIComponent(id)}/grants`, input),
    clearGrants: (id: string) =>
      api.del<{ ok: boolean; removed: number }>(`/api/users/${encodeURIComponent(id)}/grants`),
    removeGrant: (id: string, grantId: string) =>
      api.del<OkResponse>(
        `/api/users/${encodeURIComponent(id)}/grants/${encodeURIComponent(grantId)}`,
      ),
  },
  containers: {
    list: (opts?: { all?: boolean; q?: string }) =>
      api.get<ContainerSummary[]>('/api/containers', { all: opts?.all ? 1 : undefined, q: opts?.q }),
    create: (input: CreateContainerInput) => api.post<CreateContainerResponse>('/api/containers', input),
    get: (id: string) => api.get<ContainerDetail>(`/api/containers/${encodeURIComponent(id)}`),
    inspect: (id: string) =>
      api.get<Record<string, unknown>>(`/api/containers/${encodeURIComponent(id)}/inspect`),
    action: (id: string, action: 'start' | 'stop' | 'restart' | 'kill' | 'pause' | 'unpause') =>
      api.post<ContainerSummary>(`/api/containers/${encodeURIComponent(id)}/${action}`),
    remove: (id: string, opts?: { force?: boolean; volumes?: boolean }) =>
      api.del<OkResponse>(`/api/containers/${encodeURIComponent(id)}`, {
        force: opts?.force ? 1 : undefined,
        volumes: opts?.volumes ? 1 : undefined,
      }),
    logs: (id: string, opts?: { tail?: number; since?: number }) =>
      api.getText(`/api/containers/${encodeURIComponent(id)}/logs`, { tail: opts?.tail, since: opts?.since }),
    stats: (id: string) => api.get<ContainerStats>(`/api/containers/${encodeURIComponent(id)}/stats`),
    exec: (id: string, cmd: string[]) =>
      api.post<ExecResponse>(`/api/containers/${encodeURIComponent(id)}/exec`, { cmd }),
  },
  images: {
    list: () => api.get<ImageSummary[]>('/api/images'),
    pull: (ref: string) => api.post<PullResponse>('/api/images/pull', { ref }),
    remove: (id: string, opts?: { force?: boolean }) =>
      api.del<OkResponse>(`/api/images/${encodeURIComponent(id)}`, { force: opts?.force ? 1 : undefined }),
  },
  volumes: {
    list: () => api.get<VolumeSummary[]>('/api/volumes'),
    create: (name: string, labels?: Record<string, string>) =>
      api.post<VolumeSummary>('/api/volumes', { name, labels }),
    remove: (name: string, opts?: { force?: boolean }) =>
      api.del<OkResponse>(`/api/volumes/${encodeURIComponent(name)}`, { force: opts?.force ? 1 : undefined }),
  },
  networks: {
    list: () => api.get<NetworkSummary[]>('/api/networks'),
    create: (name: string, driver?: string) => api.post<NetworkSummary>('/api/networks', { name, driver }),
    remove: (id: string) => api.del<OkResponse>(`/api/networks/${encodeURIComponent(id)}`),
  },
  templates: {
    list: (opts?: { category?: string; source?: string }) =>
      api.get<Template[]>('/api/templates', { category: opts?.category, source: opts?.source }),
    get: (slug: string) => api.get<Template>(`/api/templates/${encodeURIComponent(slug)}`),
    create: (spec: TemplateSpec) => api.post<Template>('/api/templates', { spec }),
    update: (slug: string, spec: TemplateSpec) =>
      api.patch<Template>(`/api/templates/${encodeURIComponent(slug)}`, { spec }),
    remove: (slug: string) => api.del<OkResponse>(`/api/templates/${encodeURIComponent(slug)}`),
    deploy: (slug: string, name: string, values: Record<string, string>) =>
      api.post<DeployResponse>(`/api/templates/${encodeURIComponent(slug)}/deploy`, { name, values }),
  },
  stacks: {
    list: () => api.get<StackWithContainers[]>('/api/stacks'),
    get: (id: string) => api.get<StackWithContainers>(`/api/stacks/${encodeURIComponent(id)}`),
    action: (id: string, action: 'start' | 'stop') =>
      api.post<StackWithContainers>(`/api/stacks/${encodeURIComponent(id)}/${action}`),
    remove: (id: string, opts?: { volumes?: boolean }) =>
      api.del<OkResponse>(`/api/stacks/${encodeURIComponent(id)}`, { volumes: opts?.volumes ? 1 : undefined }),
  },
  tunnels: {
    list: () => api.get<Tunnel[]>('/api/tunnels'),
    get: (id: string) => api.get<Tunnel>(`/api/tunnels/${encodeURIComponent(id)}`),
    create: (input: CreateTunnelInput) => api.post<Tunnel>('/api/tunnels', input),
    action: (id: string, action: 'start' | 'stop') =>
      api.post<Tunnel>(`/api/tunnels/${encodeURIComponent(id)}/${action}`),
    remove: (id: string) => api.del<OkResponse>(`/api/tunnels/${encodeURIComponent(id)}`),
  },
  cloudflare: {
    status: () => api.get<CloudflareStatus>('/api/cloudflare/status'),
    setCredentials: (apiToken: string | undefined, accountId: string) =>
      api.post<CloudflareCredsResponse>('/api/cloudflare/credentials', { apiToken, accountId }),
    clearCredentials: () => api.del<OkResponse>('/api/cloudflare/credentials'),
  },
  settings: {
    get: () => api.get<SettingsView>('/api/settings'),
    patch: (patch: Record<string, unknown>) => api.patch<SettingsView>('/api/settings', patch),
  },
  audit: {
    list: (opts?: { limit?: number; offset?: number; action?: string }) =>
      api.get<AuditEntry[]>('/api/audit', {
        limit: opts?.limit,
        offset: opts?.offset,
        action: opts?.action,
      }),
  },
};

/** Human-readable message for any thrown value. */
export function errorMessage(err: unknown): string {
  if (err instanceof ApiError) return err.message;
  if (err instanceof Error) return err.message;
  return String(err);
}
