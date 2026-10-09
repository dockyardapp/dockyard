import { beforeEach, describe, expect, it, vi } from 'vitest';
import { screen, within } from '@testing-library/react';

import type { UpdateStatus } from '../api/types';
import { renderWithProviders } from '../test/helpers';
import { UpdateCard } from './UpdateCard';
import { VersionBadge } from './VersionBadge';

const updateMock = vi.fn();
const startMock = vi.fn();

vi.mock('../api/client', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../api/client')>();
  return {
    ...actual,
    endpoints: {
      system: {
        update: (...args: unknown[]) => updateMock(...args),
        startUpdate: (...args: unknown[]) => startMock(...args),
      },
    },
  };
});

const SHA = 'a'.repeat(40);
const NEW_SHA = 'b'.repeat(40);

function fixture(over: Partial<UpdateStatus> = {}): UpdateStatus {
  const base: UpdateStatus = {
    build: {
      version: '0.2.0',
      commit: SHA,
      commitShort: SHA.slice(0, 7),
      builtAt: '2026-10-09T06:00:00.000Z',
      pinned: true,
    },
    check: {
      checkedAt: new Date().toISOString(),
      repo: 'EliasL-git/dockyard',
      branch: 'main',
      authenticated: false,
      status: 'current',
      behindBy: 0,
      aheadBy: 0,
      latest: {
        version: '0.2.0',
        commit: SHA,
        commitShort: SHA.slice(0, 7),
        subject: 'the tip',
        author: 'elias',
        date: '2026-10-09T06:00:00.000Z',
        url: `https://github.com/EliasL-git/dockyard/commit/${SHA}`,
      },
      commits: [],
      rateLimit: { remaining: 59, limit: 60, resetAt: null },
      error: null,
    },
    job: null,
    updater: {
      installed: true,
      installedAt: '2026-10-09T06:00:00.000Z',
      spoolDir: '/app/data/update',
      enabled: true,
    },
    canUpdate: true,
  };
  return { ...base, ...over };
}

beforeEach(() => {
  updateMock.mockReset();
  startMock.mockReset();
});

