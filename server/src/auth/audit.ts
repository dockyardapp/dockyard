// Dockyard — audit trail (owner: agent 2).
//
// Every mutating route writes a row here BEFORE it responds. `detail` is passed
// through `redact()` first, so a token/password/secret/env value can never be
// persisted even by accident.

import type { FastifyRequest } from 'fastify';
import { many, query } from '../db/pool.ts';
import { redact } from '../logger.ts';

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

export type AuditInput = {
  userId?: string | null;
  action: string;
  targetType: string;
  targetId?: string | null;
  detail?: unknown;
  ip?: string | null;
};

function toIso(value: unknown): string {
  if (value instanceof Date) return value.toISOString();
  if (typeof value === 'string') {
    const d = new Date(value);
    return Number.isNaN(d.getTime()) ? value : d.toISOString();
  }
  return value == null ? '' : String(value);
}

/** Write one audit row. Failures are swallowed by callers only if they choose to; here they propagate. */
export async function audit(input: AuditInput): Promise<void> {
  const detail =
    input.detail === undefined || input.detail === null ? null : JSON.stringify(redact(input.detail));
  await query(
    `insert into audit_log (user_id, action, target_type, target_id, detail, ip)
     values ($1, $2, $3, $4, $5, $6)`,
    [input.userId ?? null, input.action, input.targetType, input.targetId ?? null, detail, input.ip ?? null],
  );
}

export function clientIp(req: FastifyRequest): string | null {
  return req.ip ?? null;
}

/** Convenience wrapper that pulls the actor + ip off the request. */
export async function auditFromRequest(
  req: FastifyRequest,
  action: string,
  targetType: string,
  targetId?: string | null,
  detail?: unknown,
): Promise<void> {
  await audit({
    userId: req.user?.id ?? null,
    action,
    targetType,
    targetId: targetId ?? null,
    detail,
    ip: clientIp(req),
  });
}

export async function listAudit(opts: { limit?: number; offset?: number; action?: string }): Promise<AuditEntry[]> {
  const limit = Math.min(Math.max(opts.limit ?? 100, 1), 500);
  const offset = Math.max(opts.offset ?? 0, 0);
  const rows = await many(
    `select a.id, a.user_id, u.email as user_email, a.action, a.target_type,
            a.target_id, a.detail, a.ip, a.created_at
       from audit_log a
       left join users u on u.id = a.user_id
      where ($1::text is null or a.action = $1)
      order by a.created_at desc, a.id desc
      limit $2 offset $3`,
    [opts.action ?? null, limit, offset],
  );
  return rows.map((r) => ({
    id: Number(r.id),
    user_id: r.user_id ?? null,
    user_email: r.user_email ?? null,
    action: r.action,
    target_type: r.target_type,
    target_id: r.target_id ?? null,
    detail: r.detail ?? null,
    ip: r.ip ?? null,
    created_at: toIso(r.created_at),
  }));
}
