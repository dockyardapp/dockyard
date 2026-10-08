import { useMemo, useState } from 'react';

/** How many rows reach the DOM before the operator has to ask for more. */
export const DEFAULT_ROW_CAP = 250;

export type RowCap<T> = {
  visible: T[];
  hiddenCount: number;
  capped: boolean;
  showAll: () => void;
};

/**
 * Cap how many rows a plain table renders.
 *
 * The list views are ordinary tables with no virtualization, so a host with
 * thousands of containers, images or audit rows would mount a row per record
 * and stall the main thread. Filtering stays exact: this only limits what is
 * painted, and the operator can expand the window on demand.
 */
export function useRowCap<T>(rows: T[], cap: number = DEFAULT_ROW_CAP): RowCap<T> {
  const [expanded, setExpanded] = useState(false);

  const visible = useMemo(() => {
    if (expanded || rows.length <= cap) return rows;
    return rows.slice(0, cap);
  }, [rows, expanded, cap]);

  const hiddenCount = rows.length - visible.length;

  return {
    visible,
    hiddenCount,
    capped: hiddenCount > 0,
    showAll: () => setExpanded(true),
  };
}
