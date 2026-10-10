// Dockyard — live container logs over WebSocket (owner: agent 2).
//
//   GET /ws/containers/:id/logs?tail=200
//   server -> client: { "type": "log", "line": "..." } … { "type": "end", "reason": "..." }
//   client -> server: { "type": "ping" }   (no reply in the frozen protocol)
//
// Auth is the same session cookie as the REST API. An unauthenticated upgrade is closed
// with code 4401. The docker stream and all listeners are torn down when the client leaves.

import type { FastifyInstance } from 'fastify';
import { containerLogsStream, resolveContainer } from '../docker/index.ts';
import { authenticate } from '../auth/sessions.ts';
import { canSeeContainer } from './visibility.ts';
import { logger } from '../logger.ts';

type EndReason = 'stream_ended' | 'container_gone' | 'error';

export default async function logsWs(app: FastifyInstance): Promise<void> {
  app.get('/ws/containers/:id/logs', { websocket: true }, async (socket, req) => {
    // `authenticate` is what the REST routes use: it resolves the session and
    // loads `req.scope`, which is the allocation this socket has to honour.
    await authenticate(req);
    if (!req.user) {
      try {
        socket.close(4401, 'unauthorized');
      } catch {
        /* already closing */
      }
      return;
    }
    const scope = req.scope;

    const idOrName = String((req.params as { id?: string })?.id ?? '');
    const tailRaw = Number((req.query as { tail?: string })?.tail);
    const tail = Number.isFinite(tailRaw) ? Math.min(Math.max(Math.floor(tailRaw), 0), 100000) : 200;

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
      logger.debug('ws logs: resolve failed', { error: err instanceof Error ? err.message : String(err) });
      send({ type: 'end', reason: 'error' satisfies EndReason });
      socket.close(1011, 'docker error');
      return;
    }
    if (!summary) {
      send({ type: 'end', reason: 'container_gone' satisfies EndReason });
      socket.close(1000, 'container gone');
      return;
    }

    // A container outside the caller's allocation is refused exactly like one
    // that does not exist, so a scoped user cannot enumerate the host by probing
    // ids over a socket any more than over the REST route, which 404s.
    if (!canSeeContainer(scope, summary)) {
      logger.debug('ws logs: container outside the caller scope', { id: summary.id });
      send({ type: 'end', reason: 'container_gone' satisfies EndReason });
      socket.close(1000, 'container gone');
      return;
    }

    let stream: NodeJS.ReadableStream;
    try {
      stream = await containerLogsStream(summary.id, { tail });
    } catch (err) {
      logger.debug('ws logs: stream open failed', { error: err instanceof Error ? err.message : String(err) });
      send({ type: 'end', reason: 'error' satisfies EndReason });
      socket.close(1011, 'stream error');
      return;
    }

    let buffer = '';
    let finished = false;

    const finalize = (reason: EndReason): void => {
      if (finished) return;
      finished = true;
      if (buffer.length > 0) {
        send({ type: 'log', line: buffer.replace(/\r$/, '') });
        buffer = '';
      }
      send({ type: 'end', reason });
      try {
        socket.close(1000, reason);
      } catch {
        /* already closed */
      }
    };

    const onData = (chunk: Buffer | string): void => {
      buffer += typeof chunk === 'string' ? chunk : chunk.toString('utf8');
      let idx = buffer.indexOf('\n');
      while (idx >= 0) {
        const line = buffer.slice(0, idx).replace(/\r$/, '');
        buffer = buffer.slice(idx + 1);
        send({ type: 'log', line });
        idx = buffer.indexOf('\n');
      }
    };

    stream.on('data', onData);
    stream.on('end', () => finalize('stream_ended'));
    stream.on('error', (err: NodeJS.ErrnoException & { statusCode?: number }) => {
      logger.debug('ws logs: stream error', { error: err?.message });
      finalize(err?.statusCode === 404 ? 'container_gone' : 'error');
    });

    socket.on('message', () => {
      /* keepalive only — the frozen protocol defines no server reply to ping */
    });
    socket.on('close', () => {
      finished = true;
      stream.removeListener('data', onData);
      try {
        (stream as unknown as { destroy?: () => void }).destroy?.();
      } catch {
        /* ignore */
      }
    });
    socket.on('error', () => {
      finished = true;
      try {
        (stream as unknown as { destroy?: () => void }).destroy?.();
      } catch {
        /* ignore */
      }
    });
  });
}
