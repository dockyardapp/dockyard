import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ApiError, api, endpoints, errorMessage, setUnauthorizedHandler } from './client';

/** Build the slice of Response that the client actually reads. */
function fakeResponse(status: number, body = ''): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    text: async () => body,
  } as unknown as Response;
}

const mockFetch = vi.fn();

beforeEach(() => {
  mockFetch.mockReset();
  vi.stubGlobal('fetch', mockFetch);
  setUnauthorizedHandler(null);
});

describe('a session that expires mid-use', () => {
  const unauthorized = () => fakeResponse(401, '{"error":{"code":"unauthorized","message":"Sign in first."}}');

  it('tells the app when a normal request comes back 401', async () => {
    const onUnauthorized = vi.fn();
    setUnauthorizedHandler(onUnauthorized);
    mockFetch.mockResolvedValue(unauthorized());

    await expect(endpoints.containers.list()).rejects.toThrow(ApiError);
    expect(onUnauthorized).toHaveBeenCalledTimes(1);
  });

  it('stays quiet when the sign-in request itself is rejected', async () => {
    const onUnauthorized = vi.fn();
    setUnauthorizedHandler(onUnauthorized);
    mockFetch.mockResolvedValue(unauthorized());

    await expect(endpoints.auth.login('someone@dockyard.local', 'wrong')).rejects.toThrow(ApiError);
    await expect(endpoints.auth.bootstrap('someone@dockyard.local', 'wrong')).rejects.toThrow(ApiError);
    expect(onUnauthorized).not.toHaveBeenCalled();
  });

  it('does not fire for other error statuses', async () => {
    const onUnauthorized = vi.fn();
    setUnauthorizedHandler(onUnauthorized);
    mockFetch.mockResolvedValue(fakeResponse(500, '{"error":{"code":"internal","message":"boom"}}'));

    await expect(endpoints.containers.list()).rejects.toThrow(ApiError);
    expect(onUnauthorized).not.toHaveBeenCalled();
  });

  it('is a no-op when nothing has registered a handler', async () => {
    mockFetch.mockResolvedValue(unauthorized());
    await expect(endpoints.containers.list()).rejects.toThrow(ApiError);
  });
});

function lastInit(): RequestInit {
  const call = mockFetch.mock.calls[mockFetch.mock.calls.length - 1];
  return call[1] as RequestInit;
}
function lastUrl(): string {
  const call = mockFetch.mock.calls[mockFetch.mock.calls.length - 1];
  return call[0] as string;
}

describe('request', () => {
  it('always sends the session cookie', async () => {
    mockFetch.mockResolvedValue(fakeResponse(200, '{"ok":true}'));
    await api.get('/api/system/health');
    expect(lastInit().credentials).toBe('include');
  });

  it('skips empty query values but keeps a zero', async () => {
    mockFetch.mockResolvedValue(fakeResponse(200, '[]'));
    await api.get('/api/audit', { limit: 100, offset: 0, action: undefined, q: '' });
    expect(lastUrl()).toBe('/api/audit?limit=100&offset=0');
  });

  it('omits the query string entirely when there is nothing to send', async () => {
    mockFetch.mockResolvedValue(fakeResponse(200, '[]'));
    await api.get('/api/audit', { action: undefined });
    expect(lastUrl()).toBe('/api/audit');
  });

  it('encodes query values', async () => {
    mockFetch.mockResolvedValue(fakeResponse(200, '[]'));
    await api.get('/api/containers', { q: 'a b&c' });
    expect(lastUrl()).toBe('/api/containers?q=a%20b%26c');
  });

  it('sends a JSON body and content type when there is one', async () => {
    mockFetch.mockResolvedValue(fakeResponse(200, '{}'));
    await api.post('/api/containers', { name: 'web' });
    const init = lastInit();
    expect(init.method).toBe('POST');
    expect(init.body).toBe('{"name":"web"}');
    expect((init.headers as Record<string, string>)['Content-Type']).toBe('application/json');
  });

  it('returns undefined for 204 and for an empty body', async () => {
    mockFetch.mockResolvedValue(fakeResponse(204));
    await expect(api.del('/api/images/abc')).resolves.toBeUndefined();

    mockFetch.mockResolvedValue(fakeResponse(200, ''));
    await expect(api.get('/api/images')).resolves.toBeUndefined();
  });

  it('returns raw text when text mode is requested', async () => {
    mockFetch.mockResolvedValue(fakeResponse(200, 'line one\nline two'));
    await expect(api.getText('/api/containers/abc/logs')).resolves.toBe('line one\nline two');
  });
});

