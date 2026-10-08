// Dockyard — settings + Cloudflare credential routes (owner: agent 3). Contract §6.
//
//   GET    /api/settings                   admin  -> SettingsView (secrets masked)
//   PATCH  /api/settings                   admin  -> SettingsView
//   GET    /api/cloudflare/status          admin
//   POST   /api/cloudflare/credentials     admin
//   DELETE /api/cloudflare/credentials     admin
//
// The Cloudflare API token is stored encrypted in `settings` under `cloudflare.api_token`
// and is NEVER returned: the wire only carries a masked form plus configured/verified flags.

import type { FastifyInstance, FastifyReply } from 'fastify';
import { z } from 'zod';
import { auditFromRequest } from '../auth/audit.ts';
import { requireRole, sendError } from '../auth/rbac.ts';
import { config } from '../config.ts';
import { many, query } from '../db/pool.ts';
import { logger } from '../logger.ts';
import { encryptSecret, maskSecret } from '../secrets.ts';
import {
  cfListAccounts,
  cfListZones,
  cfVerifyToken,
  resolveCreds,
} from '../cloudflare/api.ts';

const CF_TOKEN_KEY = 'cloudflare.api_token';
const CF_ACCOUNT_KEY = 'cloudflare.account_id';

export type SettingsView = {
  cloudflare: {
    configured: boolean;
    verified: boolean;
    accountId: string | null;
    tokenMasked: string | null;
  };
  app: {
    env: string;
    publicUrl: string;
    logLevel: string;
    cloudflaredBin: string;
    tunnelDataDir: string;
    tunnelTargetHost: string;
  };
  settings: Record<string, unknown>;
};

function message(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function fail(reply: FastifyReply, err: unknown) {
  const anyErr = err as { statusCode?: number; code?: string; message?: string };
  if (typeof anyErr?.statusCode === 'number') {
    return sendError(
      reply,
      anyErr.statusCode,
      (anyErr.code as Parameters<typeof sendError>[2]) ?? 'internal',
      anyErr.message ?? 'error',
    );
  }
  if (err instanceof z.ZodError) {
    return sendError(
      reply,
      400,
      'validation_error',
      err.issues.map((i) => i.message).join('; ') || 'invalid request body',
    );
  }
  logger.error('settings route error', { error: message(err) });
  return sendError(reply, 500, 'internal', message(err));
}

function tunnelTargetHost(): string {
  const raw = (config as unknown as { tunnelTargetHost?: string }).tunnelTargetHost;
  return (raw ?? '').trim() || '127.0.0.1';
}

async function readNonSecretSettings(): Promise<Record<string, unknown>> {
  const rows = await many<{ key: string; value: unknown }>(
    'select key, value from settings where secret = false order by key',
  );
  const out: Record<string, unknown> = {};
  for (const row of rows) out[row.key] = row.value;
  return out;
}

async function buildView(): Promise<SettingsView> {
  const creds = await resolveCreds();
  return {
    cloudflare: {
      configured: !!creds,
      verified: false, // live verification lives in GET /api/cloudflare/status
      accountId: creds?.accountId ?? null,
      tokenMasked: creds ? maskSecret(creds.apiToken) : null,
    },
    app: {
      env: config.env,
      publicUrl: config.publicUrl,
      logLevel: config.logLevel,
      cloudflaredBin: config.cloudflaredBin,
      tunnelDataDir: config.tunnelDataDir,
      tunnelTargetHost: tunnelTargetHost(),
    },
    settings: await readNonSecretSettings(),
  };
}

async function upsertSetting(key: string, value: unknown, secret: boolean): Promise<void> {
  await query(
    `insert into settings (key, value, secret, updated_at)
     values ($1, $2, $3, now())
     on conflict (key) do update set value = excluded.value, secret = excluded.secret, updated_at = now()`,
    [key, JSON.stringify(value ?? null), secret],
  );
}

export default async function settingsRoutes(app: FastifyInstance): Promise<void> {
  app.get('/api/settings', { preHandler: requireRole('admin') }, async (_req, reply) => {
    try {
      return await buildView();
    } catch (err) {
      return fail(reply, err);
    }
  });

  app.patch('/api/settings', { preHandler: requireRole('admin') }, async (req, reply) => {
    try {
      const body = (req.body ?? {}) as Record<string, unknown>;
      const patch =
        body.settings && typeof body.settings === 'object' && !Array.isArray(body.settings)
          ? (body.settings as Record<string, unknown>)
          : body;

      const keys = Object.keys(patch);
      if (keys.length === 0) {
        return sendError(reply, 400, 'validation_error', 'no settings provided');
      }

      for (const [key, value] of Object.entries(patch)) {
        if (key === CF_TOKEN_KEY) {
          return sendError(
            reply,
            400,
            'validation_error',
            'use POST /api/cloudflare/credentials to set the Cloudflare API token',
          );
        }
        await upsertSetting(key, value, false);
      }

      await auditFromRequest(req, 'settings.update', 'settings', null, { keys });
      return await buildView();
    } catch (err) {
      return fail(reply, err);
    }
  });

  app.get('/api/cloudflare/status', { preHandler: requireRole('admin') }, async (_req, reply) => {
    try {
      const creds = await resolveCreds();
      if (!creds) {
        return { configured: false, verified: false, accountId: null, accounts: [], zones: [] };
      }
      const verify = await cfVerifyToken();
      let accounts: Array<{ id: string; name: string }> = [];
      let zones: Array<{ id: string; name: string; accountId: string }> = [];
      let error: string | undefined = verify.error;
      if (verify.ok) {
        try {
          accounts = await cfListAccounts();
        } catch (err) {
          error = error ?? message(err);
        }
        try {
          zones = await cfListZones();
        } catch (err) {
          error = error ?? message(err);
        }
      }
      return {
        configured: true,
        verified: verify.ok,
        accountId: creds.accountId,
        accounts,
        zones,
        ...(error ? { error } : {}),
      };
    } catch (err) {
      return fail(reply, err);
    }
  });

  app.post('/api/cloudflare/credentials', { preHandler: requireRole('admin') }, async (req, reply) => {
    try {
      const schema = z.object({
        apiToken: z.string().min(1).optional(),
        accountId: z.string().min(1),
      });
      const { apiToken, accountId } = schema.parse(req.body ?? {});

      if (apiToken) {
        await upsertSetting(CF_TOKEN_KEY, encryptSecret(apiToken), true);
      }
      await upsertSetting(CF_ACCOUNT_KEY, accountId, false);

      const verify = await cfVerifyToken();
      await auditFromRequest(req, 'cloudflare.credentials.update', 'settings', null, {
        accountId,
        tokenChanged: !!apiToken,
      });
      return { ok: true, verified: verify.ok, ...(verify.error ? { error: verify.error } : {}) };
    } catch (err) {
      return fail(reply, err);
    }
  });

  app.delete('/api/cloudflare/credentials', { preHandler: requireRole('admin') }, async (req, reply) => {
    try {
      await query('delete from settings where key in ($1, $2)', [CF_TOKEN_KEY, CF_ACCOUNT_KEY]);
      await auditFromRequest(req, 'cloudflare.credentials.delete', 'settings', null, null);
      return { ok: true };
    } catch (err) {
      return fail(reply, err);
    }
  });
}
