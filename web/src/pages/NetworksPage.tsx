import { useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { endpoints, errorMessage } from '../api/client';
import type { NetworkSummary } from '../api/types';
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
  Pill,
  SkeletonRows,
  TextField,
  useConfirm,
} from '../components/ui';
import { matchesQuery, shortId } from '../lib/format';

const DRIVERS = ['bridge', 'overlay', 'macvlan', 'host', 'none'];

export function NetworksPage() {
  const { user } = useAuth();
  const confirm = useConfirm();
  const canWrite = can.write(user?.role);
  const canDestroy = can.destroy(user?.role);

  const [query, setQuery] = useState('');
  const [name, setName] = useState('');
  const [driver, setDriver] = useState('bridge');
  const [createBusy, setCreateBusy] = useState(false);
  const [pending, setPending] = useState<Record<string, boolean>>({});
  const [notice, setNotice] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const list = usePolling<NetworkSummary[]>(() => endpoints.networks.list(), { intervalMs: 20000 });

  const filtered = useMemo(
    () => (list.data ?? []).filter((n) => matchesQuery(query, n.name, n.driver, n.id)),
    [list.data, query],
  );

  const capped = useRowCap(filtered);

  const create = async () => {
    const n = name.trim();
    if (!n) return;
    setCreateBusy(true);
    setError(null);
    setNotice(null);
    try {
      await endpoints.networks.create(n, driver);
      setNotice(`Created network ${n}.`);
      setName('');
      await list.refresh();
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setCreateBusy(false);
    }
  };

  const removeNetwork = async (net: NetworkSummary) => {
    const ok = await confirm({
      title: `Delete network ${net.name}?`,
      body:
        net.containers.length > 0
          ? `${net.containers.length} container(s) are attached. Docker refuses to remove a network in use.`
          : 'The network is removed. This cannot be undone.',
      confirmLabel: 'Delete network',
      danger: true,
    });
    if (!ok) return;
    setPending((p) => ({ ...p, [`${net.id}:remove`]: true }));
    setError(null);
    try {
      await endpoints.networks.remove(net.id);
      await list.refresh();
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setPending((p) => ({ ...p, [`${net.id}:remove`]: false }));
    }
  };

  return (
    <>
      <PageHead
        title="Networks"
        desc={list.data ? `${filtered.length} of ${list.data.length} networks` : 'Docker networks'}
        actions={
          <Button icon="refresh" busy={list.refreshing} onClick={() => void list.refresh()}>
            Refresh
          </Button>
        }
      />

      {error ? (
        <Banner tone="error" title="Network action failed" onDismiss={() => setError(null)}>
          {error}
        </Banner>
      ) : null}
      {notice ? (
        <Banner tone="info" onDismiss={() => setNotice(null)}>
          {notice}
        </Banner>
      ) : null}
      {list.error ? (
        <Banner tone="error" title="Could not load networks" onDismiss={() => void list.refresh()}>
          {errorMessage(list.error)}
        </Banner>
      ) : null}

      <Card title="Create a network">
        <div className="row" style={{ gap: 'var(--space-2)', alignItems: 'flex-end', flexWrap: 'wrap' }}>
          <div style={{ flex: '1 1 280px' }}>
            <TextField
              label="Network name"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="app-net"
              disabled={!canWrite || createBusy}
              onKeyDown={(e) => {
                if (e.key === 'Enter') void create();
              }}
            />
          </div>
          <div style={{ flex: '0 0 160px' }}>
            <label className="field-label" htmlFor="net-driver">
              Driver
            </label>
            <select id="net-driver" value={driver} onChange={(e) => setDriver(e.target.value)} disabled={!canWrite || createBusy}>
              {DRIVERS.map((d) => (
                <option key={d} value={d}>
                  {d}
                </option>
              ))}
            </select>
          </div>
          <Button variant="primary" icon="plus" busy={createBusy} disabled={!canWrite || !name.trim()} onClick={() => void create()}>
            Create
          </Button>
        </div>
      </Card>

      <div className="toolbar" style={{ marginTop: 'var(--space-4)' }}>
        <input
          type="search"
          className="search-input"
          placeholder="Filter networks"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          aria-label="Filter networks"
        />
      </div>

      <Card flush>
        {list.loading && !list.data ? (
          <SkeletonRows rows={5} cols={4} />
        ) : list.error && !list.data ? null : filtered.length === 0 ? (
          <div style={{ padding: 'var(--space-4)' }}>
            <EmptyState
              icon="network"
              title={list.data && list.data.length > 0 ? 'No networks match' : 'No networks yet'}
              action={
                list.data && list.data.length > 0 ? (
                  <Button onClick={() => setQuery('')}>Clear filter</Button>
                ) : (
                  <Button onClick={() => setName('app-net')} disabled={!canWrite}>
                    Suggest a name
                  </Button>
                )
              }
            >
              {list.data && list.data.length > 0
                ? 'Adjust the filter text to see other networks.'
                : 'Create a network to give containers a private channel.'}
            </EmptyState>
          </div>
        ) : (
          <div className="table-wrap">
            <table className="data">
              <thead>
                <tr>
                  <th>Name</th>
                  <th>Driver</th>
                  <th>Scope</th>
                  <th>Internal</th>
                  <th>Containers</th>
                  <th className="num">Actions</th>
                </tr>
              </thead>
              <tbody>
                {capped.visible.map((net) => (
                  <tr key={net.id}>
                    <td className="primary" data-label="Name">
                      {net.name}
                      <div className="dim mono-cell">{shortId(net.id)}</div>
                    </td>
                    <td data-label="Driver">{net.driver}</td>
                    <td data-label="Scope">{net.scope}</td>
                    <td data-label="Internal">
                      {net.internal ? <Pill state="paused">internal</Pill> : <span className="dim">no</span>}
                    </td>
                    <td data-label="Containers">
                      {net.containers.length === 0 ? (
                        <span className="dim">none</span>
                      ) : (
                        <span className="row" style={{ gap: 'var(--space-1)', flexWrap: 'wrap' }}>
                          {net.containers.map((c) => (
                            <Link key={c.id} to={`/containers/${c.id}`} className="tag">
                              {c.name}
                            </Link>
                          ))}
                        </span>
                      )}
                    </td>
                    <td className="cell-actions" data-label="Actions">
                      <Button
                        size="sm"
                        variant="danger"
                        icon="trash"
                        disabled={!canDestroy || pending[`${net.id}:remove`]}
                        busy={pending[`${net.id}:remove`]}
                        aria-label={`Delete network ${net.name}`}
                        title={canDestroy ? 'Delete network' : 'Requires the admin role'}
                        onClick={() => void removeNetwork(net)}
                      />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
            <RowCapNotice
              hidden={capped.hiddenCount}
              total={filtered.length}
              noun="networks"
              onShowAll={capped.showAll}
            />
          </div>
        )}
      </Card>
    </>
  );
}
