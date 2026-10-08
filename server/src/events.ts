// Dockyard — in-process event bus (owner: agent 2).
//
// A tiny typed emitter used to fan container/image/lifecycle events out to the
// `/ws/events` WebSocket clients. Contract §7:
//
//   export type BusEvent = { type: 'container'|'tunnel'|'stack'; action: string; data: unknown };
//   export const bus: { emit(ev): void; on(fn): () => void };
//
// Agent 2 publishes container events from the container routes; agents 3 and 4
// publish tunnel and stack events. A throwing listener must never break the emitter
// or the request that produced the event.

export type BusEvent = { type: 'container' | 'tunnel' | 'stack'; action: string; data: unknown };

type Listener = (ev: BusEvent) => void;

const listeners = new Set<Listener>();

export const bus = {
  emit(ev: BusEvent): void {
    // Snapshot so a listener that unsubscribes mid-emit cannot skip another one.
    for (const fn of [...listeners]) {
      try {
        fn(ev);
      } catch {
        /* a broken subscriber never breaks the publisher */
      }
    }
  },
  on(fn: Listener): () => void {
    listeners.add(fn);
    return () => {
      listeners.delete(fn);
    };
  },
};
