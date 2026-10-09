import { beforeEach, describe, expect, it, vi } from 'vitest';
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { ReactNode } from 'react';
import { TemplatesPage } from './TemplatesPage';
import { renderWithProviders, makeUser } from '../test/helpers';
import { endpoints } from '../api/client';
import type { ContainerSummary, PublicUser, Template } from '../api/types';

/**
 * The deploy form's port field.
 *
 * A template declares the port *inside* the container. What the user chooses is the port on the
 * host, because that is what they reach the container on and what a tunnel forwards to, and it is
 * the only part of the mapping that has to be free. The field used to be labelled with the
 * service name ("Web UI"), which reads as a heading rather than a control, and the container port
 * was not visible on the form at all: the only place the mapping appeared was the rendered summary
 * below it. These tests pin the label, the visible mapping, and the clash warning.
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
      containers: { list: vi.fn(), create: vi.fn(), get: vi.fn(), inspect: vi.fn(), action: vi.fn(), remove: vi.fn(), logs: vi.fn(), stats: vi.fn(), exec: vi.fn() },
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
        files: vi.fn(),
        reloadFiles: vi.fn(),
        pullRemote: vi.fn(),
      },
      stacks: { list: vi.fn(), get: vi.fn(), action: vi.fn(), remove: vi.fn() },
      tunnels: { list: vi.fn(), get: vi.fn(), create: vi.fn(), action: vi.fn(), remove: vi.fn() },
      system: { health: vi.fn(), info: vi.fn() },
      audit: { list: vi.fn() },
      settings: { get: vi.fn(), patch: vi.fn() },
      users: { list: vi.fn(), create: vi.fn(), update: vi.fn(), remove: vi.fn(), grants: vi.fn(), addGrant: vi.fn(), clearGrants: vi.fn(), removeGrant: vi.fn() },
      cloudflare: { status: vi.fn(), setCredentials: vi.fn(), clearCredentials: vi.fn() },
    },
  };
});

/** A template shaped like the Uptime Kuma one the repository ships: one port, with a default host port. */
const template: Template = {
  id: 'tpl-1',
  slug: 'uptime-kuma',
  name: 'Uptime Kuma',
  category: 'monitoring',
  icon: '📈',
  description: 'Self-hosted uptime monitoring.',
  source: 'remote',
  spec: {
    schemaVersion: 1,
    slug: 'uptime-kuma',
    name: 'Uptime Kuma',
    category: 'monitoring',
    icon: '📈',
    description: 'Self-hosted uptime monitoring.',
    image: 'louislam/uptime-kuma',
    tag: '1.23.16',
    ports: [{ container: 3001, label: 'Web UI', defaultHost: 3001 }],
    env: [],
    volumes: [{ container: '/app/data', label: 'Data', named: true }],
    restartPolicy: 'unless-stopped',
  },
  created_at: '2026-01-01T00:00:00.000Z',
  updated_at: '2026-01-01T00:00:00.000Z',
};

function container(overrides: Partial<ContainerSummary> = {}): ContainerSummary {
  return {
    id: 'c1',
    name: 'dy-existing',
    image: 'nginx:alpine',
    imageId: 'sha256:1111',
    state: 'running',
    status: 'Up 5 minutes',
    created: 1_700_000_000,
    health: null,
    ports: [{ privatePort: 3001, publicPort: 3001, type: 'tcp' }],
    labels: {},
    managed: true,
    stackId: null,
    templateSlug: null,
    ...overrides,
  };
}

const filesStatus = {
  dir: '/tmp/templates',
  exists: true,
  entries: [],
  parked: [],
  errors: [],
  lastSync: null,
  remote: null,
};

beforeEach(() => {
  mockUser = makeUser('admin');
  vi.mocked(endpoints.templates.list).mockResolvedValue([template]);
  vi.mocked(endpoints.templates.files).mockResolvedValue(filesStatus as never);
  vi.mocked(endpoints.containers.list).mockResolvedValue([]);
});

/** Open the deploy drawer for the fixture template and hand back its dialog. */
async function openDeploy() {
  const user = userEvent.setup();
  renderWithProviders(<TemplatesPage />, '/templates');

  const card = await screen.findByText('Uptime Kuma');
  const deploy = within(card.closest('.tpl-card') as HTMLElement).getByRole('button', { name: /deploy/i });
  await user.click(deploy);

  return { user, dialog: await screen.findByRole('dialog') };
}

