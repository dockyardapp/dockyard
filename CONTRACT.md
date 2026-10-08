# Dockyard — build contract (FROZEN)

A unified control panel for Docker containers. Node.js + Postgres + React.
Simpler than Portainer: three surfaces (containers, templates, tunnels) plus the plumbing.
Built-in tunnel support: **ephemeral (quick)** and **persistent (named)** Cloudflare tunnels, plus
**LocalTunnel** (no account, no DNS).

Every agent codes against this document. If you believe the contract is wrong, **do not
silently change it** — implement it as written and report the problem in your summary.

---

## 0. Hard rules for every agent

1. **Read this whole file before writing code.**
2. **Only create or edit files in your ownership list** (§9). Never touch another agent's files.
   If a file you depend on does not exist yet, write your import anyway, exactly as specified.
3. Server code is **TypeScript run directly by Node 26** (native type stripping). Therefore:
   - Every relative import **must carry the `.ts` extension**: `import { pool } from '../db/pool.ts'`.
   - **Erasable syntax only** — no `enum`, no `namespace`, no parameter properties, no
     `declare`-only class fields. Use `const` objects + union types instead of enums.
   - `import type { X } from './y.ts'` for type-only imports (verbatimModuleSyntax is on).
4. Node/npm are **not on PATH**. Prefix every shell command:
   `export PATH=/root/.hermes/node/bin:$PATH`
5. Repo root is `/root/hermes-workspace/dockyard`. `node_modules` is already installed —
   **do not run `npm install`** except inside your own scratch dir.
6. Postgres 17 is live locally on `127.0.0.1:5432`. Connection string is in `dockyard/.env`
   (already generated; read it, never print the password).
7. No new runtime dependencies. Allowed server deps are exactly:
   `fastify`, `@fastify/cookie`, `@fastify/static`, `@fastify/websocket`, `@fastify/rate-limit`,
   `pg`, `dockerode`, `zod`, `yaml`. Allowed web deps: `react`, `react-dom`, `react-router-dom`.
   Use `node:crypto` for hashing/encryption, hand-rolled SVG for charts.
8. **Never invent UI data.** No fake metrics, fake hostnames, fake container names in shipped code.
9. Write real tests where §9 says so and actually run them.
10. Report at the end: files written, exact commands run, real observed output, what you could
    not verify. Never claim something works that you did not observe.

---

## 1. Layout & ports

```
dockyard/
  CONTRACT.md            (this file, frozen)
  package.json           (npm workspaces: server, web)
  .env / .env.example
  server/
    package.json  tsconfig.json
    src/
      index.ts           boot: config → migrate → buildApp → listen
      app.ts             fastify instance + plugin/route registration
      config.ts  logger.ts  events.ts  secrets.ts  stacks.ts
      db/                pool.ts  migrate.ts  migrations/NNN_*.sql
      docker/            index.ts containers.ts images.ts volumes.ts networks.ts errors.ts stats.ts
      auth/              password.ts sessions.ts rbac.ts audit.ts
      routes/            auth.ts system.ts containers.ts images.ts volumes.ts networks.ts
                         templates.ts stacks.ts tunnels.ts settings.ts audit.ts users.ts
      ws/                logs.ts stats.ts events.ts
      tunnels/           manager.ts supervisor.ts quick.ts named.ts localtunnel.ts url-parse.ts
      cloudflare/        api.ts
      templates/         schema.ts catalog.ts engine.ts
    test/                *.test.ts  mock-docker.ts
  web/
    index.html vite.config.ts tsconfig.json
    src/                 main.tsx App.tsx styles/ api/ components/ pages/ hooks/
```

Ports: API `8000`, Vite dev `5190`. Production: Fastify serves `web/dist` and the SPA fallback.

---

## 2. Config (`server/src/config.ts`) — owner: agent 1

```ts
export type Config = {
  env: 'development' | 'production' | 'test';
  port: number; host: string; logLevel: string; publicUrl: string;
  databaseUrl: string;
  dockerHost: string;                                  // '' => default socket
  dockerTls?: { cert: string; key: string; ca: string };
  cloudflaredBin: string;                              // default 'cloudflared'
  tunnelDataDir: string;                               // default '<root>/data/tunnels'
  tunnelTargetHost: string;                            // default '127.0.0.1'; host used when a tunnel targets a container's published port (set to host.docker.internal when the panel itself runs in a container)
  dataDir: string;                                     // default '<root>/data'
  cloudflareApiToken: string; cloudflareAccountId: string;
  secretKey: string;                                   // 64 hex chars
  sessionTtlHours: number; cookieSecure: boolean;
  adminEmail: string; adminPassword: string;           // optional first-boot admin
};
export const config: Config;
export const repoRoot: string;                         // absolute path of dockyard/
export function loadEnvFile(path?: string): void;      // parses <repoRoot>/.env into process.env (no overwrite of existing)
```

