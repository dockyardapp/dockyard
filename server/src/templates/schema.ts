// Dockyard — template spec type, zod schema, validation and rendering (owner: agent 4).
//
// A TemplateSpec is the declarative description of one containerised application: the real
// upstream image and tag, the ports it exposes, the environment variables a user must supply
// (with secrets flagged), the volumes it writes to, a restart policy and an optional healthcheck.
// `renderTemplate` turns a spec plus user-supplied values into the concrete create/start inputs.

import { z } from 'zod';

export type TemplateCategory =
  | 'database'
  | 'web'
  | 'monitoring'
  | 'storage'
  | 'devtools'
  | 'messaging'
  | 'other';

export type RestartPolicy = 'no' | 'always' | 'unless-stopped' | 'on-failure';

export type TemplatePort = { container: number; label?: string; defaultHost?: number };

export type TemplateEnvVar = {
  key: string;
  label?: string;
  default?: string;
  required?: boolean;
  secret?: boolean;
  description?: string;
};

export type TemplateVolume = { container: string; label?: string; named?: boolean };

export type TemplateHealthcheck = {
  test: string[];
  intervalSec: number;
  timeoutSec: number;
  retries: number;
};

export type TemplateSpec = {
  schemaVersion: 1;
  slug: string;
  name: string;
  category: TemplateCategory;
  icon: string;
  description: string;
  image: string;
  tag: string;
  ports: TemplatePort[];
  env: TemplateEnvVar[];
  volumes: TemplateVolume[];
  command?: string[];
  entrypoint?: string[];
  restartPolicy: RestartPolicy;
  healthcheck?: TemplateHealthcheck;
  notes?: string;
  docsUrl?: string;
};

/** Marker written into a stack's persisted `values` in place of a secret's real value. */
export const SECRET_MARKER = '***';

const SLUG_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const ENV_KEY_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;
const PORT = z.number().int().min(1).max(65535);

const portSchema = z
  .object({
    container: PORT,
    label: z.string().min(1).optional(),
    defaultHost: PORT.optional(),
  })
  .strict();

const envSchema = z
  .object({
    key: z.string().regex(ENV_KEY_RE, 'env key must be a valid environment variable name'),
    label: z.string().min(1).optional(),
    default: z.string().optional(),
    required: z.boolean().optional(),
    secret: z.boolean().optional(),
    description: z.string().optional(),
  })
  .strict();

const volumeSchema = z
  .object({
    container: z
      .string()
      .refine((p) => p.startsWith('/'), 'volume container path must be absolute'),
    label: z.string().min(1).optional(),
    named: z.boolean().optional(),
  })
  .strict();

const healthcheckSchema = z
  .object({
    test: z.array(z.string().min(1)).min(1),
    intervalSec: z.number().int().positive(),
    timeoutSec: z.number().int().positive(),
    retries: z.number().int().nonnegative(),
  })
  .strict();

// NOTE: input is `unknown` (not TemplateSpec) because ports/env/volumes carry `.default([])` so
// user-authored specs may omit them. The *output* is always a complete TemplateSpec.
export const templateSpecSchema: z.ZodType<TemplateSpec, z.ZodTypeDef, unknown> = z
  .object({
    schemaVersion: z.literal(1),
    slug: z.string().regex(SLUG_RE, 'slug must be lowercase kebab-case'),
    name: z.string().min(1),
    category: z.enum(['database', 'web', 'monitoring', 'storage', 'devtools', 'messaging', 'other']),
    icon: z.string().min(1),
    description: z.string(),
    image: z.string().min(1),
    tag: z.string().min(1),
    ports: z.array(portSchema).default([]),
    env: z.array(envSchema).default([]),
    volumes: z.array(volumeSchema).default([]),
    command: z.array(z.string()).optional(),
    entrypoint: z.array(z.string()).optional(),
    restartPolicy: z.enum(['no', 'always', 'unless-stopped', 'on-failure']),
    healthcheck: healthcheckSchema.optional(),
    notes: z.string().optional(),
    docsUrl: z.string().optional(),
  })
  .strict();

