// Dockyard — Postgres pool + data access (owner: agent 1).
//
// One shared pg.Pool built from config.databaseUrl. JSONB columns come back as JS objects.
// Placeholders are node-postgres native ($1, $2, ...).

import pg from 'pg';
import type { Pool, PoolClient, QueryResult } from 'pg';
import { config } from '../config.ts';

const { Pool: PgPool } = pg;

export const pool: Pool = new PgPool({
  connectionString: config.databaseUrl,
  max: 10,
  idleTimeoutMillis: 30_000,
  connectionTimeoutMillis: 10_000,
});

// A pool-level error (e.g. backend terminated) must never crash the process.
pool.on('error', (err) => {
  process.stderr.write(
    JSON.stringify({ time: new Date().toISOString(), level: 'error', msg: 'pg pool error', error: String(err?.message ?? err) }) + '\n',
  );
});

export function query<T = any>(text: string, params?: unknown[]): Promise<QueryResult<T>> {
  return pool.query<T>(text, params as any[]);
}

/** First row, or null when there are no rows. */
export async function one<T = any>(text: string, params?: unknown[]): Promise<T | null> {
  const res = await pool.query<T>(text, params as any[]);
  return res.rows.length > 0 ? (res.rows[0] as T) : null;
}

export async function many<T = any>(text: string, params?: unknown[]): Promise<T[]> {
  const res = await pool.query<T>(text, params as any[]);
  return res.rows as T[];
}

/** Run `fn` inside a transaction; roll back on throw, always release the client. */
export async function tx<T>(fn: (client: PoolClient) => Promise<T>): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query('begin');
    const result = await fn(client);
    await client.query('commit');
    return result;
  } catch (err) {
    try {
      await client.query('rollback');
    } catch {
      /* the connection may already be broken */
    }
    throw err;
  } finally {
    client.release();
  }
}

export async function closePool(): Promise<void> {
  await pool.end();
}

export async function dbHealth(): Promise<{ ok: boolean; serverVersion?: string; error?: string }> {
  try {
    const row = await one<{ version: string }>('select version() as version');
    return { ok: true, serverVersion: row?.version };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}