`server/src/logger.ts` — also agent 1, imported by everyone:

```ts
export type LogMeta = Record<string, unknown>;
export type Logger = {
  debug(msg: string, meta?: LogMeta): void;
  info(msg: string, meta?: LogMeta): void;
  warn(msg: string, meta?: LogMeta): void;
  error(msg: string, meta?: LogMeta): void;
  child(bindings: LogMeta): Logger;
};
export const logger: Logger;   // single-line JSON to stdout, level from config.logLevel
export function redact(obj: unknown): unknown;   // deep-masks keys matching /token|password|secret|key|authorization/i
```

---

## 3. Postgres schema — owner: agent 1 (migrations), read-only for everyone else

`server/src/db/migrate.ts` creates `schema_migrations(id text primary key, applied_at timestamptz
not null default now())` if absent, then applies `migrations/NNN_name.sql` in filename order,
each inside a transaction. Exports:

```ts
export async function runMigrations(): Promise<{ applied: string[]; already: string[] }>;
export async function migrationStatus(): Promise<Array<{ id: string; applied_at: string | null }>>;
```
Runnable as a CLI: `node server/src/db/migrate.ts`.

### `001_init.sql` — exact DDL

```sql
create extension if not exists pgcrypto;

create table if not exists users (
  id uuid primary key default gen_random_uuid(),
  email text not null unique,
  password_hash text not null,
  role text not null default 'admin' check (role in ('admin','operator','viewer')),
  created_at timestamptz not null default now(),
  last_login_at timestamptz
);

create table if not exists sessions (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references users(id) on delete cascade,
  token_hash text not null unique,
  user_agent text, ip text,
  created_at timestamptz not null default now(),
  expires_at timestamptz not null
);
create index if not exists sessions_user_id_idx on sessions(user_id);
create index if not exists sessions_expires_at_idx on sessions(expires_at);

create table if not exists audit_log (
  id bigserial primary key,
  user_id uuid references users(id) on delete set null,
  action text not null, target_type text not null, target_id text,
  detail jsonb, ip text,
  created_at timestamptz not null default now()
);
create index if not exists audit_log_created_at_idx on audit_log(created_at desc);

create table if not exists templates (
  id uuid primary key default gen_random_uuid(),
  slug text not null unique,
  name text not null,
  category text not null default 'other',
  icon text not null default 'package',
  description text not null default '',
  spec jsonb not null,
  source text not null default 'user' check (source in ('builtin','user')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists stacks (
  id uuid primary key default gen_random_uuid(),
  name text not null, slug text not null,
  source text not null default 'template' check (source in ('template','user')),
  template_slug text,
  spec jsonb not null default '{}'::jsonb,
  values jsonb not null default '{}'::jsonb,
  status text not null default 'running' check (status in ('running','stopped','partial','error')),
  created_by uuid references users(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists stacks_slug_idx on stacks(slug);

create table if not exists tunnels (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  mode text not null check (mode in ('quick','named','localtunnel')),
  target_url text not null,
  container_id text, port integer,
  hostname text, zone_id text, tunnel_id text,
  credentials_path text, config_path text,
  status text not null default 'stopped' check (status in ('stopped','starting','running','error')),
  url text, pid integer, last_error text,
  auto_start boolean not null default false,
  created_by uuid references users(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists settings (
  key text primary key,
  value jsonb not null,
  secret boolean not null default false,
  updated_at timestamptz not null default now()
);
```

Add further migrations only if genuinely needed. Never edit an applied migration.

---

## 4. Data access (`server/src/db/pool.ts`) — owner: agent 1

