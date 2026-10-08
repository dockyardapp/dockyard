import { beforeEach, describe, expect, it, vi } from 'vitest';
import { act, renderHook } from '@testing-library/react';
import { useLogStream } from './useLogStream';

/**
 * The log tail's terminate behaviour. A stream that reconnects after the server
 * has ended it loops forever, which is exactly what happened before the fix.
 */
const h = vi.hoisted(() => ({
  close: vi.fn(),
  path: '',
  opts: null as { onMessage: (raw: unknown) => void; onStatus?: (s: string) => void } | null,
}));

vi.mock('../lib/ws', () => ({
  connectSocket: (path: string, opts: unknown) => {
    h.path = path;
    h.opts = opts as typeof h.opts;
    return { close: h.close, status: 'open' as const };
  },
}));

beforeEach(() => {
  h.close.mockReset();
  h.path = '';
  h.opts = null;
});

describe('useLogStream', () => {
  it('opens the container log socket with the tail size', () => {
    renderHook(() => useLogStream('abc123', { tail: 50 }));
    expect(h.path).toBe('/ws/containers/abc123/logs?tail=50');
  });

  it('accumulates log lines in arrival order', () => {
    const { result } = renderHook(() => useLogStream('abc123'));

    act(() => {
      h.opts?.onMessage({ type: 'log', line: 'first' });
      h.opts?.onMessage({ type: 'log', line: 'second' });
    });

    expect(result.current.lines).toEqual(['first', 'second']);
  });

  it('ignores an unrecognised frame shape', () => {
    const { result } = renderHook(() => useLogStream('abc123'));

    act(() => {
      h.opts?.onMessage({ type: 'nonsense' });
      h.opts?.onMessage(null);
      h.opts?.onMessage({ type: 'log' });
    });

    expect(result.current.lines).toEqual([]);
  });

  it('closes the socket and records the reason when the server ends the stream', () => {
    const { result } = renderHook(() => useLogStream('abc123'));

    act(() => {
      h.opts?.onMessage({ type: 'end', reason: 'container stopped' });
    });

    // Regression: without closing here the socket reconnected and replayed the
    // same ended stream forever.
    expect(h.close).toHaveBeenCalledTimes(1);
    expect(result.current.ended).toBe('container stopped');
  });

  it('does not open a socket when disabled or paused', () => {
    renderHook(() => useLogStream('abc123', { enabled: false }));
    expect(h.path).toBe('');

    renderHook(() => useLogStream('abc123', { paused: true }));
    expect(h.path).toBe('');
  });

  it('does not open a socket without a container id', () => {
    renderHook(() => useLogStream(null));
    expect(h.path).toBe('');
  });

  it('caps the buffer so a chatty container cannot grow it without bound', () => {
    const { result } = renderHook(() => useLogStream('abc123'));

    act(() => {
      for (let i = 0; i < 5100; i += 1) h.opts?.onMessage({ type: 'log', line: `line ${i}` });
    });

    expect(result.current.lines).toHaveLength(5000);
    expect(result.current.lines[0]).toBe('line 100');
    expect(result.current.lines[4999]).toBe('line 5099');
  });

  it('clears the buffer on request', () => {
    const { result } = renderHook(() => useLogStream('abc123'));

    act(() => {
      h.opts?.onMessage({ type: 'log', line: 'only' });
    });
    expect(result.current.lines).toEqual(['only']);

    act(() => {
      result.current.clear();
    });
    expect(result.current.lines).toEqual([]);
  });
});
