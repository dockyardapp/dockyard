import { useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { endpoints, errorMessage } from '../api/client';
import type { VolumeSummary } from '../api/types';
import { usePolling } from '../hooks/usePolling';
import { useRowCap } from '../hooks/useRowCap';
import { RowCapNotice } from '../components/RowCapNotice';
import { useAuth } from '../hooks/useAuth';
import { can } from '../lib/rbac';
import {
  Banner,
  Button,
  Card,
  EmptyState,
  PageHead,
  SkeletonRows,
  TextField,
  useConfirm,
} from '../components/ui';
import { formatDateTime, matchesQuery } from '../lib/format';

export function VolumesPage() {
  const { user } = useAuth();
  const confirm = useConfirm();
  const canWrite = can.write(user?.role);
  const canDestroy = can.destroy(user?.role);

  const [query, setQuery] = useState('');
  const [newName, setNewName] = useState('');
  const [createBusy, setCreateBusy] = useState(false);
  const [pending, setPending] = useState<Record<string, boolean>>({});
  const [notice, setNotice] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const list = usePolling<VolumeSummary[]>(() => endpoints.volumes.list(), { intervalMs: 20000 });

  const filtered = useMemo(
    () => (list.data ?? []).filter((v) => matchesQuery(query, v.name, v.driver, v.mountpoint)),
    [list.data, query],
  );

  const capped = useRowCap(filtered);

  const create = async () => {
    const name = newName.trim();
    if (!name) return;
    setCreateBusy(true);
    setError(null);
    setNotice(null);
    try {
      await endpoints.volumes.create(name);
      setNotice(`Created volume ${name}.`);
      setNewName('');
      await list.refresh();
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setCreateBusy(false);
    }
  };

  const removeVolume = async (v: VolumeSummary) => {
    const ok = await confirm({
      title: `Delete volume ${v.name}?`,
      body: v.inUseBy.length > 0 ? `${v.inUseBy.length} container(s) use this volume. Force removal may lose data.` : 'The volume and its data are removed.',
      confirmLabel: 'Delete volume',
      danger: true,
      phrase: v.name,
    });
    if (!ok) return;
    setPending((p) => ({ ...p, [`${v.name}:remove`]: true }));
    setError(null);
    try {
      await endpoints.volumes.remove(v.name, { force: v.inUseBy.length > 0 });
      await list.refresh();
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setPending((p) => ({ ...p, [`${v.name}:remove`]: false }));
    }
  };

  return (
    <>
      <PageHead
        title="Volumes"
        desc={list.data ? `${filtered.length} of ${list.data.length} volumes` : 'Named Docker volumes'}
        actions={
          <Button icon="refresh" busy={list.refreshing} onClick={() => void list.refresh()}>
            Refresh
          </Button>
        }
      />

      {error ? (
        <Banner tone="error" title="Volume action failed" onDismiss={() => setError(null)}>
          {error}
        </Banner>
      ) : null}
      {notice ? (
        <Banner tone="info" onDismiss={() => setNotice(null)}>
          {notice}
        </Banner>
      ) : null}
      {list.error ? (
        <Banner tone="error" title="Could not load volumes" onDismiss={() => void list.refresh()}>
          {errorMessage(list.error)}
        </Banner>
      ) : null}

      <Card title="Create a volume">
        <div className="row" style={{ gap: 'var(--space-2)', alignItems: 'flex-end' }}>
          <div style={{ flex: '1 1 320px' }}>
            <TextField
              label="Volume name"
              value={newName}
              onChange={(e) => setNewName(e.target.value)}
              placeholder="app-data"
              disabled={!canWrite || createBusy}
              onKeyDown={(e) => {
                if (e.key === 'Enter') void create();
              }}
            />
          </div>
          <Button variant="primary" icon="plus" busy={createBusy} disabled={!canWrite || !newName.trim()} onClick={() => void create()}>
            Create
          </Button>
        </div>
      </Card>

      <div className="toolbar" style={{ marginTop: 'var(--space-4)' }}>
        <input
          type="search"
          className="search-input"
          placeholder="Filter volumes"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          aria-label="Filter volumes"
        />
      </div>

      <Card flush>
        {list.loading && !list.data ? (
          <SkeletonRows rows={5} cols={4} />
        ) : list.error && !list.data ? null : filtered.length === 0 ? (
          <div style={{ padding: 'var(--space-4)' }}>
            <EmptyState
              icon="volume"
              title={list.data && list.data.length > 0 ? 'No volumes match' : 'No volumes yet'}
              action={
                list.data && list.data.length > 0 ? (
                  <Button onClick={() => setQuery('')}>Clear filter</Button>
                ) : (
                  <Button onClick={() => setNewName('app-data')} disabled={!canWrite}>
                    Suggest a name
                  </Button>
                )
              }
            >
              {list.data && list.data.length > 0
                ? 'Adjust the filter text to see other volumes.'
                : 'Create a volume to persist data outside a container.'}
            </EmptyState>
          </div>
        ) : (
          <div className="table-wrap">
            <table className="data">
              <thead>
                <tr>
                  <th>Name</th>
                  <th>Driver</th>
                  <th>Mountpoint</th>
                  <th>In use by</th>
                  <th>Created</th>
                  <th className="num">Actions</th>
                </tr>
              </thead>
              <tbody>
                {capped.visible.map((v) => (
                  <tr key={v.name}>
                    <td className="primary mono-cell" data-label="Name">{v.name}</td>
                    <td data-label="Driver">{v.driver}</td>
                    <td className="mono-cell" data-label="Mountpoint">
                      <span className="truncate" title={v.mountpoint}>{v.mountpoint}</span>
                    </td>
                    <td data-label="In use by">
                      {v.inUseBy.length === 0 ? (
                        <span className="dim">unused</span>
                      ) : (
                        <span className="row" style={{ gap: 'var(--space-1)', flexWrap: 'wrap' }}>
                          {v.inUseBy.map((c) => (
                            <Link key={c} to={`/containers/${c}`} className="tag">
                              {c.slice(0, 12)}
                            </Link>
                          ))}
                        </span>
                      )}
                    </td>
                    <td className="dim nowrap" data-label="Created">{formatDateTime(v.created)}</td>
                    <td className="cell-actions" data-label="Actions">
                      <Button
                        size="sm"
                        variant="danger"
                        icon="trash"
                        disabled={!canDestroy || pending[`${v.name}:remove`]}
                        busy={pending[`${v.name}:remove`]}
                        aria-label={`Delete volume ${v.name}`}
                        title={canDestroy ? 'Delete volume' : 'Requires the admin role'}
                        onClick={() => void removeVolume(v)}
                      />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
            <RowCapNotice
              hidden={capped.hiddenCount}
              total={filtered.length}
              noun="volumes"
              onShowAll={capped.showAll}
            />
          </div>
        )}
      </Card>
    </>
  );
}