```ts
import type { Pool, PoolClient, QueryResult } from 'pg';
export const pool: Pool;
export function query<T = any>(text: string, params?: unknown[]): Promise<QueryResult<T>>;
export function one<T = any>(text: string, params?: unknown[]): Promise<T | null>;   // first row or null
export function many<T = any>(text: string, params?: unknown[]): Promise<T[]>;
export function tx<T>(fn: (client: PoolClient) => Promise<T>): Promise<T>;
export async function closePool(): Promise<void>;
export async function dbHealth(): Promise<{ ok: boolean; serverVersion?: string; error?: string }>;
```
Placeholders are `$1, $2, …` (node-postgres native). JSONB columns are returned as JS objects.

---

## 5. Docker engine layer (`server/src/docker/`) — owner: agent 1

`index.ts` re-exports everything from `containers.ts`, `images.ts`, `volumes.ts`, `networks.ts`,
`errors.ts`, and:

```ts
export function getDocker(): Docker;                    // memoized dockerode client from config
export async function dockerPing(): Promise<{ ok: boolean; version?: string; apiVersion?: string;
  os?: string; arch?: string; containers?: { total: number; running: number; paused: number; stopped: number };
  images?: number; error?: string }>;
export async function dockerVersion(): Promise<{ ok: boolean; version?: string; error?: string }>;
```

### containers.ts

```ts
export type ContainerState = 'running'|'exited'|'created'|'paused'|'restarting'|'dead'|'removing';
export type ContainerSummary = {
  id: string; name: string; image: string; imageId: string; state: ContainerState; status: string;
  created: number; health: string | null;
  ports: Array<{ ip?: string; privatePort: number; publicPort?: number; type: string }>;
  labels: Record<string, string>;
  managed: boolean;                 // labels['dockyard.managed'] === 'true'
  stackId: string | null;           // labels['dockyard.stack'] ?? null
  templateSlug: string | null;      // labels['dockyard.template'] ?? null
};
export type ContainerDetail = ContainerSummary & {
  command: string; entrypoint: string; env: string[];
  mounts: Array<{ source: string; destination: string; mode: string; rw: boolean; type: string }>;
  networks: Array<{ name: string; ip: string | null }>;
  restartPolicy: string; startedAt: string | null; finishedAt: string | null;
  exitCode: number | null; platform: string;
};
export type ContainerStats = {
  cpuPercent: number; memUsed: number; memLimit: number; memPercent: number;
  netRx: number; netTx: number; blkRead: number; blkWrite: number; pids: number; readAt: string;
};
export type CreateContainerInput = {
  name: string; image: string; cmd?: string[]; entrypoint?: string[];
  env?: Record<string, string>;
  ports?: Array<{ host?: number; container: number; proto?: 'tcp' | 'udp' }>;
  volumes?: Array<{ host?: string; container: string; mode?: string }>;
  restartPolicy?: 'no' | 'always' | 'unless-stopped' | 'on-failure';
  labels?: Record<string, string>;
  network?: string;
  pull?: boolean;                   // pull image first if missing (default true)
};
export function listContainers(opts?: { all?: boolean; q?: string }): Promise<ContainerSummary[]>;
export function getContainer(id: string): Promise<ContainerDetail>;         // throws DockerError 404
export function inspectContainer(id: string): Promise<Record<string, unknown>>;
export function createContainer(input: CreateContainerInput): Promise<{ id: string; name: string; warnings: string[] }>;
export function startContainer(id: string): Promise<void>;
export function stopContainer(id: string, timeoutSec?: number): Promise<void>;
export function restartContainer(id: string, timeoutSec?: number): Promise<void>;
export function killContainer(id: string, signal?: string): Promise<void>;
export function pauseContainer(id: string): Promise<void>;
export function unpauseContainer(id: string): Promise<void>;
export function removeContainer(id: string, opts?: { force?: boolean; volumes?: boolean }): Promise<void>;
export function containerLogs(id: string, opts?: { tail?: number; since?: number; timestamps?: boolean }): Promise<string>;
export function containerLogsStream(id: string, opts?: { tail?: number }): Promise<NodeJS.ReadableStream>;
export function containerStats(id: string): Promise<ContainerStats>;
export function containerStatsStream(id: string): Promise<NodeJS.ReadableStream>;
export function execInContainer(id: string, cmd: string[], opts?: { timeoutMs?: number }): Promise<{ stdout: string; stderr: string; exitCode: number }>;
export function pruneContainers(): Promise<{ deleted: string[]; spaceReclaimed: number }>;
export function resolveContainer(idOrName: string): Promise<ContainerSummary | null>;   // id prefix, exact name, or /name
```

