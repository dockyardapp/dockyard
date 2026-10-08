import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { AllocationDialog } from './AllocationDialog';
import { endpoints } from '../api/client';
import type { AdminUser, Grant } from '../api/types';

/**
 * The allocation editor is the only place an admin can hand out access. The
 * behaviour worth pinning is what it sends, that a tick lands without waiting on
 * the network, and that an admin account is read-only here.
 */

vi.mock('../api/client', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../api/client')>();
  return {
    ...actual,
    endpoints: {
      users: {
        grants: vi.fn(),
        addGrant: vi.fn(),
        clearGrants: vi.fn(),
        removeGrant: vi.fn(),
        update: vi.fn(),
      },
      containers: { list: vi.fn() },
      stacks: { list: vi.fn() },
      volumes: { list: vi.fn() },
      networks: { list: vi.fn() },
      images: { list: vi.fn() },
      templates: { list: vi.fn() },
      tunnels: { list: vi.fn() },
    },
  };
});

type Mock = ReturnType<typeof vi.fn>;

const mocked = endpoints as unknown as {
  users: { grants: Mock; addGrant: Mock; clearGrants: Mock; removeGrant: Mock; update: Mock };
  containers: { list: Mock };
  stacks: { list: Mock };
  volumes: { list: Mock };
  networks: { list: Mock };
  images: { list: Mock };
  templates: { list: Mock };
  tunnels: { list: Mock };
};

function makeUser(extra: Partial<AdminUser> = {}): AdminUser {
  return {
    id: 'user-1',
    email: 'alice@dockyard.local',
    role: 'operator',
    scope_mode: 'granted',
    can_exec: false,
    created_at: '2026-01-01T00:00:00.000Z',
    last_login_at: null,
    grant_count: 0,
    ...extra,
  };
}

const containerGrant: Grant = {
  id: 'grant-1',
  resource_kind: 'container',
  resource_id: 'dy-demo-app',
  label_key: null,
  label_value: null,
};

const labelGrant: Grant = {
  id: 'grant-2',
  resource_kind: 'container',
  resource_id: null,
  label_key: 'dockyard.team',
  label_value: 'platform',
};

function renderDialog(user: AdminUser = makeUser(), onChanged = vi.fn()) {
  render(<AllocationDialog user={user} onClose={() => {}} onChanged={onChanged} />);
  return onChanged;
}

beforeEach(() => {
  vi.clearAllMocks();
  mocked.users.grants.mockResolvedValue([]);
  mocked.users.addGrant.mockResolvedValue(undefined);
  mocked.users.removeGrant.mockResolvedValue(undefined);
  mocked.users.clearGrants.mockResolvedValue(undefined);
  mocked.users.update.mockResolvedValue(undefined);
  mocked.containers.list.mockResolvedValue([
    { id: 'c1', name: 'dy-demo-app', image: 'alpine:3.20', state: 'running' },
    { id: 'c2', name: 'dy-demo-other', image: 'nginx:1.27', state: 'exited' },
  ]);
  mocked.stacks.list.mockResolvedValue([{ id: 's1', name: 'shop', status: 'running' }]);
  mocked.volumes.list.mockResolvedValue([{ name: 'dy-vol', driver: 'local' }]);
  mocked.networks.list.mockResolvedValue([{ name: 'dy-net', driver: 'bridge' }]);
  mocked.images.list.mockResolvedValue([
    { id: 'sha256:abcdef0123456789', repoTags: ['redis:7.4'], size: 40_000_000 },
  ]);
  mocked.templates.list.mockResolvedValue([
    { id: 't1', slug: 'redis', name: 'Redis', category: 'database' },
  ]);
  mocked.tunnels.list.mockResolvedValue([
    { id: 'n1', name: 'edge', mode: 'quick', status: 'running' },
  ]);
});

