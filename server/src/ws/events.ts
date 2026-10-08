// Dockyard — global event stream over WebSocket (owner: agent 2).
//
//   GET /ws/events
//   server -> client: { "type": "container"|"tunnel"|"stack", "action": "...", "data": {...} }
//
// Every authenticated client is a subscriber on the in-process bus (events.ts).
// The subscription is released the moment the socket closes.

import type { FastifyInstance } from 'fastify';
import { bus } from '../events.ts';
import { SESSION_COOKIE, readSession } from '../auth/sessions.ts';

export default async function eventsWs(app: FastifyInstance): Promise<void> {
  app.get('/ws/events', { websocket: true }, async (socket, req) => {
    const user = await readSession(req.cookies?.[SESSION_COOKIE]);
    if (!user) {
      try {
        socket.close(4401, 'unauthorized');
      } catch {
        /* already closing */
      }
      return;
    }

    const send = (payload: unknown): void => {
      try {
        if (socket.readyState === socket.OPEN) socket.send(JSON.stringify(payload));
      } catch {
        /* client vanished mid-send */
      }
    };

    const unsubscribe = bus.on((ev) => send(ev));

    socket.on('message', () => {
      /* one-way stream; client messages are ignored */
    });
    socket.on('close', unsubscribe);
    socket.on('error', unsubscribe);
  });
}
