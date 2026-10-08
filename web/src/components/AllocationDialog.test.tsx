import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { AllocationDialog } from './AllocationDialog';
import { endpoints } from '../api/client';
import type { AdminUser, Grant } from '../api/types';

/**
 * The allocation editor is the only place an admin can hand out access, so the
 * behaviour worth pinning is: what it sends, what it refuses to offer, and that
 * an admin account is read-only here.
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
    },
  };
});

const mocked = endpoints.users as unknown as {
  grants: ReturnType<typeof vi.fn>;
  addGrant: ReturnType<typeof vi.fn>;
  clearGrants: ReturnType<typeof vi.fn>;
  removeGrant: ReturnType<typeof vi.fn>;
  update: ReturnType<typeof vi.fn>;
};

function makeAdminUser(extra: Partial<AdminUser> = {}): AdminUser {
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

const labelGrant: Grant = {
  id: 'grant-1',
  resource_kind: 'container',
  resource_id: null,
  label_key: 'dockyard.team',
  label_value: 'alice',
};

const idGrant: Grant = {
  id: 'grant-2',
  resource_kind: 'template',
  resource_id: 'redis',
  label_key: null,
  label_value: null,
};

beforeEach(() => {
  vi.clearAllMocks();
  mocked.grants.mockResolvedValue([]);
});

describe('AllocationDialog', () => {
  it('lists the allocated resources with their selector', async () => {
    mocked.grants.mockResolvedValue([labelGrant, idGrant]);
    render(<AllocationDialog user={makeAdminUser()} onClose={() => {}} onChanged={() => {}} />);

    expect(await screen.findByText('dockyard.team = alice')).toBeTruthy();
    expect(screen.getByText('redis')).toBeTruthy();

    // Scope the kind assertions to the table: the same nouns also appear as
    // options in the "Kind" picker below it.
    const table = screen.getByRole('table');
    expect(within(table).getByText('containers')).toBeTruthy();
    expect(within(table).getByText('templates')).toBeTruthy();
  });

  it('says plainly when a scoped user has nothing at all', async () => {
    mocked.grants.mockResolvedValue([]);
    render(<AllocationDialog user={makeAdminUser()} onClose={() => {}} onChanged={() => {}} />);

    expect(await screen.findByText('Nothing allocated')).toBeTruthy();
    expect(screen.getByText(/sees no resources at all/i)).toBeTruthy();
  });

  it('offers to scope an unscoped user, and warns that a grant would do it anyway', async () => {
    mocked.grants.mockResolvedValue([]);
    render(
      <AllocationDialog
        user={makeAdminUser({ scope_mode: 'all' })}
        onClose={() => {}}
        onChanged={() => {}}
      />,
    );

    expect(await screen.findByText('Restrict to allocated resources')).toBeTruthy();
    expect(screen.getByText(/have no effect while this user is unscoped/i)).toBeTruthy();
    expect(screen.getByText(/sees the whole host until you allocate something/i)).toBeTruthy();
  });

  it('sends a label selector as a label grant', async () => {
    const user = userEvent.setup();
    const onChanged = vi.fn();
    render(<AllocationDialog user={makeAdminUser()} onClose={() => {}} onChanged={onChanged} />);

    const key = await screen.findByPlaceholderText('dockyard.team');
    await user.type(key, 'dockyard.team');
    await user.type(screen.getByPlaceholderText('alice'), 'bob');
    await user.click(screen.getByRole('button', { name: /allocate/i }));

    await waitFor(() => expect(mocked.addGrant).toHaveBeenCalledTimes(1));
    expect(mocked.addGrant).toHaveBeenCalledWith('user-1', {
      resource_kind: 'container',
      label_key: 'dockyard.team',
      label_value: 'bob',
    });
    // The list is re-read and the parent told, so the count in the table updates.
    expect(mocked.grants).toHaveBeenCalled();
    expect(onChanged).toHaveBeenCalled();
  });

  it('sends an exact id when the selector is switched', async () => {
    const user = userEvent.setup();
    render(<AllocationDialog user={makeAdminUser()} onClose={() => {}} onChanged={() => {}} />);

    await screen.findByPlaceholderText('dockyard.team');
    await user.selectOptions(screen.getByLabelText('Selector'), 'id');
    await user.type(screen.getByPlaceholderText('redis'), 'redis');
    await user.click(screen.getByRole('button', { name: /allocate/i }));

    await waitFor(() => expect(mocked.addGrant).toHaveBeenCalledTimes(1));
    expect(mocked.addGrant).toHaveBeenCalledWith('user-1', {
      resource_kind: 'container',
      resource_id: 'redis',
    });
  });

  it('will not submit an empty selector', async () => {
    const user = userEvent.setup();
    render(<AllocationDialog user={makeAdminUser()} onClose={() => {}} onChanged={() => {}} />);

    const allocate = await screen.findByRole('button', { name: /allocate/i });
    expect(allocate).toHaveProperty('disabled', true);

    await user.type(screen.getByPlaceholderText('dockyard.team'), 'team');
    await waitFor(() => expect(allocate).toHaveProperty('disabled', false));
  });

  it('removes a single grant and clears them all', async () => {
    const user = userEvent.setup();
    mocked.grants.mockResolvedValue([labelGrant, idGrant]);
    render(<AllocationDialog user={makeAdminUser()} onClose={() => {}} onChanged={() => {}} />);

    await screen.findByText('dockyard.team = alice');
    await user.click(screen.getByRole('button', { name: 'Remove grant dockyard.team = alice' }));
    await waitFor(() => expect(mocked.removeGrant).toHaveBeenCalledWith('user-1', 'grant-1'));

    await user.click(screen.getByRole('button', { name: /clear all grants/i }));
    await waitFor(() => expect(mocked.clearGrants).toHaveBeenCalledWith('user-1'));
  });

  it('switches a scoped user back to the whole host', async () => {
    const user = userEvent.setup();
    render(<AllocationDialog user={makeAdminUser()} onClose={() => {}} onChanged={() => {}} />);

    await user.click(await screen.findByRole('button', { name: /grant full host access/i }));
    await waitFor(() =>
      expect(mocked.update).toHaveBeenCalledWith('user-1', { scope_mode: 'all' }),
    );
  });

  it('is read-only for an admin, who always sees everything', async () => {
    render(
      <AllocationDialog
        user={makeAdminUser({ role: 'admin', scope_mode: 'all' })}
        onClose={() => {}}
        onChanged={() => {}}
      />,
    );

    expect(await screen.findByText('Administrators are never scoped')).toBeTruthy();
    // No allocation controls at all: an admin cannot be restricted.
    expect(screen.queryByRole('button', { name: /allocate/i })).toBeNull();
    expect(screen.queryByPlaceholderText('dockyard.team')).toBeNull();
    expect(mocked.grants).not.toHaveBeenCalled();
  });

  it('reports a failed change instead of pretending it worked', async () => {
    const user = userEvent.setup();
    mocked.addGrant.mockRejectedValue(new Error('nope'));
    render(<AllocationDialog user={makeAdminUser()} onClose={() => {}} onChanged={() => {}} />);

    await user.type(await screen.findByPlaceholderText('dockyard.team'), 'team');
    await user.click(screen.getByRole('button', { name: /allocate/i }));

    expect(await screen.findByText('Allocation change failed')).toBeTruthy();
  });
});
