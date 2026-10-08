// Dockyard — server entry point (owner: agent 2).
//
//   loadEnvFile() -> runMigrations() -> ensureFirstBootAdmin() -> buildApp() -> listen()
//
// Handles SIGINT/SIGTERM: stop accepting connections, close WebSocket clients, shut the tunnel
// manager down if it is importable, drain the Postgres pool, exit 0. Route-level errors never
// crash the process (see the error handler in app.ts).

import { config, loadEnvFile } from './config.ts';
import { logger } from './logger.ts';
import { runMigrations } from './db/migrate.ts';
import { closePool, one } from './db/pool.ts';
import { hashPassword } from './auth/password.ts';
import { pruneExpiredSessions } from './auth/sessions.ts';
import { buildApp } from './app.ts';

/**
 * First boot: when the users table is empty and both DOCKYARD_ADMIN_EMAIL / DOCKYARD_ADMIN_PASSWORD
 * are set, create the admin. The password is hashed and never logged.
 */
async function ensureFirstBootAdmin(): Promise<void> {
  if (!config.adminEmail || !config.adminPassword) return;
  const row = await one<{ n: number }>('select count(*)::int as n from users');
  if ((row?.n ?? 0) > 0) return;

  const passwordHash = await hashPassword(config.adminPassword);
  const created = await one<{ id: string }>(
    `insert into users (email, password_hash, role) values ($1, $2, 'admin') returning id`,
    [config.adminEmail.toLowerCase(), passwordHash],
  );
  logger.info('first-boot admin created', { email: config.adminEmail, userId: created?.id });
}

async function initTunnels(): Promise<void> {
  try {
    const spec = './tunnels/manager.ts';
    const mod: any = await import(spec);
    if (typeof mod?.tunnelManager?.init === 'function') {
      await mod.tunnelManager.init();
      logger.info('tunnel manager initialised');
    }
  } catch (err) {
    logger.warn('tunnel manager not available; auto-start tunnels were not restored', {
      error: err instanceof Error ? err.message : String(err),
    });
  }
}

async function shutdownTunnels(): Promise<void> {
  try {
    const spec = './tunnels/manager.ts';
    const mod: any = await import(spec);
    if (typeof mod?.tunnelManager?.shutdown === 'function') {
      await mod.tunnelManager.shutdown();
      logger.info('tunnel manager shut down');
    }
  } catch {
    /* nothing to shut down */
  }
}

async function main(): Promise<void> {
  loadEnvFile();

  const { applied, already } = await runMigrations();
  if (applied.length > 0) logger.info('migrations applied', { applied });
  else logger.debug('no new migrations', { already: already.length });

  await ensureFirstBootAdmin();
  await pruneExpiredSessions().catch(() => 0);

  const app = await buildApp();
  await app.listen({ port: config.port, host: config.host });
  logger.info('dockyard api listening', {
    url: config.publicUrl,
    host: config.host,
    port: config.port,
    env: config.env,
    mode: config.dockerHost ? 'remote docker' : 'local socket',
  });

  await initTunnels();

  let shuttingDown = false;
  const shutdown = async (signal: string): Promise<void> => {
    if (shuttingDown) return;
    shuttingDown = true;
    logger.info('shutting down', { signal });
    try {
      await app.close(); // stops listening and closes WebSocket clients
    } catch (err) {
      logger.warn('error closing the http server', { error: err instanceof Error ? err.message : String(err) });
    }
    await shutdownTunnels();
    try {
      await closePool();
    } catch {
      /* ignore */
    }
    logger.info('shutdown complete');
    process.exit(0);
  };

  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('SIGTERM', () => void shutdown('SIGTERM'));

  // A stray rejection must be logged, not fatal.
  process.on('unhandledRejection', (reason) => {
    logger.error('unhandled promise rejection', { error: reason instanceof Error ? reason.message : String(reason) });
  });
  process.on('uncaughtException', (err) => {
    logger.error('uncaught exception', { error: err.message, stack: err.stack });
  });
}

main().catch((err) => {
  logger.error('fatal boot error', { error: err instanceof Error ? err.message : String(err), stack: err instanceof Error ? err.stack : undefined });
  process.exitCode = 1;
});
