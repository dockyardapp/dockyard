import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  formatBytes,
  formatCount,
  formatDateTime,
  formatDuration,
  formatPercent,
  formatPort,
  formatPorts,
  fromUnixSeconds,
  matchesQuery,
  parseDockerTime,
  pluralize,
  relativeTime,
  shortId,
  splitCommandLine,
  splitImageRef,
  stripDigest,
} from './format';

describe('formatBytes', () => {
  it('renders zero and the sub-KiB range without decimals', () => {
    expect(formatBytes(0)).toBe('0 B');
    expect(formatBytes(1)).toBe('1 B');
    expect(formatBytes(1023)).toBe('1023 B');
  });

  it('steps up in 1024s', () => {
    expect(formatBytes(1024)).toBe('1.0 KiB');
    expect(formatBytes(1536)).toBe('1.5 KiB');
    expect(formatBytes(1024 ** 2)).toBe('1.0 MiB');
    expect(formatBytes(1024 ** 3 * 2.5)).toBe('2.5 GiB');
  });

  it('returns a dash for values that are not a real size', () => {
    expect(formatBytes(-1)).toBe('-');
    expect(formatBytes(Number.NaN)).toBe('-');
    expect(formatBytes(Number.POSITIVE_INFINITY)).toBe('-');
  });

  it('honours the digit argument', () => {
    expect(formatBytes(1536, 2)).toBe('1.50 KiB');
  });
});

describe('formatPercent / formatCount', () => {
  it('formats a percentage and guards non-finite input', () => {
    expect(formatPercent(12.345)).toBe('12.3%');
    expect(formatPercent(Number.NaN)).toBe('-');
  });

  it('groups thousands', () => {
    expect(formatCount(1234567)).toBe('1,234,567');
    expect(formatCount(Number.NaN)).toBe('-');
  });
});

describe('shortId / stripDigest', () => {
  it('drops the sha256 prefix before truncating', () => {
    expect(shortId('sha256:abcdef0123456789')).toBe('abcdef012345');
    expect(shortId('abcdef0123456789')).toBe('abcdef012345');
  });

  it('leaves short ids intact and returns a dash for empty input', () => {
    expect(shortId('abc')).toBe('abc');
    expect(shortId('')).toBe('-');
  });

  it('strips a digest suffix but not a tag', () => {
    expect(stripDigest('nginx:1.25@sha256:deadbeef')).toBe('nginx:1.25');
    expect(stripDigest('nginx:1.25')).toBe('nginx:1.25');
  });
});

describe('Docker timestamps', () => {
  it('treats unix seconds <= 0 as absent', () => {
    expect(fromUnixSeconds(0)).toBeNull();
    expect(fromUnixSeconds(-5)).toBeNull();
    expect(fromUnixSeconds(null)).toBeNull();
    expect(fromUnixSeconds(undefined)).toBeNull();
    expect(fromUnixSeconds(1700000000)?.getTime()).toBe(1700000000000);
  });

  it('treats Go\u2019s zero time as absent rather than year 1', () => {
    expect(parseDockerTime('0001-01-01T00:00:00Z')).toBeNull();
    expect(parseDockerTime('')).toBeNull();
    expect(parseDockerTime('not a date')).toBeNull();
    expect(parseDockerTime('2026-01-01T00:00:00Z')?.getUTCFullYear()).toBe(2026);
  });
});

describe('formatDateTime', () => {
  it('renders an absolute timestamp for a real date', () => {
    expect(formatDateTime('2026-06-15T12:34:56Z')).not.toBe('-');
  });

  it('renders a dash for Go\u2019s zero time instead of year 1', () => {
    // Regression: a `?? new Date(value)` fallback used to resurrect the zero
    // time here, printing "Jan 01, 1" for a container that has not finished.
    expect(formatDateTime('0001-01-01T00:00:00Z')).toBe('-');
    expect(formatDateTime('')).toBe('-');
    expect(formatDateTime(null)).toBe('-');
    expect(formatDateTime(0)).toBe('-');
  });
});

describe('relativeTime', () => {
  const NOW = new Date('2026-06-15T12:00:00.000Z');

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
  });

  it('describes the past', () => {
    expect(relativeTime(new Date(NOW.getTime() - 30_000))).toBe('30s ago');
    expect(relativeTime(new Date(NOW.getTime() - 5 * 60_000))).toBe('5m ago');
    expect(relativeTime(new Date(NOW.getTime() - 3 * 3_600_000))).toBe('3h ago');
  });

  it('describes the future, which is what a skewed clock looks like', () => {
    expect(relativeTime(new Date(NOW.getTime() + 120_000))).toBe('in 2m');
  });

  it('returns a dash for a missing value', () => {
    expect(relativeTime(null)).toBe('-');
    expect(relativeTime(0)).toBe('-');
  });

  it('returns a dash for Go\u2019s zero time, not a negative age', () => {
    // Regression: this used to render "2027y ago" because the zero-time guard
    // in parseDockerTime was undone by the fallback that followed it.
    expect(relativeTime('0001-01-01T00:00:00Z')).toBe('-');
  });
});

