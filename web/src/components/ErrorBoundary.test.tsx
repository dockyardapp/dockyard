import { describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';

import { ErrorBoundary } from './ErrorBoundary';

function Boom(): never {
  throw new Error('the view threw');
}

/** The boundary logs every catch on purpose; keep the test output clean. */
function quiet() {
  return vi.spyOn(console, 'error').mockImplementation(() => {});
}

describe('ErrorBoundary', () => {
  it('replaces a crashed view with a surface the operator can act on', () => {
    const spy = quiet();
    render(
      <ErrorBoundary title="This view stopped responding">
        <Boom />
      </ErrorBoundary>,
    );

    expect(screen.getByText('This view stopped responding')).not.toBeNull();
    expect(screen.getByText('the view threw')).not.toBeNull();
    expect(screen.getByRole('button', { name: 'Reload the panel' })).not.toBeNull();
    spy.mockRestore();
  });

  it('catches a crash raised inside a route, leaving the shell around it mounted', () => {
    const spy = quiet();
    render(
      <MemoryRouter initialEntries={['/broken']}>
        <div data-testid="shell">
          <ErrorBoundary>
            <Routes>
              <Route path="/broken" element={<Boom />} />
            </Routes>
          </ErrorBoundary>
        </div>
      </MemoryRouter>,
    );

    expect(screen.getByText('This view stopped responding')).not.toBeNull();
    // The nav and account block live outside the boundary, so they survive a broken page.
    expect(screen.getByTestId('shell')).not.toBeNull();
    spy.mockRestore();
  });

  it('renders its children when nothing throws', () => {
    render(
      <ErrorBoundary>
        <p>all fine</p>
      </ErrorBoundary>,
    );

    expect(screen.getByText('all fine')).not.toBeNull();
  });
});
