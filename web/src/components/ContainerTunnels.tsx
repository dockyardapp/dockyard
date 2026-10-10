/**
 * Routing for one container: the ports it publishes, and the tunnels that expose them.
 *
 * This is where a tunnel belongs. A tunnel exists to reach one container port, so the container is
 * the only place the decision makes sense, and the dedicated tunnels page meant picking a container
 * from a dropdown on a screen that had nothing else to do with it.
 *
 * A tunnel can still target a raw URL the panel can reach, for something not in Docker. That one has
 * no container to live under, so it is only reachable from the dashboard's active list.
 */

import { useMemo, useState } from 'react';
import { endpoints, errorMessage } from '../api/client';
import type { CloudflareStatus, Tunnel } from '../api/types';
import { usePolling } from '../hooks/usePolling';
import { useEvents } from '../hooks/useEvents';
import {
  Banner,
  Button,
  Card,
  CopyButton,
  Dialog,
  EmptyState,
  Pill,
  SkeletonRows,
  useConfirm,
} from './ui';
import { TunnelModesGuide } from './TunnelModesGuide';
import { CreateTunnelDrawer, type PortBinding } from './CreateTunnelDrawer';

export function ContainerTunnels({
  containerId,
  containerName,
  ports,
  canWrite,
  canDestroy,
  isAdmin,
}: {
  containerId: string;
  containerName: string;
  ports: PortBinding[];
  canWrite: boolean;
  canDestroy: boolean;
  isAdmin: boolean;
}) {
  const confirm = useConfirm();
  const [pending, setPending] = useState<Record<string, boolean>>({});
  const [error, setError] = useState<string | null>(null);
  const [createOpen, setCreateOpen] = useState(false);
  const [seedPort, setSeedPort] = useState<number | null>(null);
  const [guideOpen, setGuideOpen] = useState(false);

  const list = usePolling<Tunnel[]>(() => endpoints.tunnels.list(), { intervalMs: 5000 });
  // Named tunnels need a verified Cloudflare account, and only an admin can read that.
  const cf = usePolling<CloudflareStatus>(() => endpoints.cloudflare.status(), {
    enabled: isAdmin,
    intervalMs: 30000,
  });

  useEvents((ev) => {
    if (ev.type === 'tunnel') void list.refresh();
  });

  const published = useMemo(() => ports.filter((p) => p.publicPort), [ports]);
  const mine = useMemo(
    () => (list.data ?? []).filter((t) => t.container_id === containerId),
    [list.data, containerId],
  );

  const runAction = async (id: string, action: 'start' | 'stop') => {
    const key = `${id}:${action}`;
    setPending((p) => ({ ...p, [key]: true }));
    setError(null);
    try {
      await endpoints.tunnels.action(id, action);
      await list.refresh();
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setPending((p) => ({ ...p, [key]: false }));
    }
  };

  const removeTunnel = async (t: Tunnel) => {
    const ok = await confirm({
      title: `Delete tunnel ${t.name}?`,
      body: 'The tunnel is stopped and removed from the database. A named Cloudflare tunnel keeps its DNS record.',
      confirmLabel: 'Delete tunnel',
      danger: true,
    });
    if (!ok) return;
    setPending((p) => ({ ...p, [`${t.id}:remove`]: true }));
    setError(null);
    try {
      await endpoints.tunnels.remove(t.id);
      await list.refresh();
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setPending((p) => ({ ...p, [`${t.id}:remove`]: false }));
    }
  };

  const openDrawer = (port?: number) => {
    setSeedPort(port ?? null);
    setCreateOpen(true);
  };

  return (
    <>
      {error ? (
        <Banner tone="error" title="Tunnel action failed" onDismiss={() => setError(null)}>
          {error}
        </Banner>
      ) : null}
      {list.error ? (
        <Banner tone="error" title="Could not load tunnels" onDismiss={() => void list.refresh()}>
          {errorMessage(list.error)}
        </Banner>
      ) : null}

      <Card title={`Published ports (${published.length})`}>
        {published.length === 0 ? (
          <p className="dim" style={{ fontSize: 'var(--fs-xs)', margin: 0 }}>
            This container publishes no port, so there is nothing on it to expose. A tunnel can still
            point at a raw URL the panel can reach.
          </p>
        ) : (
          <div className="table-wrap">
            <table className="data">
              <thead>
                <tr>
                  <th>Host port</th>
                  <th>Container port</th>
                  <th>Protocol</th>
                  <th className="num">Expose</th>
                </tr>
              </thead>
              <tbody>
                {published.map((p) => (
                  <tr key={`${p.ip ?? 'any'}:${p.publicPort}->${p.privatePort}/${p.type}`}>
                    <td className="mono-cell primary" data-label="Host port">
                      {p.publicPort}
                    </td>
                    <td className="mono-cell" data-label="Container port">
                      {p.privatePort}
                    </td>
                    <td className="mono-cell dim" data-label="Protocol">
                      {p.type}
                    </td>
                    <td className="cell-actions" data-label="Expose">
                      <Button
                        size="sm"
                        icon="tunnel"
                        disabled={!canWrite}
                        title={canWrite ? undefined : 'Requires the operator role'}
                        onClick={() => openDrawer(p.publicPort)}
                      >
                        Expose
                      </Button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>

      <Card
        title={`Tunnels (${mine.length})`}
        actions={
          <>
            <Button size="sm" icon="info" onClick={() => setGuideOpen(true)}>
              How it works
            </Button>
            {/* With nothing exposed yet the empty state carries the action, so the header does not
                repeat it: two buttons with the same label is the same affordance twice. */}
            {mine.length > 0 ? (
              <Button
                size="sm"
                variant="primary"
                icon="plus"
                disabled={!canWrite}
                title={canWrite ? undefined : 'Requires the operator role'}
                onClick={() => openDrawer()}
              >
                Expose a port
              </Button>
            ) : null}
          </>
        }
      >
        {list.loading && !list.data ? (
          <SkeletonRows rows={2} cols={4} />
        ) : mine.length === 0 ? (
          <EmptyState
            icon="tunnel"
            title="Nothing exposed from this container yet"
            action={
              <Button variant="primary" icon="plus" disabled={!canWrite} onClick={() => openDrawer()}>
                Expose a port
              </Button>
            }
          >
            {published.length === 0
              ? 'This container has no published port. A quick or localtunnel tunnel needs no Cloudflare account.'
              : 'A quick or localtunnel tunnel needs no Cloudflare account. A named tunnel gives you a stable hostname on your own domain.'}
          </EmptyState>
        ) : (
          <div className="table-wrap">
            <table className="data">
              <thead>
                <tr>
                  <th>Name</th>
                  <th>Mode</th>
                  <th>Status</th>
                  <th>URL</th>
                  <th className="num">Actions</th>
                </tr>
              </thead>
              <tbody>
                {mine.map((t) => (
                  <tr key={t.id}>
                    <td className="primary" data-label="Name">
                      {t.name}
                      {t.auto_start ? (
                        <div className="dim" style={{ fontSize: 'var(--fs-micro)' }}>
                          auto-start
                        </div>
                      ) : null}
                    </td>
                    <td data-label="Mode">
                      <span className="tag">{t.mode}</span>
                      {t.port ? <div className="mono-cell dim">port {t.port}</div> : null}
                    </td>
                    <td data-label="Status">
                      <Pill state={t.status} />
                      {t.last_error ? (
                        <div className="dim" style={{ fontSize: 'var(--fs-micro)', maxWidth: 220 }} title={t.last_error}>
                          <span className="truncate">{t.last_error}</span>
                        </div>
                      ) : null}
                    </td>
                    <td data-label="URL">
                      {t.url ? (
                        <span className="row" style={{ gap: 'var(--space-2)' }}>
                          <a href={t.url} target="_blank" rel="noreferrer" className="mono-cell">
                            {t.url}
                          </a>
                          <CopyButton value={t.url} label="Copy tunnel URL" />
                        </span>
                      ) : (
                        <span className="dim">{t.status === 'starting' ? 'assigning' : 'not assigned'}</span>
                      )}
                      {t.hostname ? <div className="mono-cell dim">{t.hostname}</div> : null}
                    </td>
                    <td className="cell-actions" data-label="Actions">
                      {t.status === 'running' || t.status === 'starting' ? (
                        <Button
                          size="sm"
                          icon="stop"
                          disabled={!canWrite || pending[`${t.id}:stop`]}
                          busy={pending[`${t.id}:stop`]}
                          onClick={() => void runAction(t.id, 'stop')}
                        >
                          Stop
                        </Button>
                      ) : (
                        <Button
                          size="sm"
                          icon="play"
                          disabled={!canWrite || pending[`${t.id}:start`]}
                          busy={pending[`${t.id}:start`]}
                          onClick={() => void runAction(t.id, 'start')}
                        >
                          Start
                        </Button>
                      )}
                      <Button
                        size="sm"
                        variant="danger"
                        icon="trash"
                        disabled={!canDestroy || pending[`${t.id}:remove`]}
                        busy={pending[`${t.id}:remove`]}
                        title={canDestroy ? 'Delete tunnel' : 'Requires the admin role'}
                        onClick={() => void removeTunnel(t)}
                      >
                        Delete
                      </Button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>

      <CreateTunnelDrawer
        open={createOpen}
        onClose={() => setCreateOpen(false)}
        onCreated={() => {
          setCreateOpen(false);
          void list.refresh();
        }}
        namedReady={cf.data?.verified ?? false}
        zones={cf.data?.zones ?? []}
        target={{ id: containerId, name: containerName, ports }}
        initialPort={seedPort}
      />

      <Dialog
        open={guideOpen}
        onClose={() => setGuideOpen(false)}
        title="How tunnels work"
        width={760}
        footer={
          <Button onClick={() => setGuideOpen(false)}>Close</Button>
        }
      >
        <TunnelModesGuide />
      </Dialog>
    </>
  );
}
