// Dockyard — Fastify application factory (owner: agent 2).
//
// buildApp() wires the whole HTTP surface: plugins, the single error handler that emits the
// frozen error envelope, the REST routes under /api, the WebSocket routes under /ws, and the
// SPA fallback that serves web/dist (or a placeholder while the frontend is still building).

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import Fastify from 'fastify';
import type { FastifyInstance, FastifyPluginAsync } from 'fastify';
import cookie from '@fastify/cookie';
import rateLimit from '@fastify/rate-limit';
import websocket from '@fastify/websocket';
import fastifyStatic from '@fastify/static';
import { ZodError } from 'zod';
import { config, repoRoot } from './config.ts';
import { logger } from './logger.ts';
import { DockerError } from './docker/errors.ts';
import { sendError } from './auth/rbac.ts';
import type { ErrorCode } from './auth/rbac.ts';

// Routes owned by this agent.
import authRoutes from './routes/auth.ts';
import systemRoutes from './routes/system.ts';
import containersRoutes from './routes/containers.ts';
import imagesRoutes from './routes/images.ts';
import volumesRoutes from './routes/volumes.ts';
import networksRoutes from './routes/networks.ts';
import auditRoutes from './routes/audit.ts';
import usersRoutes from './routes/users.ts';

// WebSocket routes owned by this agent.
import logsWs from './ws/logs.ts';
import statsWs from './ws/stats.ts';
import eventsWs from './ws/events.ts';

// Routes owned by agents 3 (tunnels, settings) and 4 (templates, stacks). They are loaded
// dynamically so this app boots and is testable while those files are still being written:
// each missing module is logged as a warning and skipped. Once the file lands it is picked up
// on the next boot with no change here.
//
// NOTE: the two route-owner agents disagreed on whether `/api` is baked into their paths —
// tunnels/settings declare absolute '/api/...' paths, templates/stacks declare bare '/templates'
// paths. apiPrefixFor() detects the convention per module so both mount at the contract URLs.
const OPTIONAL_ROUTE_MODULES = [
  './routes/tunnels.ts', // agent 3
  './routes/settings.ts', // agent 3
  './routes/templates.ts', // agent 4
  './routes/stacks.ts', // agent 4
];

const moduleDir = path.dirname(fileURLToPath(import.meta.url));

