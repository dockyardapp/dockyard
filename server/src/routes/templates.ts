// Dockyard — template routes (owner: agent 4). Mounted under /api.
//
//   GET    /templates               ?category=&source=      viewer
//   GET    /templates/:slug                                 viewer
//   POST   /templates               { spec }                operator  201
//   PATCH  /templates/:slug         { spec }                operator
//   DELETE /templates/:slug                                 admin   (builtin -> 409)
//   POST   /templates/:slug/deploy  { name, values }        operator  201

import type { FastifyInstance, FastifyReply } from 'fastify';
import { z } from 'zod';
import { one, many, query } from '../db/pool.ts';
import { requireRole, sendError } from '../auth/rbac.ts';
import { canSee, denyScoped, filterVisible, grantLabel, isUnrestricted } from '../auth/scope.ts';
import { auditFromRequest } from '../auth/audit.ts';
import { validateSpec, TemplateValidationError } from '../templates/schema.ts';
import type { TemplateSpec } from '../templates/schema.ts';
import { ensureBuiltinTemplates } from '../templates/catalog.ts';
import { deployTemplate, TemplateNotFoundError } from '../templates/engine.ts';

type TemplateRow = {
  id: string;
  slug: string;
  name: string;
  category: string;
  icon: string;
  description: string;
  spec: unknown;
  source: 'builtin' | 'user';
  created_at: unknown;
  updated_at: unknown;
};

type WireTemplate = {
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

function toIso(value: unknown): string {
  if (value instanceof Date) return value.toISOString();
  if (typeof value === 'string') {
    const d = new Date(value);
    return Number.isNaN(d.getTime()) ? value : d.toISOString();
  }
  return value == null ? '' : String(value);
}

function toWire(row: TemplateRow): WireTemplate {
  const parsed = validateSpec(row.spec);
  return {
    id: String(row.id),
    slug: row.slug,
    name: row.name,
    category: row.category,
    icon: row.icon,
    description: row.description,
    source: row.source,
    spec: parsed.ok ? parsed.spec : (row.spec as TemplateSpec),
    created_at: toIso(row.created_at),
    updated_at: toIso(row.updated_at),
  };
}

const listQuery = z.object({
  category: z.string().optional(),
  source: z.string().optional(),
});

const specBody = z.object({ spec: z.unknown() });

const deployBody = z.object({
  name: z.string().trim().min(1).max(100),
  values: z
    .record(z.union([z.string(), z.number(), z.boolean()]))
    .optional(),
});

function coerceValues(input: Record<string, string | number | boolean> | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(input ?? {})) out[k] = String(v);
  return out;
}