describe('error handling', () => {
  it('unwraps the contract error envelope', async () => {
    mockFetch.mockResolvedValue(
      fakeResponse(
        409,
        JSON.stringify({
          error: {
            code: 'conflict',
            message: 'a user with that email already exists',
            details: { field: 'email' },
          },
        }),
      ),
    );

    const err = await api.post('/api/users', {}).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ApiError);
    const apiErr = err as ApiError;
    expect(apiErr.status).toBe(409);
    expect(apiErr.code).toBe('conflict');
    expect(apiErr.message).toBe('a user with that email already exists');
    expect(apiErr.details).toEqual({ field: 'email' });
  });

  it('falls back to the raw body when there is no envelope', async () => {
    mockFetch.mockResolvedValue(fakeResponse(502, 'upstream exploded'));
    const err = (await api.get('/api/images').catch((e: unknown) => e)) as ApiError;
    expect(err.code).toBe('internal');
    expect(err.message).toBe('upstream exploded');
  });

  it('truncates an oversized non-envelope body', async () => {
    mockFetch.mockResolvedValue(fakeResponse(500, 'x'.repeat(900)));
    const err = (await api.get('/api/images').catch((e: unknown) => e)) as ApiError;
    expect(err.message).toHaveLength(300);
  });

  it('reports a transport failure as a network error rather than throwing raw', async () => {
    mockFetch.mockRejectedValue(new TypeError('Failed to fetch'));
    const err = (await api.get('/api/system/info').catch((e: unknown) => e)) as ApiError;
    expect(err).toBeInstanceOf(ApiError);
    expect(err.status).toBe(0);
    expect(err.code).toBe('network_error');
  });

  it('lets an abort through untouched so callers can ignore it', async () => {
    mockFetch.mockRejectedValue(new DOMException('aborted', 'AbortError'));
    const err = (await api.get('/api/images').catch((e: unknown) => e)) as Error;
    expect(err).not.toBeInstanceOf(ApiError);
    expect(err.name).toBe('AbortError');
  });
});

describe('endpoint bindings', () => {
  it('builds the audit URL from its options', async () => {
    mockFetch.mockResolvedValue(fakeResponse(200, '[]'));
    await endpoints.audit.list({ limit: 50, offset: 100, action: 'container.remove' });
    expect(lastUrl()).toBe('/api/audit?limit=50&offset=100&action=container.remove');
  });

  it('encodes a container id in the path', async () => {
    mockFetch.mockResolvedValue(fakeResponse(200, '{}'));
    await endpoints.containers.get('abc/def');
    expect(lastUrl()).toBe('/api/containers/abc%2Fdef');
  });

  it('maps a container action onto a POST', async () => {
    mockFetch.mockResolvedValue(fakeResponse(200, '{}'));
    await endpoints.containers.action('abc', 'restart');
    expect(lastUrl()).toBe('/api/containers/abc/restart');
    expect(lastInit().method).toBe('POST');
  });

  it('sends force and volumes flags only when asked', async () => {
    mockFetch.mockResolvedValue(fakeResponse(200, '{"ok":true}'));
    await endpoints.containers.remove('abc');
    expect(lastUrl()).toBe('/api/containers/abc');

    await endpoints.containers.remove('abc', { force: true, volumes: true });
    expect(lastUrl()).toBe('/api/containers/abc?force=1&volumes=1');
  });
});

describe('errorMessage', () => {
  it('prefers the API message', () => {
    expect(errorMessage(new ApiError(404, 'not_found', 'container not found'))).toBe('container not found');
  });

  it('falls back to any Error and then to a string', () => {
    expect(errorMessage(new Error('boom'))).toBe('boom');
    expect(errorMessage('plain string')).toBe('plain string');
  });
});