describe('UpdateCard', () => {
  it('names the running build and the commit it was built from', async () => {
    updateMock.mockResolvedValue(fixture());
    renderWithProviders(<UpdateCard />);

    // Scope to the Running row: the Upstream row also names a version and a commit.
    const running = await screen.findByText('Running');
    const row = running.nextElementSibling as HTMLElement;
    expect(row).toHaveTextContent('v0.2.0 · aaaaaaa');
    expect(within(row).getByRole('link', { name: 'aaaaaaa' })).toHaveAttribute(
      'href',
      `https://github.com/EliasL-git/dockyard/commit/${SHA}`,
    );
    expect(screen.getByText('EliasL-git/dockyard')).toBeInTheDocument();
  });

  it('says so plainly when the build is the tip of the branch', async () => {
    updateMock.mockResolvedValue(fixture());
    renderWithProviders(<UpdateCard />);

    expect(await screen.findByText(/This build is the tip of main\./)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Install update/ })).toBeDisabled();
  });

  it('lists what an update would bring in, and offers the button', async () => {
    updateMock.mockResolvedValue(
      fixture({
        check: {
          ...fixture().check,
          status: 'behind',
          behindBy: 2,
          commits: [
            {
              sha: NEW_SHA,
              commitShort: NEW_SHA.slice(0, 7),
              subject: 'tunnels: add a third exposure mode',
              author: 'elias',
              date: '2026-10-09T07:00:00.000Z',
              url: `https://github.com/EliasL-git/dockyard/commit/${NEW_SHA}`,
            },
            {
              sha: 'c'.repeat(40),
              commitShort: 'ccccccc',
              subject: 'ui: stop tables clipping their columns',
              author: 'elias',
              date: '2026-10-09T06:30:00.000Z',
              url: 'https://github.com/EliasL-git/dockyard/commit/ccccccc',
            },
          ],
        },
      }),
    );
    renderWithProviders(<UpdateCard />);

    expect(await screen.findByText('2 commits behind')).toBeInTheDocument();
    expect(screen.getByText('tunnels: add a third exposure mode')).toBeInTheDocument();
    expect(screen.getByText('ui: stop tables clipping their columns')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Install update/ })).toBeEnabled();
  });

  it('refuses to offer a button nothing would collect', async () => {
    // The whole point: a request with no updater on the host would silently do nothing.
    updateMock.mockResolvedValue(
      fixture({
        check: { ...fixture().check, status: 'behind', behindBy: 1 },
        updater: { installed: false, installedAt: null, spoolDir: '/app/data/update', enabled: true },
      }),
    );
    renderWithProviders(<UpdateCard />);

    expect(await screen.findByRole('button', { name: /Install update/ })).toBeDisabled();
    expect(screen.getByText(/deploy\/install-updater\.sh/)).toBeInTheDocument();
    // The reason has to be on the card, not only in the button's tooltip.
    expect(screen.getByText(/^An update is ready, but no updater is installed/)).toBeInTheDocument();
  });

  it('keeps the button from a viewer and an operator', async () => {
    updateMock.mockResolvedValue(
      fixture({
        check: { ...fixture().check, status: 'behind', behindBy: 1 },
        canUpdate: false,
      }),
    );
    renderWithProviders(<UpdateCard />);

    expect(await screen.findByText('1 commit behind')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Install update/ })).not.toBeInTheDocument();
  });

  it('explains an unpinned build rather than claiming it is current', async () => {
    updateMock.mockResolvedValue(
      fixture({
        build: { version: '0.2.0', commit: '', commitShort: '', builtAt: null, pinned: false },
        check: { ...fixture().check, status: 'unknown' },
      }),
    );
    renderWithProviders(<UpdateCard />);

    expect(await screen.findByText(/carries no commit stamp/)).toBeInTheDocument();
  });

  it('surfaces an upstream failure without hiding the running version', async () => {
    updateMock.mockResolvedValue(
      fixture({
        check: {
          ...fixture().check,
          status: 'unknown',
          error: 'could not reach GitHub: fetch failed',
        },
      }),
    );
    renderWithProviders(<UpdateCard />);

    expect(await screen.findByText('Could not check for updates')).toBeInTheDocument();
    // The version still has to render: it is the reason the operator opened the page.
    expect(screen.getByText('Running').nextElementSibling).toHaveTextContent('v0.2.0');
  });

  it('reports a finished update', async () => {
    updateMock.mockResolvedValue(
      fixture({
        job: {
          id: 'job-1',
          state: 'success',
          step: 'done',
          message: 'Updated to 0.2.1.',
          requestedAt: '2026-10-09T07:00:00.000Z',
          requestedBy: 'admin@dockyard.local',
          startedAt: '2026-10-09T07:00:01.000Z',
          finishedAt: '2026-10-09T07:04:00.000Z',
          from: { version: '0.2.0', commit: SHA },
          to: { version: '0.2.1', commit: NEW_SHA },
          log: 'building the panel image',
        },
      }),
    );
    renderWithProviders(<UpdateCard />);

    expect(await screen.findByText('Update finished')).toBeInTheDocument();
    expect(screen.getByText(/Updated to 0\.2\.1\./)).toBeInTheDocument();
    expect(screen.getByText(/Requested by admin@dockyard\.local\./)).toBeInTheDocument();
  });
});

describe('VersionBadge', () => {
  it('shows the version and the short commit', async () => {
    updateMock.mockResolvedValue(fixture());
    renderWithProviders(<VersionBadge />);

    const badge = await screen.findByRole('link', { name: /Version 0\.2\.0/ });
    expect(badge).toHaveTextContent('v0.2.0 · aaaaaaa');
    expect(badge).not.toHaveClass('has-update');
  });

  it('marks itself when there is an update to install', async () => {
    updateMock.mockResolvedValue(
      fixture({ check: { ...fixture().check, status: 'behind', behindBy: 3 } }),
    );
    renderWithProviders(<VersionBadge />);

    const badge = await screen.findByRole('link', { name: /3 updates available/ });
    expect(badge).toHaveClass('has-update');
  });

  it('renders nothing until the payload arrives', () => {
    updateMock.mockReturnValue(new Promise(() => {}));
    const { container } = renderWithProviders(<VersionBadge />);
    expect(container).toBeEmptyDOMElement();
  });
});
