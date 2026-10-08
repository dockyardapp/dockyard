import { useCallback, useEffect, useRef, useState } from 'react';
import { connectSocket, type ManagedSocket, type SocketStatus } from '../lib/ws';
import type { LogFrame } from '../api/types';

const MAX_LINES = 5000;

export type LogStream = {
  lines: string[];
  status: SocketStatus;
  /** Set when the server sends {type:'end', reason}. */
  ended: string | null;
  clear: () => void;
};

/**
 * Live log tail over /ws/containers/:id/logs (CONTRACT.md §7).
 * Reconnects with backoff; pass `paused` to stop streaming without unmounting.
 */
export function useLogStream(
  containerId: string | null,
  opts: { tail?: number; paused?: boolean; enabled?: boolean; nonce?: number } = {},
): LogStream {
  const tail = opts.tail ?? 200;
  const paused = opts.paused ?? false;
  const enabled = opts.enabled ?? true;
  const nonce = opts.nonce ?? 0;

  const [lines, setLines] = useState<string[]>([]);
  const [status, setStatus] = useState<SocketStatus>('connecting');
  const [ended, setEnded] = useState<string | null>(null);
  const sockRef = useRef<ManagedSocket | null>(null);

  useEffect(() => {
    if (!containerId || paused || !enabled) return;
    setLines([]);
    setEnded(null);
    setStatus('connecting');
    const sock = connectSocket(`/ws/containers/${encodeURIComponent(containerId)}/logs?tail=${tail}`, {
      pingMs: 20000,
      onStatus: setStatus,
      onMessage: (raw) => {
        const frame = raw as LogFrame;
        if (frame && frame.type === 'log' && typeof frame.line === 'string') {
          setLines((prev) => {
            const next = prev.concat(frame.line);
            return next.length > MAX_LINES ? next.slice(next.length - MAX_LINES) : next;
          });
        } else if (frame && frame.type === 'end') {
          // The server ended the stream (container gone, or logs finished).
          // Stop here rather than reconnecting: an ended stream would
          // otherwise reconnect-loop forever.
          setEnded(frame.reason);
          sockRef.current?.close();
        }
      },
    });
    sockRef.current = sock;
    return () => {
      sock.close();
      sockRef.current = null;
    };
  }, [containerId, tail, paused, enabled, nonce]);

  const clear = useCallback(() => setLines([]), []);

  return { lines, status, ended, clear };
}
