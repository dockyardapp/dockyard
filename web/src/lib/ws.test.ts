import { beforeEach, describe, expect, it, vi } from 'vitest';
import { connectSocket } from './ws';
import type { SocketStatus } from './ws';

/**
 * The reconnect loop is the part of the console that is hardest to observe by
 * hand (it only misbehaves when a socket dies), so it is pinned here against a
 * scripted fake socket: backoff growth, the cap, the reset after a good open,
 * and the one close code that must stop the loop for good.
 */
class FakeSocket {
  static instances: FakeSocket[] = [];
  static OPEN = 1;
  static CLOSED = 3;

  url: string;
  readyState = 0;
  sent: string[] = [];
  onopen: (() => void) | null = null;
  onmessage: ((ev: { data: unknown }) => void) | null = null;
  onerror: (() => void) | null = null;
  onclose: ((ev: { code: number }) => void) | null = null;

  constructor(url: string) {
    this.url = url;
    FakeSocket.instances.push(this);
  }

  send(data: string): void {
    this.sent.push(data);
  }

  close(): void {
    this.readyState = FakeSocket.CLOSED;
  }

  // --- scripted server side ---
  fireOpen(): void {
    this.readyState = FakeSocket.OPEN;
    this.onopen?.();
  }
  fireFrame(payload: unknown): void {
    this.onmessage?.({ data: JSON.stringify(payload) });
  }
  fireRaw(data: unknown): void {
    this.onmessage?.({ data });
  }
  fireServerClose(code: number): void {
    this.readyState = FakeSocket.CLOSED;
    this.onclose?.({ code });
  }
}

const latest = (): FakeSocket => FakeSocket.instances[FakeSocket.instances.length - 1];

const onMessage = vi.fn<(data: unknown) => void>();
const onStatus = vi.fn<(status: SocketStatus) => void>();

beforeEach(() => {
  FakeSocket.instances = [];
  vi.stubGlobal('WebSocket', FakeSocket);
  // Kill the jitter so the backoff delays are exact.
  vi.spyOn(Math, 'random').mockReturnValue(0.5);
  vi.useFakeTimers();
  onMessage.mockReset();
  onStatus.mockReset();
});

describe('connectSocket', () => {
  it('opens a socket on the current host using the ws scheme', () => {
    connectSocket('/ws/events', { onMessage });
    expect(FakeSocket.instances).toHaveLength(1);
    expect(latest().url).toBe('ws://localhost:3000/ws/events');
  });

  it('reports open and forwards a parsed JSON frame', () => {
    connectSocket('/ws/events', { onMessage, onStatus });
    latest().fireOpen();
    expect(onStatus).toHaveBeenCalledWith('open');

    const frame = { type: 'container', action: 'start', data: { id: 'abc' } };
    latest().fireFrame(frame);
    expect(onMessage).toHaveBeenCalledWith(frame);
  });

  it('drops a frame that is not JSON or not text instead of throwing', () => {
    connectSocket('/ws/events', { onMessage });
    latest().fireOpen();

    expect(() => latest().fireRaw('not json at all')).not.toThrow();
    expect(() => latest().fireRaw(new ArrayBuffer(4))).not.toThrow();
    expect(onMessage).not.toHaveBeenCalled();
  });

  it('reconnects after an unexpected close', () => {
    connectSocket('/ws/events', { onMessage, onStatus });
    latest().fireOpen();
    latest().fireServerClose(1006);

    expect(onStatus).toHaveBeenCalledWith('connecting');
    expect(FakeSocket.instances).toHaveLength(1);

    vi.advanceTimersByTime(500);
    expect(FakeSocket.instances).toHaveLength(2);
  });

  it('grows the delay on each successive failure', () => {
    connectSocket('/ws/events', { onMessage });
    latest().fireServerClose(1006);

    // attempt 0 -> 500ms
    vi.advanceTimersByTime(500);
    expect(FakeSocket.instances).toHaveLength(2);

    // attempt 1 -> 900ms
    latest().fireServerClose(1006);
    vi.advanceTimersByTime(899);
    expect(FakeSocket.instances).toHaveLength(2);
    vi.advanceTimersByTime(1);
    expect(FakeSocket.instances).toHaveLength(3);
  });

  it('never waits longer than maxDelay', () => {
    connectSocket('/ws/events', { onMessage, baseDelay: 500, maxDelay: 1000 });

    latest().fireServerClose(1006); // -> 500
    vi.advanceTimersByTime(500);
    latest().fireServerClose(1006); // -> 900
    vi.advanceTimersByTime(900);
    latest().fireServerClose(1006); // -> capped at 1000
    vi.advanceTimersByTime(999);
    expect(FakeSocket.instances).toHaveLength(3);
    vi.advanceTimersByTime(1);
    expect(FakeSocket.instances).toHaveLength(4);
  });

  it('resets the backoff after a successful open', () => {
    connectSocket('/ws/events', { onMessage });
    latest().fireServerClose(1006);
    vi.advanceTimersByTime(500);

    latest().fireOpen(); // a good connection clears the attempt counter
    latest().fireServerClose(1006);

    vi.advanceTimersByTime(499);
    expect(FakeSocket.instances).toHaveLength(2);
    vi.advanceTimersByTime(1);
    expect(FakeSocket.instances).toHaveLength(3);
  });

  it('stops for good on close code 4401 instead of looping', () => {
    const sock = connectSocket('/ws/events', { onMessage, onStatus });
    latest().fireServerClose(4401);

    expect(onStatus).toHaveBeenCalledWith('unauthorized');
    expect(sock.status).toBe('unauthorized');

    vi.advanceTimersByTime(60_000);
    expect(FakeSocket.instances).toHaveLength(1);
  });

  it('stops reconnecting once close() is called', () => {
    const sock = connectSocket('/ws/events', { onMessage, onStatus });
    latest().fireOpen();
    sock.close();

    expect(sock.status).toBe('closed');
    vi.advanceTimersByTime(60_000);
    expect(FakeSocket.instances).toHaveLength(1);
  });

  it('sends a keepalive while open and stops once the socket dies', () => {
    connectSocket('/ws/events', { onMessage, pingMs: 1000 });
    const sock = latest();
    sock.fireOpen();

    vi.advanceTimersByTime(1000);
    expect(sock.sent).toEqual([JSON.stringify({ type: 'ping' })]);

    vi.advanceTimersByTime(2000);
    expect(sock.sent).toHaveLength(3);

    // The socket died; the ping interval must not keep firing at a dead socket.
    // Assert on THIS socket, not on whatever the reconnect loop opened next.
    sock.fireServerClose(1006);
    vi.advanceTimersByTime(5000);
    expect(sock.sent).toHaveLength(3);
  });

  it('does not ping when the interval is disabled', () => {
    connectSocket('/ws/events', { onMessage });
    latest().fireOpen();
    vi.advanceTimersByTime(60_000);
    expect(latest().sent).toEqual([]);
  });
});