Notes: `containerStats` is computed from one `stats` frame with `stream:false`
(CPU% = `cpu_stats.cpu_usage.total_usage - precpu_stats.cpu_usage.total_usage` over the same
delta of `system_cpu_usage`, × `online_cpus`; memory from `memory_stats.usage - stats.cache`).
Container names in summaries are returned **without** the leading `/`.

### images.ts

```ts
export type ImageSummary = { id: string; repoTags: string[]; repoDigests: string[]; size: number;
  created: number; containers: number; dangling: boolean };
export function listImages(): Promise<ImageSummary[]>;
export function pullImage(ref: string, onProgress?: (ev: { status: string; id?: string; progress?: string }) => void): Promise<{ ref: string }>;
export function removeImage(id: string, opts?: { force?: boolean }): Promise<void>;
export function pruneImages(): Promise<{ deleted: string[]; spaceReclaimed: number }>;
export function inspectImage(id: string): Promise<Record<string, unknown>>;
```

### volumes.ts / networks.ts

```ts
export type VolumeSummary = { name: string; driver: string; mountpoint: string; created: string;
  labels: Record<string, string>; inUseBy: string[] };
export function listVolumes(): Promise<VolumeSummary[]>;
export function createVolume(name: string, labels?: Record<string, string>): Promise<VolumeSummary>;
export function removeVolume(name: string, opts?: { force?: boolean }): Promise<void>;
export function pruneVolumes(): Promise<{ deleted: string[]; spaceReclaimed: number }>;

export type NetworkSummary = { id: string; name: string; driver: string; scope: string;
  internal: boolean; containers: Array<{ id: string; name: string }>; labels: Record<string, string> };
export function listNetworks(): Promise<NetworkSummary[]>;
export function createNetwork(name: string, opts?: { driver?: string; labels?: Record<string, string> }): Promise<NetworkSummary>;
export function removeNetwork(id: string): Promise<void>;
```

### errors.ts

```ts
export class DockerError extends Error { statusCode: number; dockerStatus?: number; code: string; }
export function normalizeDockerError(err: unknown): DockerError;
```
Map: 404 → `not_found`/404, 409 → `conflict`/409, ECONNREFUSED/ENOENT → `docker_unavailable`/503.

---

## 6. REST API — frozen

Base `/api`. Session cookie `dockyard_session` (httpOnly, sameSite=lax, path=/).
Every response is JSON. Errors:

```json
{ "error": { "code": "validation_error", "message": "human readable", "details": {} } }
```
Codes: `unauthorized` 401, `forbidden` 403, `not_found` 404, `validation_error` 400,
`conflict` 409, `docker_error` 502, `docker_unavailable` 503, `internal` 500.

Role ladder: `viewer` (read) < `operator` (write, no delete, no users/settings) < `admin` (all).
The first user created is `admin`.

