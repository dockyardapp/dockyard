// Dockyard — live container stats over WebSocket (owner: agent 2).
//
//   GET /ws/containers/:id/stats
//   server -> client: { "type": "stats", "stats": ContainerStats } every 1500 ms
//
// The polling timer is cleared on close; a container that disappears ends the stream.

import type { FastifyInstance } from 'fastify';
import { containerStats, resolveContainer } from '../docker/index.ts';
import { SESSION_COOKIE, readSession } from '../auth/sessions.ts';
import { logger } from '../logger.ts';

const INTERVAL_MS = 1500;

export default async function statsWs(app: FastifyInstance): Promise<void> {
  app.get('/ws/containers/:id/stats', { websocket: true }, async (socket, req) => {
    const user = await readSession(req.cookies?.[SESSION_COOKIE]);
    if (!user) {
      try {
        socket.close(4401, 'unauthorized');
      } catch {
        /* already closing */
      }
      return;
    }

    const idOrName = String((req.params as { id?: string })?.id ?? '');

    const send = (payload: unknown): void => {
      try {
        if (socket.readyState === socket.OPEN) socket.send(JSON.stringify(payload));
      } catch {
        /* client vanished mid-send */
      }
    };

    let summary;
    try {
      summary = await resolveContainer(idOrName);
    } catch (err) {
      logger.debug('ws stats: resolve failed', { error: err instanceof Error ? err.message : String(err) });
      send({ type: 'end', reason: 'error' });
      socket.close(1011, 'docker error');
      return;
    }
    if (!summary) {
      send({ type: 'end', reason: 'container_gone' });
      socket.close(1000, 'container gone');
      return;
    }

    let stopped = false;
    let timer: NodeJS.Timeout | null = null;

    const cleanup = (): void => {
      if (stopped) return;
      stopped = true;
      if (timer) {
        clearInterval(timer);
        timer = null;
      }
    };

    const tick = async (): Promise<void> => {
      if (stopped) return;
      try {
        const stats = await containerStats(summary.id);
        send({ type: 'stats', stats });
      } catch (err) {
        const statusCode = (err as { statusCode?: number })?.statusCode;
        send({ type: 'end', reason: statusCode === 404 ? 'container_gone' : 'error' });
        cleanup();
        try {
          socket.close(1000, 'stats ended');
        } catch {
          /* ignore */
        }
      }
    };

    timer = setInterval(() => {
      void tick();
    }, INTERVAL_MS);

    socket.on('message', () => {
      /* keepalive only */
    });
    socket.on('close', cleanup);
    socket.on('error', cleanup);

    void tick();
  });
}
