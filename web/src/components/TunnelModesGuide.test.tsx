import { describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';

import { COMPARISON, GUIDE_MODES, TunnelModesGuide, WHEN_TO_USE } from './TunnelModesGuide';

describe('TunnelModesGuide', () => {
  it('gives every mode a column in the comparison', () => {
    const { container } = render(<TunnelModesGuide />);

    const table = container.querySelector('table.data');
    expect(table).not.toBeNull();

    const headers = [...table!.querySelectorAll('thead th')].map((th) => th.textContent);
    // A named label column plus one column per mode, in the order the create dialog uses.
    expect(headers).toEqual(['Attribute', ...GUIDE_MODES]);
  });

  it('answers every comparison row for every mode', () => {
    // The values are keyed by mode, so a missing key is a type error; this catches a row
    // whose value was left as an empty string instead.
    for (const row of COMPARISON) {
      for (const mode of GUIDE_MODES) {
        expect(row.values[mode], `${row.label} / ${mode}`).toBeTruthy();
      }
    }
  });

  it('renders one row per comparison entry, with no cell left blank', () => {
    const { container } = render(<TunnelModesGuide />);

    const bodyRows = [...container.querySelectorAll('table.data tbody tr')];
    expect(bodyRows).toHaveLength(COMPARISON.length);

    for (const tr of bodyRows) {
      const cells = [...tr.querySelectorAll('td')].map((td) => td.textContent?.trim() ?? '');
      expect(cells).toHaveLength(GUIDE_MODES.length + 1);
      for (const cell of cells) expect(cell).not.toBe('');
    }
  });

  it('says which mode to reach for', () => {
    render(<TunnelModesGuide />);

    expect(WHEN_TO_USE.length).toBeGreaterThan(0);
    for (const row of WHEN_TO_USE) {
      expect(screen.getByText(row.situation)).toBeTruthy();
      expect(screen.getByText(row.choice)).toBeTruthy();
    }
  });

  it('names every mode in the guidance, not only in the table header', () => {
    const guidance = WHEN_TO_USE.map((r) => r.choice)
      .join(' ')
      .toLowerCase();

    for (const mode of GUIDE_MODES) expect(guidance).toContain(mode);
  });

  it('explains every status a tunnel can report', () => {
    render(<TunnelModesGuide />);

    for (const state of ['stopped', 'starting', 'running', 'error']) {
      expect(screen.getByText(state)).toBeTruthy();
    }
  });

  it('warns that a tunnel is public and adds no authentication', () => {
    render(<TunnelModesGuide />);

    expect(screen.getByText(/adds no authentication of its own/i)).toBeTruthy();
  });

  it('warns about the localtunnel browser gate, which is the mode a person would hit', () => {
    render(<TunnelModesGuide />);

    // Named in both the comparison and the caveats, which is deliberate.
    expect(screen.getAllByText(/public IP/i).length).toBeGreaterThan(0);
  });

  it('keeps the copy free of em dashes and en dashes', () => {
    const { container } = render(<TunnelModesGuide />);

    expect(container.textContent ?? '').not.toMatch(/[\u2014\u2013]/);
  });
});
