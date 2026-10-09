/**
 * Wire types. These mirror CONTRACT.md section 6 (REST API) exactly, plus the
 * shapes documented for §5 (Docker summaries), §7 (WebSocket frames), §8
 * (tunnels) and §10 (template spec). Do not add fields the server does not
 * send, and do not rename any.
 */

/* ------------------------------------------------------------------ §5 docker */

export type ContainerState =
  | 'running'
  | 'exited'
  | 'created'
  | 'paused'
  | 'restarting'
  | 'dead'
  | 'removing';

export type ContainerPort = { ip?: string; privatePort: number; publicPort?: number; type: string };

export type ContainerSummary = {
  id: string;
  name: string;
  image: string;
  imageId: string;
  state: ContainerState;
  status: string;
  created: number;
  health: string | null;
  ports: ContainerPort[];
  labels: Record<string, string>;
  managed: boolean;
  stackId: string | null;
  templateSlug: string | null;
};

export type ContainerMount = {
  source: string;
  destination: string;
  mode: string;
  rw: boolean;
  type: string;
};

export type ContainerDetail = ContainerSummary & {
  command: string;
  entrypoint: string;
  env: string[];
  mounts: ContainerMount[];
  networks: Array<{ name: string; ip: string | null }>;
  restartPolicy: string;
  startedAt: string | null;
  finishedAt: string | null;
  exitCode: number | null;
  platform: string;
};

export type ContainerStats = {
  cpuPercent: number;
  memUsed: number;
  memLimit: number;
  memPercent: number;
  netRx: number;
  netTx: number;
  blkRead: number;
  blkWrite: number;
  pids: number;
  readAt: string;
};

export type CreateContainerInput = {
  name: string;
  image: string;
  cmd?: string[];
  entrypoint?: string[];
  env?: Record<string, string>;
  ports?: Array<{ host?: number; container: number; proto?: 'tcp' | 'udp' }>;
  volumes?: Array<{ host?: string; container: string; mode?: string }>;
  restartPolicy?: 'no' | 'always' | 'unless-stopped' | 'on-failure';
  labels?: Record<string, string>;
  network?: string;
  pull?: boolean;
};

export type ImageSummary = {
  id: string;
  repoTags: string[];
  repoDigests: string[];
  size: number;
  created: number;
  containers: number;
  dangling: boolean;
};

export type VolumeSummary = {
  name: string;
  driver: string;
  mountpoint: string;
  created: string;
  labels: Record<string, string>;
  inUseBy: string[];
};

export type NetworkSummary = {
  id: string;
  name: string;
  driver: string;
  scope: string;
  internal: boolean;
  containers: Array<{ id: string; name: string }>;
  labels: Record<string, string>;
};

export type PruneResult = { deleted: string[]; spaceReclaimed: number };

/* -------------------------------------------------------------- §6 templates */

export type TemplateCategory =
  | 'database'
  | 'web'
  | 'monitoring'
  | 'storage'
  | 'devtools'
  | 'messaging'
  | 'other';

export type TemplateSpec = {
  schemaVersion: 1;
  slug: string;
  name: string;
  category: TemplateCategory;
  icon: string;
  description: string;
  image: string;
  tag: string;
  ports: Array<{ container: number; label?: string; defaultHost?: number }>;
  env: Array<{
    key: string;
    label?: string;
    default?: string;
    required?: boolean;
    secret?: boolean;
    description?: string;
  }>;
  volumes: Array<{ container: string; label?: string; named?: boolean }>;
  command?: string[];
  entrypoint?: string[];
  restartPolicy: 'no' | 'always' | 'unless-stopped' | 'on-failure';
  healthcheck?: { test: string[]; intervalSec: number; timeoutSec: number; retries: number };
  notes?: string;
  docsUrl?: string;
};

export type Template = {
  id: string;
  slug: string;
  name: string;
  category: string;
  icon: string;
  description: string;
  source: 'builtin' | 'user';
  spec: TemplateSpec;
  created_at: string;
  updated_at: string;
};

/* ----------------------------------------------------------------- §6 stacks */

export type StackStatus = 'running' | 'stopped' | 'partial' | 'error';

export type StackRow = {
  id: string;
  name: string;
  slug: string;
  source: 'template' | 'user';
  template_slug: string | null;
  spec: unknown;
  values: Record<string, unknown>;
  status: StackStatus;
  created_by: string | null;
  created_at: string;
  updated_at: string;
};

export type StackWithContainers = StackRow & { containers: ContainerSummary[] };

/* ---------------------------------------------------------------- §6 tunnels */

export type TunnelMode = 'quick' | 'named' | 'localtunnel';
export type TunnelStatus = 'stopped' | 'starting' | 'running' | 'error';

export type Tunnel = {
  id: string;
  name: string;
  mode: TunnelMode;
  target_url: string;
  container_id: string | null;
  container_name: string | null;
  port: number | null;
  hostname: string | null;
  tunnel_id: string | null;
  status: TunnelStatus;
  url: string | null;
  pid: number | null;
  last_error: string | null;
  auto_start: boolean;
  created_at: string;
  updated_at: string;
};

export type CreateTunnelInput = {
  name: string;
  mode: TunnelMode;
  target_url?: string;
  container_id?: string;
  port?: number;
  hostname?: string;
  zone_id?: string;
  auto_start?: boolean;
};

/* ----------------------------------------------------------------- §6 system */

export type DockerInfo = {
  ok: boolean;
  version?: string;
  apiVersion?: string;
  os?: string;
  arch?: string;
  containers?: { total: number; running: number; paused: number; stopped: number };
  images?: number;
  error?: string;
};

