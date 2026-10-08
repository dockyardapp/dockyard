import { beforeEach, describe, expect, it, vi } from 'vitest';
import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { ReactNode } from 'react';
import { ContainersPage } from './ContainersPage';
import { ImagesPage } from './ImagesPage';
import { renderWithProviders, makeUser } from '../test/helpers';
import { ApiError, endpoints } from '../api/client';
import type { ContainerSummary, ImageSummary, PublicUser } from '../api/types';

/**
 * Page-level behaviour: the role ladder actually disables the right controls,
 * and a failed load shows an error instead of a misleading empty state. Both
 * were verified by hand once; these make them re-runnable.
 */

let mockUser: PublicUser | null = makeUser('admin');

vi.mock('../hooks/useAuth', () => ({
  useAuth: () => ({
    user: mockUser,
    loading: false,
    login: vi.fn(),
    bootstrap: vi.fn(),
    logout: vi.fn(),
    refresh: vi.fn(),
  }),
  AuthProvider: ({ children }: { children: ReactNode }) => children,
}));

vi.mock('../hooks/useEvents', () => ({
  useEvents: () => ({ status: 'open', lastEvent: null }),
  EventsProvider: ({ children }: { children: ReactNode }) => children,
}));

vi.mock('../api/client', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../api/client')>();
  return {
    ...actual,
    endpoints: {
      auth: { me: vi.fn(), login: vi.fn(), bootstrap: vi.fn(), logout: vi.fn() },
      containers: {
        list: vi.fn(),
        create: vi.fn(),
        get: vi.fn(),
        inspect: vi.fn(),
        action: vi.fn(),
        remove: vi.fn(),
        logs: vi.fn(),
        stats: vi.fn(),
        exec: vi.fn(),
      },
      images: { list: vi.fn(), pull: vi.fn(), remove: vi.fn() },
      networks: { list: vi.fn(), create: vi.fn(), remove: vi.fn() },
      volumes: { list: vi.fn(), create: vi.fn(), remove: vi.fn() },
      templates: {
        list: vi.fn(),
        get: vi.fn(),
        create: vi.fn(),
        update: vi.fn(),
        remove: vi.fn(),
        deploy: vi.fn(),
      },
      stacks: { list: vi.fn(), get: vi.fn(), action: vi.fn(), remove: vi.fn() },
      tunnels: { list: vi.fn(), get: vi.fn(), create: vi.fn(), action: vi.fn(), remove: vi.fn() },
      system: { health: vi.fn(), info: vi.fn() },
      audit: { list: vi.fn() },
      settings: { get: vi.fn(), patch: vi.fn() },
      users: { list: vi.fn(), create: vi.fn(), update: vi.fn(), remove: vi.fn() },
      cloudflare: { status: vi.fn(), setCredentials: vi.fn(), clearCredentials: vi.fn() },
    },
  };
});

const container: ContainerSummary = {
  id: 'a1b2c3d4e5f60718293a4b5c6d7e8f90',
  name: 'dy-web',
  image: 'nginx:alpine',
  imageId: 'sha256:1111',
  state: 'running',
  status: 'Up 5 minutes',
  created: 1_700_000_000,
  health: null,
  ports: [{ privatePort: 80, publicPort: 8080, type: 'tcp' }],
  labels: {},
  managed: false,
  stackId: null,
  templateSlug: null,
};

const image: ImageSummary = {
  id: 'sha256:beefbeefbeefbeef',
  repoTags: ['nginx:alpine'],
  repoDigests: [],
  size: 1024,
  created: 1_700_000_000,
  containers: 2,
  dangling: false,
};

beforeEach(() => {
  mockUser = makeUser('admin');
  vi.mocked(endpoints.containers.list).mockResolvedValue([container]);
  vi.mocked(endpoints.networks.list).mockResolvedValue([]);
  vi.mocked(endpoints.images.list).mockResolvedValue([image]);
});