export function validateSpec(
  input: unknown,
): { ok: true; spec: TemplateSpec } | { ok: false; errors: string[] } {
  const parsed = templateSpecSchema.safeParse(input);
  if (parsed.success) return { ok: true, spec: parsed.data };
  const errors = parsed.error.issues.map((i) => {
    const path = i.path.join('.');
    return path ? `${path}: ${i.message}` : i.message;
  });
  return { ok: false, errors };
}

/** A validation failure raised by renderTemplate; the route maps it to HTTP 400. */
export class TemplateValidationError extends Error {
  code = 'validation_error';
  statusCode = 400;
  details: Record<string, unknown>;

  constructor(message: string, details: Record<string, unknown> = {}) {
    super(message);
    this.name = 'TemplateValidationError';
    this.details = details;
  }
}

export type RenderedTemplate = {
  image: string;
  env: Record<string, string>;
  ports: Array<{ host?: number; container: number }>;
  volumes: Array<{ host?: string; container: string }>;
  restartPolicy: RestartPolicy;
  command?: string[];
  entrypoint?: string[];
  labels: Record<string, string>;
  missing: string[];
};

/**
 * Render a spec + user values into concrete container inputs.
 *
 * Value keys:
 *   - `<envKey>`            env value (falls back to the spec default; required+missing -> missing[])
 *   - `port:<container>`    host port override, validated as an integer in 1..65535
 *   - `volume:<container>`  host path override for a volume, must be absolute
 *
 * Base labels always carry `dockyard.managed` and `dockyard.template`; the deploy engine adds
 * `dockyard.stack` and `dockyard.name` once it knows the stack id/name.
 */
export function renderTemplate(
  spec: TemplateSpec,
  values: Record<string, string>,
): RenderedTemplate {
  const missing: string[] = [];
  const env: Record<string, string> = {};

  for (const e of spec.env) {
    const raw = values[e.key];
    let value: string | undefined = typeof raw === 'string' && raw.length > 0 ? raw : undefined;
    if (value === undefined && e.default !== undefined && e.default !== '') value = e.default;
    if (value === undefined) {
      if (e.required) missing.push(e.key);
      continue;
    }
    env[e.key] = value;
  }

  const ports = spec.ports.map((p) => {
    const key = `port:${p.container}`;
    const raw = values[key];
    let host = p.defaultHost;
    if (raw !== undefined && raw !== '') {
      const n = Number(raw);
      if (!Number.isInteger(n) || n < 1 || n > 65535) {
        throw new TemplateValidationError(
          `invalid host port for container port ${p.container}: "${raw}" (must be an integer 1..65535)`,
          { [key]: raw },
        );
      }
      host = n;
    }
    return { host, container: p.container };
  });

  const volumes = spec.volumes.map((v) => {
    const key = `volume:${v.container}`;
    const raw = values[key];
    let host: string | undefined;
    if (raw !== undefined && raw !== '') {
      if (!raw.startsWith('/')) {
        throw new TemplateValidationError(
          `host path for volume ${v.container} must be absolute: "${raw}"`,
          { [key]: raw },
        );
      }
      host = raw;
    }
    return { host, container: v.container };
  });

  const labels: Record<string, string> = {
    'dockyard.managed': 'true',
    'dockyard.template': spec.slug,
  };

  return {
    image: `${spec.image}:${spec.tag}`,
    env,
    ports,
    volumes,
    restartPolicy: spec.restartPolicy,
    command: spec.command,
    entrypoint: spec.entrypoint,
    labels,
    missing,
  };
}

/**
 * Build the object stored in a stack's `values` JSONB column: the effective env (defaults
 * applied) with every secret's value replaced by SECRET_MARKER, plus the port/volume overrides.
 * A secret's real value is therefore never persisted.
 */
export function persistableValues(
  spec: TemplateSpec,
  values: Record<string, string>,
): Record<string, string> {
  const secretKeys = new Set(spec.env.filter((e) => e.secret).map((e) => e.key));
  const out: Record<string, string> = {};

  for (const e of spec.env) {
    const raw = values[e.key];
    const value = raw !== undefined && raw !== '' ? raw : e.default;
    if (value === undefined || value === '') continue;
    out[e.key] = secretKeys.has(e.key) ? SECRET_MARKER : value;
  }
  for (const [k, v] of Object.entries(values)) {
    if ((k.startsWith('port:') || k.startsWith('volume:')) && v !== undefined) out[k] = v;
  }
  return out;
}