describe('AllocationDialog', () => {
  it('lists the host\'s resources by name, with the allocated ones already ticked', async () => {
    mocked.users.grants.mockResolvedValue([containerGrant]);
    renderDialog();

    const app = await screen.findByRole('checkbox', { name: /dy-demo-app/ });
    const other = screen.getByRole('checkbox', { name: /dy-demo-other/ });

    expect(app).toHaveProperty('checked', true);
    expect(other).toHaveProperty('checked', false);
    // Named and described, never a raw digest.
    expect(screen.getByText('alpine:3.20 · running')).toBeTruthy();
    expect(screen.getByText('nginx:1.27 · exited')).toBeTruthy();
  });

  it('reads every kind once, so switching kind is instant', async () => {
    renderDialog();
    await screen.findByRole('checkbox', { name: /dy-demo-app/ });

    expect(mocked.containers.list).toHaveBeenCalledWith({ all: true });
    expect(mocked.stacks.list).toHaveBeenCalledTimes(1);
    expect(mocked.volumes.list).toHaveBeenCalledTimes(1);
    expect(mocked.networks.list).toHaveBeenCalledTimes(1);
    expect(mocked.images.list).toHaveBeenCalledTimes(1);
    expect(mocked.templates.list).toHaveBeenCalledTimes(1);
    expect(mocked.tunnels.list).toHaveBeenCalledTimes(1);
  });

  it('grants a resource by name when it is ticked', async () => {
    const user = userEvent.setup();
    const onChanged = renderDialog();

    await user.click(await screen.findByRole('checkbox', { name: /dy-demo-app/ }));

    await waitFor(() =>
      expect(mocked.users.addGrant).toHaveBeenCalledWith('user-1', {
        resource_kind: 'container',
        resource_id: 'dy-demo-app',
      }),
    );
    // Wait for the whole chain: the reload and the parent notification are what
    // the admin sees next, and leaving them floating leaks into the next test.
    await waitFor(() => expect(onChanged).toHaveBeenCalled());
  });

  it('moves the tick before the request comes back', async () => {
    const user = userEvent.setup();
    let release: () => void = () => {};
    mocked.users.addGrant.mockReturnValue(
      new Promise<void>((resolve) => {
        release = () => resolve();
      }),
    );
    renderDialog();

    const box = await screen.findByRole('checkbox', { name: /dy-demo-app/ });
    await user.click(box);

    // Still in flight: a checkbox that waits on the round trip reads as broken.
    expect(box).toHaveProperty('checked', true);
    release();
    await waitFor(() => expect(mocked.users.addGrant).toHaveBeenCalled());
    await screen.findByText('dy-demo-app');
  });

  it('puts the tick back and says so when the grant fails', async () => {
    const user = userEvent.setup();
    mocked.users.addGrant.mockRejectedValue(new Error('nope'));
    renderDialog();

    const box = await screen.findByRole('checkbox', { name: /dy-demo-app/ });
    await user.click(box);

    expect(await screen.findByText('Access change failed')).toBeTruthy();
    await waitFor(() => expect(box).toHaveProperty('checked', false));
  });

  it('removes the grant when a resource is unticked', async () => {
    const user = userEvent.setup();
    mocked.users.grants.mockResolvedValue([containerGrant]);
    const onChanged = renderDialog();

    await user.click(await screen.findByRole('checkbox', { name: /dy-demo-app/ }));

    await waitFor(() =>
      expect(mocked.users.removeGrant).toHaveBeenCalledWith('user-1', 'grant-1'),
    );
    await waitFor(() => expect(onChanged).toHaveBeenCalled());
  });

  it('narrows the list by name or image', async () => {
    const user = userEvent.setup();
    renderDialog();

    await screen.findByRole('checkbox', { name: /dy-demo-app/ });
    await user.type(screen.getByLabelText('Filter'), 'nginx');

    expect(screen.queryByRole('checkbox', { name: /dy-demo-app/ })).toBeNull();
    expect(screen.getByRole('checkbox', { name: /dy-demo-other/ })).toBeTruthy();
  });

  it('keeps the label form behind Advanced', async () => {
    const user = userEvent.setup();
    const onChanged = renderDialog();

    await screen.findByRole('checkbox', { name: /dy-demo-app/ });
    // Not the thing an admin meets first.
    expect(screen.queryByPlaceholderText('dockyard.team')).toBeNull();

    await user.click(screen.getByRole('button', { name: /advanced/i }));
    await user.type(screen.getByPlaceholderText('dockyard.team'), 'dockyard.team');
    await user.type(screen.getByPlaceholderText('platform'), 'platform');
    await user.click(screen.getByRole('button', { name: /^Add$/ }));

    await waitFor(() =>
      expect(mocked.users.addGrant).toHaveBeenCalledWith('user-1', {
        resource_kind: 'container',
        label_key: 'dockyard.team',
        label_value: 'platform',
      }),
    );
    await waitFor(() => expect(onChanged).toHaveBeenCalled());
  });

  it('will not add an empty advanced selector', async () => {
    const user = userEvent.setup();
    renderDialog();

    await screen.findByRole('checkbox', { name: /dy-demo-app/ });
    await user.click(screen.getByRole('button', { name: /advanced/i }));

    const add = screen.getByRole('button', { name: /^Add$/ });
    expect(add).toHaveProperty('disabled', true);

    await user.type(screen.getByPlaceholderText('dockyard.team'), 'team');
    await waitFor(() => expect(add).toHaveProperty('disabled', false));
  });

  it('removes one grant, and all of them', async () => {
    const user = userEvent.setup();
    mocked.users.grants.mockResolvedValue([containerGrant, labelGrant]);
    const onChanged = renderDialog();

    await screen.findByText('dockyard.team = platform');
    await user.click(screen.getByRole('button', { name: 'Remove access to dy-demo-app' }));
    await waitFor(() =>
      expect(mocked.users.removeGrant).toHaveBeenCalledWith('user-1', 'grant-1'),
    );

    await user.click(screen.getByRole('button', { name: /remove all access/i }));
    await waitFor(() => expect(mocked.users.clearGrants).toHaveBeenCalledWith('user-1'));
    await waitFor(() => expect(onChanged).toHaveBeenCalled());
  });

  it('says plainly when a scoped user has nothing at all', async () => {
    renderDialog();

    expect(await screen.findByText(/sees no resources at all/i)).toBeTruthy();
  });

  it('tells an unscoped user that a tick is what restricts them', async () => {
    renderDialog(makeUser({ scope_mode: 'all' }));

    expect(await screen.findByText(/still sees the whole host/i)).toBeTruthy();
    expect(screen.getByText(/restricts them to it automatically/i)).toBeTruthy();
  });

  it('switches a scoped user back to the whole host', async () => {
    const user = userEvent.setup();
    const onChanged = renderDialog();

    await user.click(await screen.findByRole('button', { name: /give full host access/i }));
    await waitFor(() =>
      expect(mocked.users.update).toHaveBeenCalledWith('user-1', { scope_mode: 'all' }),
    );
    await waitFor(() => expect(onChanged).toHaveBeenCalled());
  });

  it('is read-only for an admin, who always sees everything', async () => {
    renderDialog(makeUser({ role: 'admin', scope_mode: 'all' }));

    expect(await screen.findByText('Administrators are never scoped')).toBeTruthy();
    expect(screen.queryByRole('checkbox')).toBeNull();
    expect(screen.queryByRole('button', { name: /advanced/i })).toBeNull();
    expect(mocked.users.grants).not.toHaveBeenCalled();
    expect(mocked.containers.list).not.toHaveBeenCalled();
  });

  it('shows the granted resource next to its kind', async () => {
    mocked.users.grants.mockResolvedValue([containerGrant]);
    renderDialog();

    await screen.findByRole('checkbox', { name: /dy-demo-app/ });
    const table = screen.getByRole('table');
    expect(within(table).getByText('dy-demo-app')).toBeTruthy();
    expect(within(table).getByText('containers')).toBeTruthy();
    expect(within(table).getByText('name')).toBeTruthy();
  });
});
