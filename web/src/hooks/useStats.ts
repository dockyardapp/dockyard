import { useEffect, useRef, useState } from 'react';
import { connectSocket, type SocketStatus } from '../lib/ws';
import type { ContainerStats, StatsFrame } from '../api/types';

const MAX_HISTORY = 120;

export type StatsStream = {
  latest: ContainerStats | null;
  history: ContainerStats[];
  status: SocketStatus;
};

/**
 * Live stats over /ws/containers/:id/stats (CONTRACT.md §7). The server pushes
 * a frame every 1500 ms; we keep the last 120 samples for the sparkline.
 */
export function useStats(containerId: string | null, opts: { enabled?: boolean } = {}): StatsStream {
  const enabled = opts.enabled ?? true;
  const [latest, setLatest] = useState<ContainerStats | null>(null);
  const [history, setHistory] = useState<ContainerStats[]>([]);
  const [status, setStatus] = useState<SocketStatus>('connecting');
  const sockRef = useRef<{ close(): void } | null>(null);

  useEffect(() => {
    if (!containerId || !enabled) return;
    setHistory([]);
    setLatest(null);
    setStatus('connecting');
    const sock = connectSocket(`/ws/containers/${encodeURIComponent(containerId)}/stats`, {
      pingMs: 20000,
      onStatus: setStatus,
      onMessage: (raw) => {
        const frame = raw as StatsFrame;
        if (frame && frame.type === 'stats' && frame.stats) {
          setLatest(frame.stats);
          setHistory((prev) => {
            const next = prev.concat(frame.stats);
            return next.length > MAX_HISTORY ? next.slice(next.length - MAX_HISTORY) : next;
          });
        }
      },
    });
    sockRef.current = sock;
    return () => {
      sock.close();
      sockRef.current = null;
    };
  }, [containerId, enabled]);

  return { latest, history, status };
}