describe('formatDuration', () => {
  it('always shows seconds when under a minute', () => {
    expect(formatDuration(0)).toBe('0s');
    expect(formatDuration(59)).toBe('59s');
  });

  it('shows seconds for anything under an hour, and drops them from an hour up', () => {
    expect(formatDuration(60)).toBe('1m 0s');
    expect(formatDuration(3661)).toBe('1h 1m');
    expect(formatDuration(90061)).toBe('1d 1h 1m');
  });

  it('guards negative and non-finite input', () => {
    expect(formatDuration(-1)).toBe('-');
    expect(formatDuration(Number.NaN)).toBe('-');
  });
});

describe('ports', () => {
  it('renders a published mapping with the bind address', () => {
    expect(formatPorts([{ privatePort: 80, publicPort: 8080, type: 'tcp' }])).toEqual([
      '0.0.0.0:8080->80/tcp',
    ]);
  });

  it('honours an explicit ip and falls back to the bare private port', () => {
    expect(formatPorts([{ ip: '127.0.0.1', privatePort: 5432, publicPort: 5432, type: 'tcp' }])).toEqual([
      '127.0.0.1:5432->5432/tcp',
    ]);
    expect(formatPorts([{ privatePort: 3000, type: 'tcp' }])).toEqual(['3000/tcp']);
    expect(formatPorts([])).toEqual([]);
  });

  it('formatPort only lists mapped ports', () => {
    expect(formatPort([{ privatePort: 3000, type: 'tcp' }])).toBe('-');
    expect(formatPort([{ privatePort: 80, publicPort: 8080, type: 'tcp' }])).toBe('8080->80/tcp');
  });
});

describe('splitImageRef', () => {
  it('defaults a missing tag to latest', () => {
    expect(splitImageRef('nginx')).toEqual({ repo: 'nginx', tag: 'latest' });
  });

  it('splits a plain tag', () => {
    expect(splitImageRef('nginx:1.25')).toEqual({ repo: 'nginx', tag: '1.25' });
  });

  it('does not mistake a registry port for a tag', () => {
    expect(splitImageRef('registry.local:5000/app')).toEqual({
      repo: 'registry.local:5000/app',
      tag: 'latest',
    });
    expect(splitImageRef('registry.local:5000/app:1.2')).toEqual({
      repo: 'registry.local:5000/app',
      tag: '1.2',
    });
  });

  it('ignores a digest when finding the tag', () => {
    expect(splitImageRef('postgres:16@sha256:abc123')).toEqual({ repo: 'postgres', tag: '16' });
  });
});

describe('splitCommandLine', () => {
  it('splits on whitespace', () => {
    expect(splitCommandLine('ls -la /tmp')).toEqual(['ls', '-la', '/tmp']);
  });

  it('keeps quoted segments together and strips the quotes', () => {
    expect(splitCommandLine('echo "hello world"')).toEqual(['echo', 'hello world']);
    expect(splitCommandLine("echo 'hello world'")).toEqual(['echo', 'hello world']);
  });

  it('preserves an explicitly empty argument', () => {
    expect(splitCommandLine('echo ""')).toEqual(['echo', '']);
  });

  it('collapses runs of whitespace and trims', () => {
    expect(splitCommandLine('   a    b  ')).toEqual(['a', 'b']);
    expect(splitCommandLine('')).toEqual([]);
  });
});

describe('pluralize', () => {
  it('uses the singular for exactly one', () => {
    expect(pluralize(1, 'container')).toBe('1 container');
    expect(pluralize(0, 'container')).toBe('0 containers');
    expect(pluralize(2, 'container')).toBe('2 containers');
  });

  it('accepts an irregular plural', () => {
    expect(pluralize(2, 'entry', 'entries')).toBe('2 entries');
  });
});

describe('matchesQuery', () => {
  it('matches everything when the query is blank', () => {
    expect(matchesQuery('', 'anything')).toBe(true);
    expect(matchesQuery('   ', 'anything')).toBe(true);
  });

  it('is case-insensitive and searches every value', () => {
    expect(matchesQuery('NGINX', 'nginx:alpine', 'web')).toBe(true);
    expect(matchesQuery('web', 'nginx:alpine', 'web')).toBe(true);
    expect(matchesQuery('redis', 'nginx:alpine', 'web')).toBe(false);
  });

  it('tolerates null values in the record', () => {
    expect(matchesQuery('x', null, undefined, 'axb')).toBe(true);
    expect(matchesQuery('x', null, undefined)).toBe(false);
  });
});