export type SystemInfo = {
  version: string;
  build: BuildInfo;
  uptime: number;
  publicUrl: string;
  docker: DockerInfo;
  db: { ok: boolean; serverVersion?: string; error?: string };
  cloudflared: { ok: boolean; version?: string; path: string; error?: string };
  cloudflare: { configured: boolean; verified: boolean; accountId: string | null };
  counts: {
    containers: number;
    running: number;
    images: number;
    volumes: number;
    networks: number;
    tunnels: number;
    tunnelsActive: number;
    stacks: number;
    templates: number;
  };
  mode: 'real' | 'demo';
};

/* ----------------------------------------------------------------- §6 users */

export type UserRole = 'admin' | 'operator' | 'viewer';

/** 'granted' means the user sees only the resources allocated to them. */
export type ScopeMode = 'all' | 'granted';

export type ResourceKind =
  | 'container'
  | 'stack'
  | 'volume'
  | 'network'
  | 'image'
  | 'template'
  | 'tunnel';

/**
 * One allocated resource. Either an explicit `resource_id`, or a label selector
 * (`label_key`/`label_value`). The label form is the durable one: it survives a
 * container being deleted and recreated.
 */
export type Grant = {
  id: string;
  resource_kind: ResourceKind;
  resource_id: string | null;
  label_key: string | null;
  label_value: string | null;
};

export type PublicUser = {
  id: string;
  email: string;
  role: UserRole;
  /** Admins are never scoped, so this is always 'all' for them. */
  scope_mode: ScopeMode;
  /** May run commands inside a container. Separate from the role. */
  can_exec: boolean;
  created_at: string;
  last_login_at: string | null;
};

/** The admin user list carries the allocation size as well. */
export type AdminUser = PublicUser & { grant_count: number };

/* ----------------------------------------------------------------- §6 audit */

export type AuditEntry = {
  id: number;
  user_id: string | null;
  user_email: string | null;
  action: string;
  target_type: string;
  target_id: string | null;
  detail: unknown;
  ip: string | null;
  created_at: string;
};

/* ------------------------------------------------------ §6 cloudflare/settings */

export type CloudflareStatus = {
  configured: boolean;
  verified: boolean;
  accountId: string | null;
  accounts: Array<{ id: string; name: string }>;
  zones: Array<{ id: string; name: string; accountId: string }>;
  error?: string;
};

export type SettingsView = Record<string, unknown>;

/* ----------------------------------------------------------- §6 error envelope */

export type ApiErrorBody = {
  error: { code: string; message: string; details?: unknown };
};

export type ApiErrorCode =
  | 'unauthorized'
  | 'forbidden'
  | 'not_found'
  | 'validation_error'
  | 'conflict'
  | 'docker_error'
  | 'docker_unavailable'
  | 'internal';

/* ------------------------------------------------------------- §7 ws frames */

export type LogFrame = { type: 'log'; line: string } | { type: 'end'; reason: string };

export type StatsFrame = { type: 'stats'; stats: ContainerStats };

export type BusEventType = 'container' | 'tunnel' | 'stack';
export type BusEvent = { type: BusEventType; action: string; data: unknown };

export type EventFrame = { type: BusEventType; action: string; data: unknown };

/* --------------------------------------------------- §6 request/response bits */

export type LoginResponse = { user: PublicUser };
export type MeResponse = { user: PublicUser | null };
export type OkResponse = { ok: true };
export type CreateContainerResponse = { id: string; name: string };
export type ExecResponse = { stdout: string; stderr: string; exitCode: number };
export type DeployResponse = { stack: StackRow; container: { id: string; name: string } };
export type PullResponse = { ok: true; ref: string };
export type CloudflareCredsResponse = { ok: true; verified: boolean; error?: string };

/* ------------------------------------------------- §6 version and updates */

/** Which build is running. `commit` is empty when it could not be determined. */
export type BuildInfo = {
  version: string;
  commit: string;
  commitShort: string;
  builtAt: string | null;
  /** False when the running commit is unknown, so "up to date" cannot be claimed. */
  pinned: boolean;
};

export type UpstreamCommit = {
  sha: string;
  commitShort: string;
  subject: string;
  author: string;
  date: string;
  url: string;
};

export type UpdateCheck = {
  checkedAt: string;
  repo: string;
  branch: string;
  authenticated: boolean;
  /** The relationship of the running commit to the branch tip. */
  status: 'current' | 'behind' | 'ahead' | 'diverged' | 'unknown';
  behindBy: number;
  aheadBy: number;
  latest: {
    version: string | null;
    commit: string;
    commitShort: string;
    subject: string;
    author: string;
    date: string;
    url: string;
  } | null;
  /** The commits an update would bring in, newest first. */
  commits: UpstreamCommit[];
  rateLimit: { remaining: number | null; limit: number | null; resetAt: string | null };
  error: string | null;
};

export type UpdateJobState = 'queued' | 'running' | 'success' | 'failed' | 'rolled-back' | 'stale';

export type UpdateJob = {
  id: string;
  state: UpdateJobState;
  step: string | null;
  message: string | null;
  requestedAt: string | null;
  requestedBy: string | null;
  startedAt: string | null;
  finishedAt: string | null;
  from: { version: string | null; commit: string | null };
  to: { version: string | null; commit: string | null };
  log: string | null;
};

export type UpdaterInfo = {
  /** False when the host has no updater installed, so the button cannot work. */
  installed: boolean;
  installedAt: string | null;
  spoolDir: string;
  enabled: boolean;
};

export type UpdateStatus = {
  build: BuildInfo;
  check: UpdateCheck;
  job: UpdateJob | null;
  updater: UpdaterInfo;
  canUpdate: boolean;
};

export type StartUpdateResponse = {
  requested: true;
  request: { id: string; requestedAt: string; requestedBy: string; branch: string };
  job: UpdateJob | null;
};