function apiPrefixFor(spec: string): string {
  try {
    const src = fs.readFileSync(path.join(moduleDir, spec), 'utf8');
    return /app\.(get|post|patch|put|delete)\(\s*['"]\/api\//.test(src) ? '' : '/api';
  } catch {
    return '/api';
  }
}

const PLACEHOLDER_HTML = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>Dockyard API</title>
<meta name="viewport" content="width=device-width,initial-scale=1">
<style>body{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;background:#0b0d10;color:#e6e8eb;margin:0;display:grid;place-items:center;height:100vh}
main{max-width:38rem;padding:2rem;border:1px solid #24282e;border-radius:10px;background:#111418}
h1{font-size:1.1rem;margin:0 0 .75rem}p{margin:.4rem 0;color:#9aa4b2;line-height:1.5}code{color:#7dd3fc}</style>
</head><body><main>
<h1>Dockyard API is running</h1>
<p>The frontend bundle was not found at <code>web/dist</code>.</p>
<p>Build it with <code>npm --workspace web run build</code>, or run the Vite dev server on
port <code>5190</code> and open that instead.</p>
<p>API health: <code>/api/system/health</code></p>
</main></body></html>`;

async function loadOptionalPlugin(spec: string): Promise<FastifyPluginAsync | null> {
  try {
    const mod: any = await import(spec);
    const plugin = mod?.default ?? mod;
    if (typeof plugin !== 'function') {
      logger.warn('optional route module has no default export; skipping', { spec });
      return null;
    }
    return plugin as FastifyPluginAsync;
  } catch (err) {
    logger.warn('optional route module not on disk yet; skipping registration', {
      spec,
      error: err instanceof Error ? err.message : String(err),
    });
    return null;
  }
}

export async function buildApp(): Promise<FastifyInstance> {
  const app = Fastify({
    logger: false,
    trustProxy: true,
    bodyLimit: 1024 * 1024,
  });

  // Request-scoped auth state, populated by the auth preHandlers.
  app.decorateRequest('user', null);
  app.decorateRequest('sessionToken', null);

  await app.register(cookie);

  // Per-route opt-in rate limiting (the login route sets its own budget).
  await app.register(rateLimit, { global: false });

  await app.register(websocket);

  // ---------------------------------------------------------------------------
  // Error handling — one envelope for the whole API (contract §6).
  // ---------------------------------------------------------------------------
  app.setErrorHandler((err, req, reply) => {
    if (err instanceof ZodError) {
      return sendError(reply, 400, 'validation_error', 'request validation failed', {
        issues: err.issues.map((i) => ({ path: i.path.join('.'), message: i.message, code: i.code })),
      });
    }

    const anyErr = err as any;

    // Fastify's own schema validation (kept for completeness).
    if (anyErr?.validation) {
      return sendError(reply, 400, 'validation_error', anyErr.message || 'request validation failed', {
        issues: anyErr.validation,
      });
    }

    if (err instanceof DockerError) {
      const allowed: ErrorCode[] = ['not_found', 'conflict', 'validation_error', 'docker_unavailable', 'docker_error'];
      const code = (allowed as string[]).includes(err.code) ? (err.code as ErrorCode) : 'docker_error';
      const status = Number.isInteger(err.statusCode) ? err.statusCode : 502;
      if (status >= 500) logger.warn('docker request failed', { code, message: err.message });
      return sendError(reply, status, code, err.message || 'docker error');
    }

    const status = Number(anyErr?.statusCode);
    if (Number.isInteger(status) && status >= 400 && status < 500) {
      const code: ErrorCode =
        status === 401 ? 'unauthorized' : status === 403 ? 'forbidden' : status === 404 ? 'not_found' : status === 409 ? 'conflict' : 'validation_error';
      const fallback = status === 429 ? 'rate_limited' : code;
      return sendError(reply, status, fallback as ErrorCode, anyErr.message || 'request failed');
    }

    // Unknown — log with the stack, never return it.
    logger.error('unhandled route error', {
      method: req.method,
      url: req.url,
      error: err instanceof Error ? err.message : String(err),
      stack: err instanceof Error ? err.stack : undefined,
    });
    return sendError(reply, 500, 'internal', 'internal server error');
  });

  // Light debug trace of every response (no bodies, no secrets).
  app.addHook('onResponse', async (req, reply) => {
    logger.debug('request', {
      method: req.method,
      url: req.url,
      status: reply.statusCode,
      ms: Math.round(reply.elapsedTime),
    });
  });

  // ---------------------------------------------------------------------------
  // Static frontend (web/dist) — optional while the frontend agent is working.
  // ---------------------------------------------------------------------------
  const webDist = path.join(repoRoot, 'web', 'dist');
  const hasWebDist = fs.existsSync(path.join(webDist, 'index.html'));
  if (hasWebDist) {
    await app.register(fastifyStatic, {
      root: webDist,
      prefix: '/',
      // Managed here rather than by the plugin, so the two cases can differ.
      cacheControl: false,
      setHeaders(res, filePath) {
        // Vite writes content-hashed filenames under /assets, so a given URL's
        // bytes never change and it can be cached forever. index.html is the
        // opposite: it names the current hashes, so caching it would pin a
        // client to assets that a later deploy has already deleted.
        if (filePath.includes(`${path.sep}assets${path.sep}`)) {
          res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
        } else {
          res.setHeader('Cache-Control', 'no-cache');
        }
      },
    });
    logger.info('serving static frontend', { root: webDist });
  } else {
    logger.warn('web/dist not built yet; serving a placeholder page at /', { expected: webDist });
  }

  // ---------------------------------------------------------------------------
  // Routes
  // ---------------------------------------------------------------------------
  await app.register(authRoutes, { prefix: '/api' });
  await app.register(systemRoutes, { prefix: '/api' });
  await app.register(containersRoutes, { prefix: '/api' });
  await app.register(imagesRoutes, { prefix: '/api' });
  await app.register(volumesRoutes, { prefix: '/api' });
  await app.register(networksRoutes, { prefix: '/api' });
  await app.register(auditRoutes, { prefix: '/api' });
  await app.register(usersRoutes, { prefix: '/api' });

  for (const spec of OPTIONAL_ROUTE_MODULES) {
    const plugin = await loadOptionalPlugin(spec);
    if (!plugin) continue;
    const prefix = apiPrefixFor(spec);
    await app.register(plugin, prefix ? { prefix } : {});
    logger.debug('registered optional route module', { spec, prefix: prefix || '(absolute paths)' });
  }

  // WebSocket routes (no /api prefix).
  await app.register(logsWs);
  await app.register(statsWs);
  await app.register(eventsWs);

  // ---------------------------------------------------------------------------
  // SPA fallback: any non-/api, non-/ws GET returns index.html.
  // ---------------------------------------------------------------------------
  app.setNotFoundHandler(async (req, reply) => {
    const url = req.raw.url ?? req.url ?? '';
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      return sendError(reply, 404, 'not_found', `route ${req.method} ${req.url} not found`);
    }
    if (url.startsWith('/api') || url.startsWith('/ws')) {
      return sendError(reply, 404, 'not_found', `route ${req.method} ${req.url} not found`);
    }
    // A missing asset is a miss, not a deep link. Falling through to index.html
    // would hand the browser HTML for a .js request, which surfaces as a
    // confusing MIME type error instead of a clean 404.
    if (url.startsWith('/assets/')) {
      return sendError(reply, 404, 'not_found', `asset ${url} not found`);
    }
    if (hasWebDist) {
      return reply.type('text/html; charset=utf-8').sendFile('index.html');
    }
    return reply.type('text/html; charset=utf-8').send(PLACEHOLDER_HTML);
  });

  logger.debug('app built', { env: config.env, port: config.port });
  return app;
}
