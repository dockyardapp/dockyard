import { useEffect, useRef, useState } from 'react';
import { useLogStream } from '../hooks/useLogStream';
import { Button, EmptyState, Pill } from './ui';
import type { SocketStatus } from '../lib/ws';

const TAILS = [100, 200, 500, 1000, 2000, 5000];

const STATUS_LABEL: Record<SocketStatus, string> = {
  connecting: 'connecting',
  open: 'live',
  error: 'error',
  closed: 'closed',
  unauthorized: 'signed out',
};

const STATUS_TONE: Record<SocketStatus, string> = {
  connecting: 'starting',
  open: 'running',
  error: 'error',
  closed: 'stopped',
  unauthorized: 'error',
};

/**
 * Live log tail. Owns the WebSocket lifecycle: tail size, pause/resume,
 * autoscroll and a manual reconnect.
 */
export function LogViewer({ containerId }: { containerId: string }) {
  const [tail, setTail] = useState(200);
  const [paused, setPaused] = useState(false);
  const [autoscroll, setAutoscroll] = useState(true);
  const [nonce, setNonce] = useState(0);
  const viewRef = useRef<HTMLDivElement>(null);

  const { lines, status, ended, clear } = useLogStream(containerId, { tail, paused, nonce });

  useEffect(() => {
    if (!autoscroll) return;
    const el = viewRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [lines, autoscroll]);

  const showWaiting = lines.length === 0 && !paused && !ended && status !== 'error' && status !== 'unauthorized';

  return (
    <div className="card">
      <div className="log-toolbar">
        <Pill state={STATUS_TONE[status]}>{STATUS_LABEL[status]}</Pill>
        <span className="dim" style={{ fontSize: 'var(--fs-micro)' }}>{lines.length} lines</span>
        <div className="spacer" style={{ flex: 1 }} />
        <label className="row" style={{ gap: 'var(--space-1)' }}>
          <span className="dim" style={{ fontSize: 'var(--fs-micro)' }}>tail</span>
          <select
            value={tail}
            onChange={(e) => setTail(Number(e.target.value))}
            aria-label="Tail size"
            style={{ width: 'auto', minHeight: 26, padding: '2px 26px 2px 8px' }}
          >
            {TAILS.map((t) => (
              <option key={t} value={t}>
                {t}
              </option>
            ))}
          </select>
        </label>
        <label className="checkbox" style={{ fontSize: 'var(--fs-micro)' }}>
          <input type="checkbox" checked={autoscroll} onChange={(e) => setAutoscroll(e.target.checked)} />
          autoscroll
        </label>
        <Button size="sm" icon={paused ? 'play' : 'pause'} onClick={() => setPaused((p) => !p)}>
          {paused ? 'Resume' : 'Pause'}
        </Button>
        <Button size="sm" icon="refresh" onClick={() => setNonce((n) => n + 1)}>
          Reconnect
        </Button>
        <Button size="sm" icon="trash" onClick={clear}>
          Clear
        </Button>
      </div>

      {ended && !paused ? (
        <div className="banner banner-warn" style={{ margin: 'var(--space-3)' }} role="status">
          <div className="banner-body">
            Stream ended: <code>{ended}</code>
          </div>
        </div>
      ) : null}

      {status === 'unauthorized' ? (
        <div style={{ padding: 'var(--space-4)' }}>
          <EmptyState icon="warning" title="Session expired">
            The log socket was rejected. Sign in again to resume streaming.
          </EmptyState>
        </div>
      ) : (
        <div ref={viewRef} className="log-view" aria-live="off" aria-label="Container logs">
          {showWaiting ? <span className="dim">Waiting for output.</span> : null}
          {paused && lines.length === 0 ? <span className="dim">Stream paused.</span> : null}
          {lines.map((line, i) => (
            <span className="log-line" key={i}>
              {line.replace(/\n$/, '')}
            </span>
          ))}
        </div>
      )}
    </div>
  );
}