| Method | Path | Body / query | Returns | Min role |
|---|---|---|---|---|
| GET | `/api/system/health` | – | `{ ok: true, uptime: number }` | public |
| GET | `/api/system/info` | – | `SystemInfo` | public (see note) |
| POST | `/api/auth/bootstrap` | `{email,password}` | `{user}` | public, only when 0 users |
| POST | `/api/auth/login` | `{email,password}` | `{user}` | public |
| POST | `/api/auth/logout` | – | `{ok:true}` | any |
| GET | `/api/auth/me` | – | `{user: PublicUser \| null}` | public |
| GET | `/api/users` | – | `PublicUser[]` | admin |
| POST | `/api/users` | `{email,password,role}` | `PublicUser` | admin |
| PATCH | `/api/users/:id` | `{role?,password?}` | `PublicUser` | admin |
| DELETE | `/api/users/:id` | – | `{ok:true}` | admin |
| GET | `/api/containers` | `?all=1&q=` | `ContainerSummary[]` | viewer |
| POST | `/api/containers` | `CreateContainerInput` | `{id,name}` 201 | operator |
| GET | `/api/containers/:id` | – | `ContainerDetail` | viewer |
| GET | `/api/containers/:id/inspect` | – | raw inspect | viewer |
| POST | `/api/containers/:id/:action` | action ∈ `start\|stop\|restart\|kill\|pause\|unpause` | `ContainerSummary` | operator |
| DELETE | `/api/containers/:id` | `?force=1&volumes=1` | `{ok:true}` | admin |
| GET | `/api/containers/:id/logs` | `?tail=200&since=` | `text/plain` | viewer |
| GET | `/api/containers/:id/stats` | – | `ContainerStats` | viewer |
| POST | `/api/containers/:id/exec` | `{cmd: string[]}` | `{stdout,stderr,exitCode}` | operator |
| GET | `/api/images` | – | `ImageSummary[]` | viewer |
| POST | `/api/images/pull` | `{ref}` | `{ok:true,ref}` (long; 120s timeout) | operator |
| DELETE | `/api/images/:id` | `?force=1` | `{ok:true}` | admin |
| GET | `/api/volumes` | – | `VolumeSummary[]` | viewer |
| POST | `/api/volumes` | `{name}` | `VolumeSummary` | operator |
| DELETE | `/api/volumes/:name` | `?force=1` | `{ok:true}` | admin |
| GET | `/api/networks` | – | `NetworkSummary[]` | viewer |
| POST | `/api/networks` | `{name,driver?}` | `NetworkSummary` | operator |
| DELETE | `/api/networks/:id` | – | `{ok:true}` | admin |
| GET | `/api/templates` | `?category=&source=` | `Template[]` | viewer |
| GET | `/api/templates/:slug` | – | `Template` | viewer |
| POST | `/api/templates` | `{spec}` | `Template` 201 | operator |
| PATCH | `/api/templates/:slug` | `{spec}` | `Template` | operator |
| DELETE | `/api/templates/:slug` | – | `{ok:true}` (builtin → 409) | admin |
| POST | `/api/templates/:slug/deploy` | `{name, values:{}}` | `{stack, container:{id,name}}` 201 | operator |
| GET | `/api/stacks` | – | `StackWithContainers[]` | viewer |
| GET | `/api/stacks/:id` | – | `StackWithContainers` | viewer |
| POST | `/api/stacks/:id/:action` | action ∈ `start\|stop` | `StackWithContainers` | operator |
| DELETE | `/api/stacks/:id` | `?volumes=1` | `{ok:true}` | admin |
| GET | `/api/tunnels` | – | `Tunnel[]` | viewer |
| POST | `/api/tunnels` | `CreateTunnelInput` | `Tunnel` 201 | operator |
| GET | `/api/tunnels/:id` | – | `Tunnel` | viewer |
| POST | `/api/tunnels/:id/:action` | action ∈ `start\|stop` | `Tunnel` | operator |
| DELETE | `/api/tunnels/:id` | – | `{ok:true}` | admin |
| GET | `/api/cloudflare/status` | – | `{configured:boolean, verified:boolean, accountId:string\|null, accounts:[], zones:[], error?:string}` | admin |
| POST | `/api/cloudflare/credentials` | `{apiToken?, accountId}` | `{ok:true, verified:boolean, error?:string}` | admin |
| DELETE | `/api/cloudflare/credentials` | – | `{ok:true}` | admin |
| GET | `/api/settings` | – | `SettingsView` (secrets masked) | admin |
| PATCH | `/api/settings` | `{...}` | `SettingsView` | admin |
| GET | `/api/audit` | `?limit=100&offset=0&action=` | `AuditEntry[]` | admin |

`SystemInfo`:
```ts
{ version: string; uptime: number; publicUrl: string;
  docker: { ok: boolean; version?: string; apiVersion?: string; os?: string; arch?: string;
            containers?: { total: number; running: number; paused: number; stopped: number };
            images?: number; error?: string };
  db: { ok: boolean; serverVersion?: string; error?: string };
  cloudflared: { ok: boolean; version?: string; path: string; error?: string };
  cloudflare: { configured: boolean; verified: boolean; accountId: string | null };
  counts: { containers: number; running: number; images: number; volumes: number;
            networks: number; tunnels: number; tunnelsActive: number; stacks: number; templates: number };
  mode: 'real' | 'demo'; }
```

`Template`:
```ts
{ id: string; slug: string; name: string; category: string; icon: string; description: string;
  source: 'builtin'|'user'; spec: TemplateSpec; created_at: string; updated_at: string }
```

`Tunnel`:
```ts
{ id: string; name: string; mode: 'quick'|'named'|'localtunnel'; target_url: string;
  container_id: string|null; container_name: string|null; port: number|null;
  hostname: string|null; tunnel_id: string|null; status: 'stopped'|'starting'|'running'|'error';
  url: string|null; pid: number|null; last_error: string|null; auto_start: boolean;
  created_at: string; updated_at: string }
```

