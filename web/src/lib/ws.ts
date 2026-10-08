/**
 * Managed WebSocket helper for the Dockyard WS protocol (CONTRACT.md §7).
 * Frames are JSON text. Reconnects with exponential backoff + jitter, resets
 * the backoff on a successful open, stops on an explicit close() and stops
 * permanently on close code 4401 (unauthenticated upgrade).
 */

export type SocketStatus = 'connecting' | 'open' | 'closed' | 'error' | 'unauthorized';

export type ManagedSocket = {
  close(): void;
  readonly status: SocketStatus;
};

type Options = {
  onMessage: (data: unknown) => void;
  onStatus?: (status: SocketStatus) => void;
  /** Send a keepalive {type:'ping'} on this interval while open. 0 disables. */
  pingMs?: number;
  /** First backoff delay in ms (default 500). */
  baseDelay?: number;
  /** Max backoff delay in ms (default 15000). */
  maxDelay?: number;
};

function wsUrl(path: string): string {
  const proto = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
  return `${proto}//${window.location.host}${path}`;
}

export function connectSocket(path: string, opts: Options): ManagedSocket {
  const baseDelay = opts.baseDelay ?? 500;
  const maxDelay = opts.maxDelay ?? 15000;
  const pingMs = opts.pingMs ?? 0;

  let socket: WebSocket | null = null;
  let closed = false;
  let attempt = 0;
  let reconnectTimer: number | null = null;
  let pingTimer: number | null = null;
  let status: SocketStatus = 'connecting';

  const setStatus = (next: SocketStatus) => {
    status = next;
    opts.onStatus?.(next);
  };

  const clearTimers = () => {
    if (reconnectTimer !== null) {
      window.clearTimeout(reconnectTimer);
      reconnectTimer = null;
    }
    if (pingTimer !== null) {
      window.clearInterval(pingTimer);
      pingTimer = null;
    }
  };

  const scheduleReconnect = () => {
    if (closed) return;
    const delay = Math.min(maxDelay, baseDelay * Math.pow(1.8, attempt)) * (0.7 + Math.random() * 0.6);
    attempt += 1;
    setStatus('connecting');
    reconnectTimer = window.setTimeout(open, delay);
  };

  function open() {
    if (closed) return;
    let ws: WebSocket;
    try {
      ws = new WebSocket(wsUrl(path));
    } catch {
      scheduleReconnect();
      return;
    }
    socket = ws;

    ws.onopen = () => {
      attempt = 0;
      setStatus('open');
      if (pingMs > 0) {
        pingTimer = window.setInterval(() => {
          if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: 'ping' }));
        }, pingMs);
      }
    };

    ws.onmessage = (ev) => {
      if (typeof ev.data !== 'string') return;
      let parsed: unknown;
      try {
        parsed = JSON.parse(ev.data);
      } catch {
        return;
      }
      opts.onMessage(parsed);
    };

    ws.onerror = () => {
      setStatus('error');
    };

    ws.onclose = (ev) => {
      if (pingTimer !== null) {
        window.clearInterval(pingTimer);
        pingTimer = null;
      }
      socket = null;
      if (closed) return;
      if (ev.code === 4401) {
        closed = true;
        setStatus('unauthorized');
        return;
      }
      scheduleReconnect();
    };
  }

  open();

  return {
    close() {
      closed = true;
      clearTimers();
      if (socket) {
        socket.onclose = null;
        socket.onerror = null;
        socket.onmessage = null;
        try {
          socket.close(1000, 'client closed');
        } catch {
          /* ignore */
        }
        socket = null;
      }
      setStatus('closed');
    },
    get status() {
      return status;
    },
  };
}
