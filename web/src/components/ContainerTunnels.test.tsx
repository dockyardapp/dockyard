import { beforeEach, describe, expect, it, vi } from 'vitest';
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { ReactNode } from 'react';
import { ContainerTunnels } from './ContainerTunnels';
import { renderWithProviders } from '../test/helpers';
import { endpoints } from '../api/client';
import type { Tunnel } from '../api/types';

/**
 * Routing lives on the container now.
 *
 * A tunnel exists to reach one container port, so the container is where the decision belongs. This
 * used to be a page of its own, with a container dropdown on it: the operator picked the thing they
 * had already been looking at from a list on a screen that had nothing else to do with it.
 *
 * The tests pin the three things that make the move worth anything: the container's own ports are
 * what you can expose, only this container's tunnels are listed, and the drawer arrives already
 * knowing which container and which port it is for.
 */

vi.mock('../hooks/useEvents', () => ({
  useEvents: () => ({ status: 'open', lastEvent: null }),
  EventsProvider: ({ children }: { children: ReactNode }) => children,
}));

vi.mock('../api/client', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../api/client')>();
  return {
    ...actual,
    endpoints: {
      ...actual.endpoints,
      tunnels: { list: vi.fn(), get: vi.fn(), create: vi.fn(), action: vi.fn(), remove: vi.fn() },
      cloudflare: { status: vi.fn(), setCredentials: vi.fn(), clearCredentials: vi.fn() },
    },
  };
});

const PORTS = [{ privatePort: 80, publicPort: 8080, type: 'tcp' }];

const tunnel = (over: Partial<Tunnel> = {}): Tunnel => ({
  id: 't1',
  name: 'dy-web-8080',
  mode: 'quick',
  target_url: 'http://127.0.0.1:8080',
  container_id: 'abc123',
  container_name: 'dy-web',
  port: 8080,
  hostname: null,
  tunnel_id: null,
  status: 'running',
  url: 'https://one.trycloudflare.com',
  pid: 4242,
  last_error: null,
  auto_start: false,
  created_at: '2026-01-01T00:00:00.000Z',
  updated_at: '2026-01-01T00:00:00.000Z',
  ...over,
});

function render(over: Partial<Parameters<typeof ContainerTunnels>[0]> = {}) {
  return renderWithProviders(
    <ContainerTunnels
      containerId="abc123"
      containerName="dy-web"
      ports={PORTS}
      canWrite
      canDestroy
      isAdmin={false}
      {...over}
    />,
  );
}

beforeEach(() => {
  vi.mocked(endpoints.tunnels.list).mockResolvedValue([]);
  vi.mocked(endpoints.cloudflare.status).mockResolvedValue({
    configured: false,
    verified: false,
    accountId: null,
    accounts: [],
    zones: [],
  });
});

describe('ContainerTunnels', () => {
  it('offers the container its own published ports', async () => {
    render();

    await waitFor(() => expect(screen.getByText('Published ports (1)')).not.toBeNull());
    expect(screen.getByText('8080')).not.toBeNull();
    expect(screen.getByText('80')).not.toBeNull();
    expect(screen.getByRole('button', { name: 'Expose' })).not.toBeNull();
  });

  it('lists only the tunnels belonging to this container', async () => {
    vi.mocked(endpoints.tunnels.list).mockResolvedValue([
      tunnel(),
      tunnel({ id: 't2', name: 'someone-elses', container_id: 'other' }),
    ]);

    render();

    await waitFor(() => expect(screen.getByText('Tunnels (1)')).not.toBeNull());
    expect(screen.getByText('dy-web-8080')).not.toBeNull();
    expect(screen.queryByText('someone-elses')).toBeNull();
  });

  it('opens the drawer already knowing the container and the port', async () => {
    const user = userEvent.setup();
    render();

    await user.click(await screen.findByRole('button', { name: 'Expose' }));

    const dialog = await screen.findByRole('dialog');
    // The name is derived from both, so the operator only has to choose a mode. The label carries a
    // `required` marker inside it, so match on the start of it rather than the whole string.
    expect(within(dialog).getByLabelText(/^Name/)).toHaveValue('dy-web-8080');
    expect(within(dialog).getByLabelText('Published port')).toHaveValue('8080');
    // And the container is the one they were looking at, not a dropdown to pick from.
    expect(within(dialog).getByText('dy-web')).not.toBeNull();
  });

  it('says so plainly when the container publishes nothing', async () => {
    render({ ports: [{ privatePort: 80, type: 'tcp' }] });

    await waitFor(() => expect(screen.getByText('Published ports (0)')).not.toBeNull());
    expect(screen.getByText(/publishes no port/i)).not.toBeNull();
    // There is still a way in, because a raw URL needs no published port.
    expect(screen.getByRole('button', { name: 'Expose a port' })).not.toBeNull();
  });
});