`AuditEntry`: `{ id: number; user_id: string|null; user_email: string|null; action: string;
target_type: string; target_id: string|null; detail: unknown; ip: string|null; created_at: string }`

**Note on `/api/system/info` and `/api/auth/me`**: they are reachable unauthenticated so the login
screen can show host status, but `counts` must be zeroed and `docker.containers` omitted when the
caller is not authenticated. `mode` is `'demo'` when the Docker engine is unreachable.

---

## 7. WebSocket protocol — frozen

`@fastify/websocket`. Auth = the same session cookie on the upgrade request. Unauthenticated
upgrade → close code `4401`. All frames are JSON text.

| Path | Server → client | Client → server |
|---|---|---|
| `/ws/containers/:id/logs?tail=200` | `{"type":"log","line":"..."}` then `{"type":"end","reason":"stream_ended"\|"container_gone"\|"error"}` | `{"type":"ping"}` |
| `/ws/containers/:id/stats` | `{"type":"stats","stats":ContainerStats}` every 1500 ms | `{"type":"ping"}` |
| `/ws/events` | `{"type":"container"\|"tunnel"\|"stack","action":string,"data":{...}}` | – |

`server/src/events.ts` (owner: agent 2):
```ts
export type BusEvent = { type: 'container'|'tunnel'|'stack'; action: string; data: unknown };
export const bus: { emit(ev: BusEvent): void; on(fn: (ev: BusEvent) => void): () => void };
```

---

## 8. Cloudflare tunnels — owner: agent 3

Two modes, one supervisor.

**quick (non-persistent)** — `cloudflared tunnel --url <target> --no-autoupdate`.
No account needed. cloudflared prints the assigned `https://<words>.trycloudflare.com` URL on
stderr; parse it and surface it. The tunnel dies with the process. `--protocol http2` is added
when `DOCKYARD_CF_PROTOCOL=http2`.

**named (persistent)** — needs a Cloudflare API token + account id (from Settings, encrypted in
`settings` under keys `cloudflare.api_token` / `cloudflare.account_id`, else from env).
Flow: `cfCreateTunnel(name)` → `cfGetTunnelToken(id)` → write `data/tunnels/<slug>/credentials.json`
+ `config.yml` → `cloudflared tunnel --config <config.yml> run <name>` → `cfRouteDns(zoneId,
hostname, tunnelId)`. On boot `tunnelManager.init()` restarts every tunnel with `auto_start = true`.

```ts
// tunnels/url-parse.ts
export function parseQuickTunnelUrl(chunk: string): string | null;      // first https://*.trycloudflare.com
export function parseCloudflaredError(chunk: string): string | null;    // 'ERR …', 'failed to …', 'error: …'
// tunnels/supervisor.ts
export type SpawnedTunnel = { pid: number | null; kill(signal?: NodeJS.Signals): void;
  onExit(cb: (code: number | null, signal: string | null) => void): void; };
export function spawnCloudflared(args: string[], opts: {
  env?: Record<string, string>;
  onLine: (line: string, stream: 'stdout' | 'stderr') => void;
}): SpawnedTunnel;                        // uses config.cloudflaredBin, cwd = config.dataDir
// tunnels/named.ts
export function slugify(name: string): string;
export function buildNamedTunnelConfig(i: { tunnelId: string; credentialsFile: string;
  hostname: string; service: string }): string;             // YAML text, 2-space indent
export function writeTunnelFiles(slug: string, credentials: unknown, configYaml: string):
  Promise<{ credentialsPath: string; configPath: string }>;  // mkdir -p, chmod 600 on credentials
// tunnels/manager.ts
export const tunnelManager: {
  init(): Promise<void>;
  list(): Promise<Tunnel[]>;
  get(id: string): Promise<Tunnel | null>;
  create(input: CreateTunnelInput): Promise<Tunnel>;
  start(id: string): Promise<Tunnel>;
  stop(id: string): Promise<Tunnel>;
  remove(id: string): Promise<void>;
  shutdown(): Promise<void>;
  reconcile(): Promise<void>;              // marks DB 'running' rows with no live process as 'stopped'
};
export type CreateTunnelInput = { name: string; mode: 'quick'|'named'|'localtunnel';
  target_url?: string; container_id?: string; port?: number;
  hostname?: string; zone_id?: string; auto_start?: boolean };
```
If `container_id` is given and `target_url` is not, resolve the container's published port for
`port` (default: its single published port) and target `http://<config.tunnelTargetHost>:<publishedPort>`
(default host `127.0.0.1`; `host.docker.internal` when the panel runs in a container).

