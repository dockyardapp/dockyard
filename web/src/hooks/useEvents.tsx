import { createContext, useCallback, useContext, useEffect, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import { connectSocket } from '../lib/ws';
import type { SocketStatus } from '../lib/ws';
import type { BusEvent, EventFrame } from '../api/types';

type Listener = (ev: BusEvent) => void;

type EventsState = {
  status: SocketStatus;
  lastEvent: BusEvent | null;
  /** Subscribe to every bus event. Returns an unsubscribe function. */
  subscribe: (fn: Listener) => () => void;
};

const EventsContext = createContext<EventsState | null>(null);

/** Single shared /ws/events socket for the whole app. */
export function EventsProvider({ children }: { children: ReactNode }) {
  const [status, setStatus] = useState<SocketStatus>('connecting');
  const [lastEvent, setLastEvent] = useState<BusEvent | null>(null);
  const listenersRef = useRef<Set<Listener>>(new Set());

  useEffect(() => {
    const sock = connectSocket('/ws/events', {
      onStatus: setStatus,
      onMessage: (raw) => {
        const frame = raw as EventFrame;
        if (!frame || typeof frame.type !== 'string' || typeof frame.action !== 'string') return;
        const ev: BusEvent = { type: frame.type, action: frame.action, data: frame.data };
        setLastEvent(ev);
        listenersRef.current.forEach((fn) => {
          try {
            fn(ev);
          } catch {
            /* a listener must not break the socket */
          }
        });
      },
    });
    return () => sock.close();
  }, []);

  const subscribe = useCallback((fn: Listener) => {
    listenersRef.current.add(fn);
    return () => {
      listenersRef.current.delete(fn);
    };
  }, []);

  return (
    <EventsContext.Provider value={{ status, lastEvent, subscribe }}>{children}</EventsContext.Provider>
  );
}

/**
 * Subscribe to the event bus. Pass a handler to run on every event; the handler
 * is kept current without re-subscribing. Returns the socket status and the
 * most recent event.
 */
export function useEvents(handler?: Listener): { status: SocketStatus; lastEvent: BusEvent | null } {
  const ctx = useContext(EventsContext);
  if (!ctx) throw new Error('useEvents must be used inside <EventsProvider>');
  const handlerRef = useRef(handler);
  handlerRef.current = handler;

  useEffect(() => {
    if (!handler) return;
    return ctx.subscribe((ev) => handlerRef.current?.(ev));
  }, [ctx, handler]);

  return { status: ctx.status, lastEvent: ctx.lastEvent };
}
