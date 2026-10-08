import { useState } from 'react';
import { endpoints, errorMessage } from '../api/client';
import type { AuditEntry } from '../api/types';
import { usePolling } from '../hooks/usePolling';
import { JsonView } from '../components/JsonView';
import {
  Banner,
  Button,
  Card,
  EmptyState,
  PageHead,
  SkeletonRows,
} from '../components/ui';
import { formatDateTime, relativeTime } from '../lib/format';

const LIMITS = [50, 100, 250, 500];

export function AuditPage() {
  const [action, setAction] = useState('');
  const [limit, setLimit] = useState(100);
  const [offset, setOffset] = useState(0);
  const [expanded, setExpanded] = useState<number | null>(null);

  const list = usePolling<AuditEntry[]>(
    () => endpoints.audit.list({ limit, offset, action: action.trim() || undefined }),
    { deps: [action, limit, offset] },
  );

  const rows = list.data ?? [];

  return (
    <>
      <PageHead
        title="Audit log"
        desc={`Entries ${offset + 1} to ${offset + rows.length}`}
        actions={
          <Button icon="refresh" busy={list.refreshing} onClick={() => void list.refresh()}>
            Refresh
          </Button>
        }
      />

      {list.error ? (
        <Banner tone="error" title="Could not load the audit log" onDismiss={() => void list.refresh()}>
          {errorMessage(list.error)}
        </Banner>
      ) : null}

      <div className="toolbar">
        <input
          type="search"
          className="search-input"
          placeholder="Filter by action"
          value={action}
          onChange={(e) => {
            setAction(e.target.value);
            setOffset(0);
          }}
          aria-label="Filter by action"
        />
        <select
          value={limit}
          onChange={(e) => {
            setLimit(Number(e.target.value));
            setOffset(0);
          }}
          aria-label="Rows per page"
          style={{ width: 'auto' }}
        >
          {LIMITS.map((l) => (
            <option key={l} value={l}>
              {l} rows
            </option>
          ))}
        </select>
      </div>

      <Card flush>
        {list.loading && !list.data ? (
          <SkeletonRows rows={8} cols={5} />
        ) : list.error && !list.data ? null : rows.length === 0 ? (
          <div style={{ padding: 'var(--space-4)' }}>
            <EmptyState
              icon="audit"
              title={offset > 0 || action ? 'No entries match' : 'No audit entries yet'}
              action={
                offset > 0 || action ? (
                  <Button
                    onClick={() => {
                      setAction('');
                      setOffset(0);
                    }}
                  >
                    Clear filters
                  </Button>
                ) : undefined
              }
            >
              {offset > 0 || action
                ? 'Change the filter or go back a page.'
                : 'Every action taken in the console is recorded here.'}
            </EmptyState>
          </div>
        ) : (
          <div className="table-wrap">
            <table className="data">
              <thead>
                <tr>
                  <th>When</th>
                  <th>User</th>
                  <th>Action</th>
                  <th>Target</th>
                  <th>IP</th>
                  <th className="num">Detail</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((e) => (
                  <tr key={e.id}>
                    <td className="dim nowrap" data-label="When" title={formatDateTime(e.created_at)}>
                      {relativeTime(e.created_at)}
                    </td>
                    <td data-label="User">{e.user_email ?? <span className="dim">system</span>}</td>
                    <td className="mono-cell" data-label="Action">{e.action}</td>
                    <td className="mono-cell" data-label="Target">
                      {e.target_type}
                      {e.target_id ? <span className="dim">:{e.target_id}</span> : null}
                    </td>
                    <td className="mono-cell dim" data-label="IP">{e.ip ?? '-'}</td>
                    <td className="cell-actions" data-label="Detail">
                      {e.detail === null || e.detail === undefined ? (
                        <span className="dim">-</span>
                      ) : (
                        <Button size="sm" onClick={() => setExpanded(expanded === e.id ? null : e.id)}>
                          {expanded === e.id ? 'Hide' : 'Show'}
                        </Button>
                      )}
                    </td>
                  </tr>
                ))}
                {expanded !== null ? (
                  <tr>
                    <td colSpan={6} style={{ background: 'var(--bg-canvas)' }}>
                      <JsonView value={rows.find((r) => r.id === expanded)?.detail} />
                    </td>
                  </tr>
                ) : null}
              </tbody>
            </table>
          </div>
        )}
      </Card>

      <div className="row" style={{ marginTop: 'var(--space-4)', justifyContent: 'space-between' }}>
        <Button disabled={offset === 0} onClick={() => setOffset(Math.max(0, offset - limit))}>
          Previous
        </Button>
        <span className="dim" style={{ fontSize: 'var(--fs-micro)' }}>
          {rows.length} rows
        </span>
        <Button disabled={rows.length < limit} onClick={() => setOffset(offset + limit)}>
          Next
        </Button>
      </div>
    </>
  );
}
