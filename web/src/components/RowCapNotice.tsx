import { Button } from './ui';

/**
 * Tells the operator that the table below is showing a capped window, and
 * offers the way out. A silently truncated list would read as "this host only
 * has 250 containers", which is worse than the cap itself.
 */
export function RowCapNotice({
  hidden,
  total,
  noun,
  onShowAll,
}: {
  hidden: number;
  total: number;
  noun: string;
  onShowAll: () => void;
}) {
  if (hidden <= 0) return null;
  return (
    <div className="row-cap">
      <span className="dim">
        Showing {total - hidden} of {total} {noun}. Filter to narrow the list.
      </span>
      <Button size="sm" onClick={onShowAll}>
        Show all {total}
      </Button>
    </div>
  );
}