```ts
// cloudflare/api.ts
export type CloudflareCreds = { apiToken: string; accountId: string };
export async function resolveCreds(): Promise<CloudflareCreds | null>;   // DB first, then env
export async function cfVerifyToken(): Promise<{ ok: boolean; tokenId?: string; error?: string }>;
export async function cfListAccounts(): Promise<Array<{ id: string; name: string }>>;
export async function cfListZones(): Promise<Array<{ id: string; name: string; accountId: string }>>;
export async function cfCreateTunnel(name: string): Promise<{ id: string; name: string }>;
export async function cfGetTunnelToken(tunnelId: string): Promise<string>;
export async function cfDeleteTunnel(tunnelId: string): Promise<void>;
export async function cfRouteDns(zoneId: string, hostname: string, tunnelId: string): Promise<{ id: string }>;
export async function cfListTunnels(): Promise<Array<{ id: string; name: string; status: string; connections: number }>>;
```
Cloudflare API base `https://api.cloudflare.com/client/v4`, `Authorization: Bearer <token>`.
Unwrap `{ success, result, errors }`; throw `CloudflareError` (exported) with a readable message.

**Never log or return the token.** `secrets.ts` (also agent 3):
```ts
export function encryptSecret(plain: string): string;      // 'v1:<ivB64>:<tagB64>:<ctB64>' AES-256-GCM
export function decryptSecret(blob: string): string;
export function maskSecret(plain: string | null | undefined): string | null;   // 'abcd…wxyz'
export function fingerprint(plain: string): string;        // sha256 hex, first 16 chars
```

---

## 9. Ownership (nobody edits outside their list)

| Agent | Owns |
|---|---|
| **1 — foundation** | `server/src/config.ts`, `logger.ts`, `db/**`, `docker/**`, `server/test/mock-docker.ts`, `server/test/db.test.ts`, `server/test/docker.test.ts` |
| **2 — API & auth** | `server/src/index.ts`, `app.ts`, `events.ts`, `auth/**`, `routes/{auth,system,containers,images,volumes,networks,audit,users}.ts`, `ws/**`, `server/test/api.test.ts` |
| **3 — tunnels** | `server/src/secrets.ts`, `tunnels/**`, `cloudflare/**`, `routes/{tunnels,settings}.ts`, `server/test/tunnels.test.ts` |
| **4 — templates** | `server/src/templates/**`, `stacks.ts`, `routes/{templates,stacks}.ts`, `server/test/templates.test.ts` |
| **5 — frontend** | `web/**` (everything), `web/DESIGN.md` |

Shared, frozen: `package.json` files, `tsconfig.json` files, `vite.config.ts`, `index.html`,
`CONTRACT.md`, `.env`. If you need one changed, say so in your report instead.

---

## 10. Templates & stacks — owner: agent 4

```ts
// templates/schema.ts
export type TemplateSpec = {
  schemaVersion: 1;
  slug: string; name: string;
  category: 'database'|'web'|'monitoring'|'storage'|'devtools'|'messaging'|'other';
  icon: string;                       // single emoji
  description: string;
  image: string; tag: string;         // e.g. 'postgres', '16-alpine'
  ports: Array<{ container: number; label?: string; defaultHost?: number }>;
  env: Array<{ key: string; label?: string; default?: string; required?: boolean;
               secret?: boolean; description?: string }>;
  volumes: Array<{ container: string; label?: string; named?: boolean }>;
  command?: string[]; entrypoint?: string[];
  restartPolicy: 'no'|'always'|'unless-stopped'|'on-failure';
  healthcheck?: { test: string[]; intervalSec: number; timeoutSec: number; retries: number };
  notes?: string; docsUrl?: string;
};
export const templateSpecSchema: ZodType<TemplateSpec>;
export function validateSpec(input: unknown): { ok: true; spec: TemplateSpec } | { ok: false; errors: string[] };
export function renderTemplate(spec: TemplateSpec, values: Record<string, string>): {
  image: string; env: Record<string, string>;
  ports: Array<{ host?: number; container: number }>;
  volumes: Array<{ host?: string; container: string }>;
  restartPolicy: string; command?: string[]; entrypoint?: string[];
  labels: Record<string, string>; missing: string[];
};
```
`renderTemplate` returns `missing[]` for required env vars with no value; the deploy route rejects
with `validation_error` listing them. Values keyed by env `key`; port host overrides keyed
`port:<container>`; volume host overrides keyed `volume:<container>`.

