// Dockyard — global event stream over WebSocket (owner: agent 2).
//
//   GET /ws/events
//   server -> client: { "type": "container"|"tunnel"|"stack", "action": "...", "data": {...} }
//
// Every authenticated client is a subscriber on the in-process bus (events.ts).
// The subscription is released the moment the socket closes.

import type { FastifyInstance } from 'fastify';
import { bus } from '../events.ts';
import { authenticate } from '../auth/sessions.ts';
import { eventVisible } from './visibility.ts';

export default async function eventsWs(app: FastifyInstance): Promise<void> {
  app.get('/ws/events', { websocket: true }, async (socket, req) => {
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

    const send = (payload: unknown): void => {
      try {
        if (socket.readyState === socket.OPEN) socket.send(JSON.stringify(payload));
      } catch {
        /* client vanished mid-send */
      }
    };

    // A scoped subscriber receives only the events for resources it may see, and
    // an event that cannot be attributed to a visible resource is withheld. The
    // filter is synchronous, so the order of the stream is preserved.
    const unsubscribe = bus.on((ev) => {
      if (eventVisible(scope, ev)) send(ev);
    });

    socket.on('message', () => {
      /* one-way stream; client messages are ignored */
    });
    socket.on('close', unsubscribe);
    socket.on('error', unsubscribe);
  });
}