describe('ContainersPage role gating', () => {
  it('disables the create control for a viewer', async () => {
    mockUser = makeUser('viewer');
    renderWithProviders(<ContainersPage />);

    const run = await screen.findByRole('button', { name: 'Run container' });
    expect(run).toBeDisabled();
    expect(run).toHaveAttribute('title', 'Requires the operator role');
  });

  it('enables the create control for an operator', async () => {
    mockUser = makeUser('operator');
    renderWithProviders(<ContainersPage />);

    const run = await screen.findByRole('button', { name: 'Run container' });
    expect(run).toBeEnabled();
  });

  it('lets every role read the container list', async () => {
    mockUser = makeUser('viewer');
    renderWithProviders(<ContainersPage />);
    expect(await screen.findByText('dy-web')).toBeInTheDocument();
  });

  it('hides the create control entirely when signed out', async () => {
    mockUser = null;
    renderWithProviders(<ContainersPage />);
    const run = await screen.findByRole('button', { name: 'Run container' });
    expect(run).toBeDisabled();
  });
});

describe('ImagesPage role gating', () => {
  it('disables delete for an operator, who may write but not destroy', async () => {
    mockUser = makeUser('operator');
    renderWithProviders(<ImagesPage />);

    const del = await screen.findByRole('button', { name: /^Delete image/ });
    expect(del).toBeDisabled();
    expect(del).toHaveAttribute('title', 'Requires the admin role');
  });

  it('enables delete for an admin', async () => {
    mockUser = makeUser('admin');
    renderWithProviders(<ImagesPage />);

    const del = await screen.findByRole('button', { name: /^Delete image/ });
    expect(del).toBeEnabled();
    expect(del).toHaveAttribute('title', 'Delete image');
  });
});

describe('load failure vs empty state', () => {
  it('shows the error banner and suppresses the empty state when the load fails', async () => {
    vi.mocked(endpoints.containers.list).mockRejectedValue(
      new ApiError(500, 'internal', 'docker is unreachable'),
    );
    renderWithProviders(<ContainersPage />);

    expect(await screen.findByText('Could not load containers')).toBeInTheDocument();
    expect(screen.getByText('docker is unreachable')).toBeInTheDocument();
    // The regression: an empty-state message used to render alongside the error,
    // telling the operator there were no containers when the truth was unknown.
    expect(screen.queryByText('No containers yet')).not.toBeInTheDocument();
    expect(screen.queryByText('No containers match the filter')).not.toBeInTheDocument();
  });

  it('shows the empty state, and no banner, when the host really has none', async () => {
    vi.mocked(endpoints.containers.list).mockResolvedValue([]);
    renderWithProviders(<ContainersPage />);

    expect(await screen.findByText('No containers yet')).toBeInTheDocument();
    expect(screen.queryByText('Could not load containers')).not.toBeInTheDocument();
  });

  it('distinguishes "nothing matches the filter" from "nothing exists"', async () => {
    renderWithProviders(<ContainersPage />);
    await screen.findByText('dy-web');

    const filter = screen.getByLabelText('Filter containers');
    const user = userEvent.setup();
    await user.type(filter, 'zzz');

    expect(await screen.findByText('No containers match the filter')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Clear filters' })).toBeInTheDocument();
  });
});

describe('accessibility', () => {
  it('gives every button on the containers page an accessible name', async () => {
    mockUser = makeUser('admin');
    renderWithProviders(<ContainersPage />);
    await screen.findByText('dy-web');

    await waitFor(() => {
      const buttons = screen.getAllByRole('button');
      expect(buttons.length).toBeGreaterThan(0);
      for (const button of buttons) {
        expect(button).toHaveAccessibleName();
      }
    });
  });

  it('gives every button on the images page an accessible name', async () => {
    mockUser = makeUser('admin');
    renderWithProviders(<ImagesPage />);
    await screen.findByRole('button', { name: /^Delete image/ });

    const buttons = screen.getAllByRole('button');
    expect(buttons.length).toBeGreaterThan(0);
    for (const button of buttons) {
      expect(button).toHaveAccessibleName();
    }
  });
});