export default async function templatesRoutes(app: FastifyInstance): Promise<void> {
  // Read routes seed the built-in catalog on first use so the API works even if boot seeding
  // was skipped (e.g. the table was empty when the process started).
  app.get('/templates', { preHandler: requireRole('viewer') }, async (req, reply) => {
    await ensureBuiltinTemplates();
    const { category, source } = listQuery.parse(req.query ?? {});
    const rows = await many<TemplateRow>(
      `select * from templates
        where ($1::text is null or category = $1)
          and ($2::text is null or source = $2)
        order by category asc, name asc`,
      [category ?? null, source ?? null],
    );
    return reply.code(200).send(filterVisible(req.scope, 'template', rows.map(toWire), (t) => ({ id: t.id, slug: t.slug })));
  });

  app.get('/templates/:slug', { preHandler: requireRole('viewer') }, async (req, reply) => {
    await ensureBuiltinTemplates();
    const { slug } = req.params as { slug: string };
    const row = await one<TemplateRow>('select * from templates where slug = $1', [slug]);
    if (!row) return sendError(reply, 404, 'not_found', `template not found: ${slug}`);
    if (!canSee(req.scope, 'template', { id: String(row.id), slug: row.slug })) {
      return denyScoped(reply, 'template', slug);
    }
    return reply.code(200).send(toWire(row));
  });

  app.post('/templates', { preHandler: requireRole('operator') }, async (req, reply) => {
    const { spec: rawSpec } = specBody.parse(req.body ?? {});
    const result = validateSpec(rawSpec);
    if (!result.ok) {
      return sendError(reply, 400, 'validation_error', 'invalid template spec', {
        errors: result.errors,
      });
    }
    const spec = result.spec;

    const existing = await one<{ id: string }>('select id from templates where slug = $1', [spec.slug]);
    if (existing) {
      return sendError(reply, 409, 'conflict', `a template with slug "${spec.slug}" already exists`);
    }

    const row = await one<TemplateRow>(
      `insert into templates (slug, name, category, icon, description, spec, source)
       values ($1, $2, $3, $4, $5, $6::jsonb, 'user')
       returning *`,
      [spec.slug, spec.name, spec.category, spec.icon, spec.description, JSON.stringify(spec)],
    );
    if (!row) return sendError(reply, 500, 'internal', 'failed to create template');
    // A scoped user who authors a template gets it allocated to them, otherwise
    // they would create one and immediately be unable to see or deploy it.
    if (!isUnrestricted(req.scope) && req.user) {
      await query(
        `insert into user_grants (user_id, resource_kind, resource_id, created_by)
         values ($1, 'template', $2, $1)
         on conflict do nothing`,
        [req.user.id, spec.slug],
      );
    }
    await auditFromRequest(req, 'template.create', 'template', row.slug, { name: row.name });
    return reply.code(201).send(toWire(row));
  });

  app.patch('/templates/:slug', { preHandler: requireRole('operator') }, async (req, reply) => {
    const { slug } = req.params as { slug: string };
    const { spec: rawSpec } = specBody.parse(req.body ?? {});
    const result = validateSpec(rawSpec);
    if (!result.ok) {
      return sendError(reply, 400, 'validation_error', 'invalid template spec', {
        errors: result.errors,
      });
    }
    const spec = result.spec;

    const row = await one<TemplateRow>(
      `update templates
          set slug = $2, name = $3, category = $4, icon = $5, description = $6,
              spec = $7::jsonb, updated_at = now()
        where slug = $1
        returning *`,
      [slug, spec.slug, spec.name, spec.category, spec.icon, spec.description, JSON.stringify(spec)],
    );
    if (!row) return sendError(reply, 404, 'not_found', `template not found: ${slug}`);
    await auditFromRequest(req, 'template.update', 'template', row.slug, { name: row.name });
    return reply.code(200).send(toWire(row));
  });

  app.delete('/templates/:slug', { preHandler: requireRole('admin') }, async (req, reply) => {
    const { slug } = req.params as { slug: string };
    const row = await one<TemplateRow>('select * from templates where slug = $1', [slug]);
    if (!row) return sendError(reply, 404, 'not_found', `template not found: ${slug}`);
    if (row.source === 'builtin') {
      return sendError(reply, 409, 'conflict', 'built-in templates cannot be deleted');
    }
    await query('delete from templates where slug = $1', [slug]);
    await auditFromRequest(req, 'template.delete', 'template', slug, { name: row.name });
    return reply.code(200).send({ ok: true });
  });

  app.post('/templates/:slug/deploy', { preHandler: requireRole('operator') }, async (req, reply) => {
    const { slug } = req.params as { slug: string };
    const body = deployBody.parse(req.body ?? {});
    const values = coerceValues(body.values);

    // Deploying is an allocation question as well as a permission one: a scoped
    // user may only deploy templates the admin granted them.
    if (!canSee(req.scope, 'template', { slug })) return denyScoped(reply, 'template', slug);

    try {
      const result = await deployTemplate({
        slug,
        name: body.name,
        values,
        userId: req.user?.id ?? null,
        extraLabels: grantLabel(req.scope, 'container') ?? undefined,
      });
      await auditFromRequest(req, 'template.deploy', 'stack', result.stack.id, {
        slug,
        name: result.stack.name,
        container: result.container.id,
      });
      return reply.code(201).send({
        stack: result.stack,
        container: { id: result.container.id, name: result.container.name },
      });
    } catch (err) {
      if (err instanceof TemplateValidationError) {
        return sendError(reply, 400, 'validation_error', err.message, err.details);
      }
      if (err instanceof TemplateNotFoundError) {
        return sendError(reply, 404, 'not_found', err.message);
      }
      throw err; // DockerError / anything else -> the app error handler maps it
    }
  });
}
