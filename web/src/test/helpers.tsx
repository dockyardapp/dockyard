import type { ReactElement } from 'react';
import { render } from '@testing-library/react';
import type { RenderResult } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { ConfirmProvider } from '../components/ui';
import type { PublicUser, UserRole } from '../api/types';

/**
 * Render a page with the providers it needs. Auth and the event socket are
 * mocked per test file (see the page tests), so this only supplies the router
 * and the confirm dialog host.
 */
export function renderWithProviders(ui: ReactElement, route = '/'): RenderResult {
  return render(
    <MemoryRouter initialEntries={[route]}>
      <ConfirmProvider>{ui}</ConfirmProvider>
    </MemoryRouter>,
  );
}

export function makeUser(role: UserRole, email = `${role}@dockyard.local`): PublicUser {
  return {
    id: `user-${role}`,
    email,
    role,
    created_at: '2026-01-01T00:00:00.000Z',
    last_login_at: null,
  };
}