`templates/catalog.ts`: `export function builtinTemplates(): TemplateSpec[]` — **at least 14 real,
correct templates**, one per category at minimum. Ship: postgres, mysql, redis, mongodb, adminer,
nginx, httpd, wordpress(+mysql note), node-app, python-app, uptime-kuma, grafana, prometheus,
minio, n8n, whoami. Real image names, real env var names, real ports, real volume paths. No invented
images. Add `syncBuiltinTemplates()` that upserts them into the `templates` table with
`source='builtin'` (never overwriting a user row with the same slug).

```ts
// templates/engine.ts
export async function deployTemplate(input: { slug: string; name: string;
  values: Record<string, string>; userId: string | null }):
  Promise<{ stack: StackRow; container: { id: string; name: string } }>;
```
Deploy = insert `stacks` row → `createContainer` with labels
`{ 'dockyard.managed':'true', 'dockyard.stack':<stackId>, 'dockyard.template':<slug> }` →
`startContainer` → update stack status. On failure: stack `status='error'` and the Docker error
propagates. `stacks.ts` exports `listStacks`, `getStack`, `startStack`, `stopStack`,
`removeStack(id,{volumes})`, `reconcileStackStatus()` — container↔stack linkage is always by label,
never by name matching. `StackWithContainers = StackRow & { containers: ContainerSummary[] }`.

---

## 11. Frontend — owner: agent 5

React 19 + Vite + TS, `react-router-dom` v7. No CSS framework: hand-written CSS with tokens.

**This is an operator console, not a marketing page.** Design rules:
- Load the `popular-web-designs` skill and take the **exact tokens of one real design system**;
  write them into `web/src/styles/tokens.css` with a comment naming the source. Do not invent a
  palette. Recommended: a dense dark console (Linear/Vercel/Raycast family).
- Load `claude-design` and name the archetype (`operate`) in `web/DESIGN.md`, then run its slop
  self-audit. Load `humanizer` and pass over every string of copy.
- Density over decoration: monospace for ids/ports/images/logs, tabular numbers for stats,
  status pills with semantic colour, no gradients-as-decoration, no emoji as UI chrome
  (template icons excepted — those are data).
- Every interactive control: visible keyboard focus ring, disabled + busy states, and a
  `confirm` step for destructive actions (stop/kill/remove/prune).
- Empty states with a next action, loading skeletons, and an inline error surface per view.
- Responsive to 390 px: sidebar collapses to a drawer, tables become stacked cards.
- Live data: log + stats views use the WebSocket endpoints with reconnect/backoff.

Routes: `/login`, `/` (dashboard), `/containers`, `/containers/:id` (tabs: overview, logs, stats,
inspect, console), `/templates`, `/stacks`, `/tunnels`, `/images`, `/volumes`, `/networks`,
`/audit`, `/settings`. Unknown route → 404 view.

`web/src/api/types.ts` mirrors §6 exactly. `web/src/api/client.ts` exports a typed
`api.get/post/patch/del` that throws `ApiError{code,message,details,status}`.

---

## 12. Verification commands

```bash
export PATH=/root/.hermes/node/bin:$PATH
cd /root/hermes-workspace/dockyard
node server/src/db/migrate.ts                      # migrations apply cleanly
npx tsc -p server/tsconfig.json --noEmit           # server typecheck
npm --workspace web run typecheck                  # web typecheck
npm --workspace web run build                      # web build
node --test server/test/                           # server tests
node server/src/index.ts                           # boot the API on :8000
```

`server/test/mock-docker.ts` is a **test double**: an HTTP server that speaks the subset of the
Docker Engine API this panel uses (`/version`, `/_ping`, `/containers/json`, `/containers/create`,
`/containers/{id}/json|start|stop|restart|kill|pause|unpause|logs|stats|exec`, `/images/json`,
`/images/create`, `/volumes`, `/networks`). Point the app at it with `DOCKER_HOST=tcp://127.0.0.1:<port>`.
It must be clearly labelled as a double in its header comment. It exists so the whole stack is
testable without a daemon; the real daemon is preferred whenever one is reachable.
