import { describe, expect, it } from 'vitest';
import { useState } from 'react';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { ConfirmProvider, useConfirm } from './ui';

/**
 * The typed-phrase gate in front of every destructive action. It is the last
 * thing standing between an operator and a deleted container, so the disabled
 * state is pinned rather than eyeballed.
 */
function Harness() {
  const confirm = useConfirm();
  const [outcome, setOutcome] = useState('pending');
  return (
    <div>
      <button
        type="button"
        onClick={() => {
          void confirm({
            title: 'Remove container?',
            phrase: 'dy-web',
            confirmLabel: 'Remove',
            danger: true,
          }).then((ok) => setOutcome(ok ? 'confirmed' : 'cancelled'));
        }}
      >
        ask
      </button>
      <span data-testid="outcome">{outcome}</span>
    </div>
  );
}

function renderHarness() {
  return render(
    <ConfirmProvider>
      <Harness />
    </ConfirmProvider>,
  );
}

describe('ConfirmProvider', () => {
  it('starts with the confirm button disabled until the phrase is typed', async () => {
    const user = userEvent.setup();
    renderHarness();

    await user.click(screen.getByRole('button', { name: 'ask' }));
    expect(await screen.findByText('Remove container?')).toBeInTheDocument();

    const confirmButton = screen.getByRole('button', { name: 'Remove' });
    expect(confirmButton).toBeDisabled();
  });

  it('keeps the confirm button disabled for a wrong phrase', async () => {
    const user = userEvent.setup();
    renderHarness();
    await user.click(screen.getByRole('button', { name: 'ask' }));

    const input = await screen.findByRole('textbox');
    await user.type(input, 'dy-we');
    expect(screen.getByRole('button', { name: 'Remove' })).toBeDisabled();

    await user.type(input, 'bx');
    expect(screen.getByRole('button', { name: 'Remove' })).toBeDisabled();
  });

  it('enables the confirm button on the exact phrase and resolves true', async () => {
    const user = userEvent.setup();
    renderHarness();
    await user.click(screen.getByRole('button', { name: 'ask' }));

    const input = await screen.findByRole('textbox');
    await user.type(input, 'dy-web');

    const confirmButton = screen.getByRole('button', { name: 'Remove' });
    expect(confirmButton).toBeEnabled();

    await user.click(confirmButton);
    expect(screen.getByTestId('outcome')).toHaveTextContent('confirmed');
  });

  it('resolves false on cancel without acting', async () => {
    const user = userEvent.setup();
    renderHarness();
    await user.click(screen.getByRole('button', { name: 'ask' }));

    const input = await screen.findByRole('textbox');
    await user.type(input, 'dy-web');
    await user.click(screen.getByRole('button', { name: 'Cancel' }));

    expect(screen.getByTestId('outcome')).toHaveTextContent('cancelled');
  });

  it('tolerates surrounding whitespace in the typed phrase', async () => {
    const user = userEvent.setup();
    renderHarness();
    await user.click(screen.getByRole('button', { name: 'ask' }));

    const input = await screen.findByRole('textbox');
    await user.type(input, '  dy-web  ');
    expect(screen.getByRole('button', { name: 'Remove' })).toBeEnabled();
  });
});
