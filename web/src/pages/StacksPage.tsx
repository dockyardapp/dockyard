import { useState } from 'react';
import { Link } from 'react-router-dom';
import { endpoints, errorMessage } from '../api/client';
import type { StackWithContainers } from '../api/types';
import { usePolling } from '../hooks/usePolling';
import { useRowCap } from '../hooks/useRowCap';
import { RowCapNotice } from '../components/RowCapNotice';
import { useEvents } from '../hooks/useEvents';
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
  useConfirm,
} from '../components/ui';
import { formatDateTime, pluralize } from '../lib/format';

export function StacksPage() {
  const { user } = useAuth();
  const confirm = useConfirm();
  const canWrite = can.write(user?.role);
  const canDestroy = can.destroy(user?.role);

  const [pending, setPending] = useState<Record<string, boolean>>({});
  const [error, setError] = useState<string | null>(null);

  const list = usePolling<StackWithContainers[]>(() => endpoints.stacks.list(), { intervalMs: 15000 });
  const stacks = list.data ?? [];
  const capped = useRowCap(stacks);

  useEvents((ev) => {
    if (ev.type === 'stack' || ev.type === 'container') void list.refresh();
  });

  const runAction = async (id: string, action: 'start' | 'stop') => {
    const key = `${id}:${action}`;
    setPending((p) => ({ ...p, [key]: true }));
    setError(null);
    try {
      await endpoints.stacks.action(id, action);
      await list.refresh();
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setPending((p) => ({ ...p, [key]: false }));
    }
  };

  const removeStack = async (stack: StackWithContainers) => {
    const ok = await confirm({
      title: `Remove stack ${stack.name}?`,
      body: `${pluralize(stack.containers.length, 'container')} will be removed. Volumes are kept unless you choose otherwise.`,
      confirmLabel: 'Remove stack',
      danger: true,
      phrase: stack.name,
    });
    if (!ok) return;
    setPending((p) => ({ ...p, [`${stack.id}:remove`]: true }));
    setError(null);
    try {
      await endpoints.stacks.remove(stack.id, { volumes: false });
      await list.refresh();
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setPending((p) => ({ ...p, [`${stack.id}:remove`]: false }));
    }
  };

  return (
    <>
      <PageHead
        title="Stacks"
        desc={list.data ? pluralize(list.data.length, 'stack') : 'Groups of containers deployed from templates'}
        actions={
          <Button icon="refresh" busy={list.refreshing} onClick={() => void list.refresh()}>
            Refresh
          </Button>
        }
      />

      {error ? (
        <Banner tone="error" title="Stack action failed" onDismiss={() => setError(null)}>
          {error}
        </Banner>
      ) : null}
      {list.error ? (
        <Banner tone="error" title="Could not load stacks" onDismiss={() => void list.refresh()}>
          {errorMessage(list.error)}
        </Banner>
      ) : null}

      {list.loading && !list.data ? (
        <Card>
          <SkeletonRows rows={4} cols={4} />
        </Card>
      ) : list.error && !list.data ? null : (list.data ?? []).length === 0 ? (
        <EmptyState
          icon="stack"
          title="No stacks yet"
          action={
            <Link to="/templates" className="btn btn-primary">
              Deploy a template
            </Link>
          }
        >
          A stack is created when you deploy a template. It groups the container with its template values.
        </EmptyState>
      ) : (
        <div className="stack">
          {capped.visible.map((stack) => {
            const running = stack.containers.filter((c) => c.state === 'running').length;
            return (
              <Card
                key={stack.id}
                title={
                  <span className="row" style={{ gap: 'var(--space-2)' }}>
                    <h2>{stack.name}</h2>
                    <Pill state={stack.status} />
                    {stack.template_slug ? <span className="tag">{stack.template_slug}</span> : null}
                  </span>
                }
                actions={
                  <>
                    <Button
                      size="sm"
                      icon="play"
                      disabled={!canWrite || pending[`${stack.id}:start`]}
                      busy={pending[`${stack.id}:start`]}
                      onClick={() => void runAction(stack.id, 'start')}
                    >
                      Start
                    </Button>
                    <Button
                      size="sm"
                      icon="stop"
                      disabled={!canWrite || pending[`${stack.id}:stop`]}
                      busy={pending[`${stack.id}:stop`]}
                      onClick={async () => {
                        const ok = await confirm({
                          title: `Stop stack ${stack.name}?`,
                          body: 'Every container in the stack is stopped.',
                          confirmLabel: 'Stop stack',
                          danger: true,
                        });
                        if (ok) void runAction(stack.id, 'stop');
                      }}
                    >
                      Stop
                    </Button>
                    <Button
                      size="sm"
                      variant="danger"
                      icon="trash"
                      disabled={!canDestroy || pending[`${stack.id}:remove`]}
                      busy={pending[`${stack.id}:remove`]}
                      title={canDestroy ? 'Remove stack' : 'Requires the admin role'}
                      onClick={() => void removeStack(stack)}
                    >
                      Remove
                    </Button>
                  </>
                }
              >
                <div className="row" style={{ gap: 'var(--space-4)', marginBottom: 'var(--space-3)', fontSize: 'var(--fs-micro)' }}>
                  <span className="dim">{running} of {stack.containers.length} running</span>
                  <span className="dim">created {formatDateTime(stack.created_at)}</span>
                  <span className="dim">updated {formatDateTime(stack.updated_at)}</span>
                </div>
                {stack.containers.length === 0 ? (
                  <p className="dim" style={{ fontSize: 'var(--fs-xs)', margin: 0 }}>
                    No containers are linked to this stack yet.
                  </p>
                ) : (
                  <div className="table-wrap">
                    <table className="data">
                      <thead>
                        <tr>
                          <th>Container</th>
                          <th>Image</th>
                          <th>State</th>
                          <th className="num">Open</th>
                        </tr>
                      </thead>
                      <tbody>
                        {stack.containers.map((c) => (
                          <tr key={c.id}>
                            <td className="primary" data-label="Container">
                              <Link to={`/containers/${c.id}`}>{c.name}</Link>
                            </td>
                            <td className="mono-cell" data-label="Image">
                              <span className="truncate" title={c.image}>{c.image}</span>
                            </td>
                            <td data-label="State">
                              <Pill state={c.state} />
                            </td>
                            <td className="num" data-label="Open">
                              <Link to={`/containers/${c.id}`}>Details</Link>
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                )}
              </Card>
            );
          })}
        </div>
      )}

      <RowCapNotice
        hidden={capped.hiddenCount}
        total={stacks.length}
        noun="stacks"
        onShowAll={capped.showAll}
      />
    </>
  );
}