describe('the deploy form names the port it is asking for', () => {
  it('labels the field "Host port" and shows the container port it forwards to', async () => {
    const { dialog } = await openDeploy();

    // The field is the host side, and says so, rather than being labelled with the service name.
    expect(within(dialog).getByText('Host port')).toBeTruthy();

    // The container port is visible next to the input, and labelled, so the mapping does not have to
    // be reconstructed from the summary further down.
    const input = within(dialog).getByLabelText('Host port for Web UI');
    expect(input.getAttribute('placeholder')).toBe('3001');
    expect(within(dialog).getByText('→ container 3001')).toBeTruthy();

    // And the helper text says which side is which, and which one a blank field falls back to.
    expect(within(dialog).getByText(/Web UI listens on/)).toBeTruthy();
    expect(within(dialog).getByText(/Leave blank to publish it on 3001/)).toBeTruthy();
    expect(within(dialog).getByText(/tunnel/i)).toBeTruthy();
  });

  it('publishes the port the user types, not the template default', async () => {
    const { user, dialog } = await openDeploy();

    const input = within(dialog).getByLabelText('Host port for Web UI');
    await user.clear(input);
    await user.type(input, '8880');

    // The rendered summary is what the request will carry, and it names which side is which.
    await waitFor(() =>
      expect(within(dialog).getByText('host 8880 -> container 3001')).toBeTruthy(),
    );
  });
});

describe('a host port that is already published', () => {
  it('warns, names the container holding it, and blocks the deploy', async () => {
    vi.mocked(endpoints.containers.list).mockResolvedValue([container()]);
    const { dialog } = await openDeploy();

    // The template's own default (3001) is the port that is taken.
    await waitFor(() => expect(within(dialog).getByText(/already published by dy-existing/)).toBeTruthy());
    expect(within(dialog).getByText(/That host port is taken/)).toBeTruthy();
    expect(within(dialog).getByRole('button', { name: /deploy/i })).toBeDisabled();
  });

  it('lets the deploy through once the user picks a free port', async () => {
    vi.mocked(endpoints.containers.list).mockResolvedValue([container()]);
    const { user, dialog } = await openDeploy();

    await waitFor(() => expect(within(dialog).getByText(/already published by dy-existing/)).toBeTruthy());

    const input = within(dialog).getByLabelText('Host port for Web UI');
    await user.clear(input);
    await user.type(input, '8880');

    await waitFor(() => expect(within(dialog).queryByText(/already published by/)).toBeNull());
    expect(within(dialog).getByRole('button', { name: /deploy/i })).not.toBeDisabled();
  });

  it('does not warn about a stopped container, which has released its port', async () => {
    vi.mocked(endpoints.containers.list).mockResolvedValue([
      container({ state: 'exited', status: 'Exited (0) 2 hours ago' }),
    ]);
    const { dialog } = await openDeploy();

    // Give the lookup a chance to land, then confirm it produced nothing.
    await waitFor(() => expect(vi.mocked(endpoints.containers.list)).toHaveBeenCalled());
    expect(within(dialog).queryByText(/already published by/)).toBeNull();
    expect(within(dialog).getByRole('button', { name: /deploy/i })).not.toBeDisabled();
  });

  it('does not block a deploy when the container lookup fails', async () => {
    vi.mocked(endpoints.containers.list).mockRejectedValue(new Error('docker unavailable'));
    const { dialog } = await openDeploy();

    await waitFor(() => expect(vi.mocked(endpoints.containers.list)).toHaveBeenCalled());
    // Docker is the authority on a clash; a lookup we could not complete must not stop a deploy.
    expect(within(dialog).getByRole('button', { name: /deploy/i })).not.toBeDisabled();
  });
});

describe('the deploy form says where the data will actually go', () => {
  // `named` is opt-out in the engine (server/src/templates/engine.ts): a spec that says nothing gets
  // a named volume, and only `named: false` asks for an anonymous one. The form read it as a truthy
  // opt-in, so it told every user of every shipped template the opposite of what would happen, and
  // labelled the field "Volume name" when the value it accepts is a host path.
  it('describes the named volume a blank host path produces', async () => {
    const { dialog } = await openDeploy();

    const input = within(dialog).getByLabelText('Host path for Data');
    expect(input.getAttribute('placeholder')).toBe('e.g. /srv/uptime-kuma');
    expect(within(dialog).getByText(/Leave blank to keep the data in a named volume/)).toBeTruthy();
    expect(within(dialog).getByText('named volume -> container /app/data')).toBeTruthy();
  });

  it('describes an anonymous volume only when the spec asks for one', async () => {
    vi.mocked(endpoints.templates.list).mockResolvedValue([
      {
        ...template,
        spec: {
          ...template.spec,
          volumes: [{ container: '/app/data', label: 'Data', named: false }],
        },
      },
    ]);
    const { dialog } = await openDeploy();

    expect(within(dialog).getByText(/Leave blank for an anonymous volume/)).toBeTruthy();
    expect(within(dialog).getByText('anonymous volume -> container /app/data')).toBeTruthy();
  });

  it('switches to a bind mount once a host path is typed', async () => {
    const { user, dialog } = await openDeploy();

    await user.type(within(dialog).getByLabelText('Host path for Data'), '/srv/uptime-kuma');

    await waitFor(() =>
      expect(within(dialog).getByText('host /srv/uptime-kuma -> container /app/data')).toBeTruthy(),
    );
  });
});
