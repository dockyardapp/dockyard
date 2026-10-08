import { Link } from 'react-router-dom';
import { endpoints, errorMessage } from '../api/client';
import type { AuditEntry, ContainerSummary, SystemInfo, Tunnel } from '../api/types';
import { usePolling } from '../hooks/usePolling';
import { useEvents } from '../hooks/useEvents';
import { useAuth } from '../hooks/useAuth';
import { can } from '../lib/rbac';
import { Icon } from '../components/Icons';
import {
  Banner,
  Card,
  CopyField,
  EmptyState,
  PageHead,
  Pill,
  SkeletonRows,
  StatTile,
} from '../components/ui';
import { formatCount, formatDateTime, formatDuration, relativeTime } from '../lib/format';

export function DashboardPage() {
  const { user } = useAuth();
  const isAdmin = can.viewAudit(user?.role);

  const info = usePolling<SystemInfo>(() => endpoints.system.info(), { intervalMs: 15000 });
  const containers = usePolling<ContainerSummary[]>(() => endpoints.containers.list({ all: true }), {
    intervalMs: 15000,
  });
  const tunnels = usePolling<Tunnel[]>(() => endpoints.tunnels.list(), { intervalMs: 10000 });
  const audit = usePolling<AuditEntry[]>(() => endpoints.audit.list({ limit: 8 }), {
    enabled: isAdmin,
    intervalMs: 20000,
  });

  useEvents(() => {
    void info.refresh();
    void containers.refresh();
    void tunnels.refresh();
    if (isAdmin) void audit.refresh();
  });

  const d = info.data;
  const running = (containers.data ?? []).filter((c) => c.state === 'running');
  const activeTunnels = (tunnels.data ?? []).filter((t) => t.status === 'running');

  return (
    <>
      <PageHead
        title="Dashboard"
        desc={d ? `Dockyard ${d.version} · ${formatDuration(d.uptime)} uptime` : 'Host and workload overview'}
      />

      {info.error ? (
        <Banner tone="error" title="Cannot read host status">
          {errorMessage(info.error)}
        </Banner>
      ) : null}

      {d && d.mode === 'demo' ? (
        <Banner tone="warn" title="Demo mode">
          The Docker engine is unreachable, so counts are reported from a placeholder. Start Docker and
          reload to see real data.
        </Banner>
      ) : null}

      <div className="grid grid-4">
        <StatTile
          label="Containers"
          value={
            info.loading && !d ? '-' : (
              <>
                {formatCount(d?.counts.running ?? 0)} <small>/ {formatCount(d?.counts.containers ?? 0)}</small>
              </>
            )
          }
          meta="running / total"
        />
        <StatTile label="Images" value={info.loading && !d ? '-' : formatCount(d?.counts.images ?? 0)} meta="local images" />
        <StatTile label="Volumes" value={info.loading && !d ? '-' : formatCount(d?.counts.volumes ?? 0)} meta="named volumes" />
        <StatTile label="Networks" value={info.loading && !d ? '-' : formatCount(d?.counts.networks ?? 0)} meta="docker networks" />
        <StatTile label="Stacks" value={info.loading && !d ? '-' : formatCount(d?.counts.stacks ?? 0)} meta="deployed stacks" />
        <StatTile
          label="Tunnels"
          value={
            info.loading && !d ? '-' : (
              <>
                {formatCount(d?.counts.tunnelsActive ?? 0)} <small>/ {formatCount(d?.counts.tunnels ?? 0)}</small>
              </>
            )
          }
          meta="active / total"
        />
        <StatTile label="Templates" value={info.loading && !d ? '-' : formatCount(d?.counts.templates ?? 0)} meta="available" />
        <StatTile
          label="Docker engine"
          value={d ? (d.docker.ok ? (d.docker.version ?? 'ok') : 'down') : '-'}
          meta={d?.docker.os ? `${d.docker.os} · ${d.docker.arch ?? ''}` : 'version'}
        />
      </div>

      <div className="grid grid-2" style={{ marginTop: 'var(--space-4)' }}>
        <Card title="Host status">
          {info.loading && !d ? (
            <SkeletonRows rows={4} cols={2} />
          ) : d ? (
            <dl className="kv">
              <dt>Docker</dt>
              <dd>
                {d.docker.ok ? (
                  <span className="row" style={{ gap: 'var(--space-2)' }}>
                    <Icon name="check" size={13} style={{ color: 'var(--state-running-fg)' }} />
                    {d.docker.version ?? 'connected'}
                    {d.docker.apiVersion ? <span className="dim">api {d.docker.apiVersion}</span> : null}
                  </span>
                ) : (
                  <span className="row" style={{ gap: 'var(--space-2)', color: 'var(--state-error-fg)' }}>
                    <Icon name="warning" size={13} /> {d.docker.error ?? 'unavailable'}
                  </span>
                )}
              </dd>
              <dt>Database</dt>
              <dd>{d.db.ok ? d.db.serverVersion ?? 'connected' : d.db.error ?? 'unavailable'}</dd>
              <dt>cloudflared</dt>
              <dd className="mono-cell">
                {d.cloudflared.ok ? d.cloudflared.version ?? d.cloudflared.path : d.cloudflared.error ?? 'not found'}
              </dd>
              <dt>Cloudflare account</dt>
              <dd>
                {d.cloudflare.configured ? (
                  <span className="row" style={{ gap: 'var(--space-2)' }}>
                    <Pill state={d.cloudflare.verified ? 'running' : 'paused'}>
                      {d.cloudflare.verified ? 'verified' : 'unverified'}
                    </Pill>
                    <span className="mono-cell">{d.cloudflare.accountId ?? '-'}</span>
                  </span>
                ) : (
                  'not configured'
                )}
              </dd>
              <dt>Public URL</dt>
              <dd>
                {d.publicUrl ? <CopyField value={d.publicUrl} /> : <span className="dim">not set</span>}
              </dd>
            </dl>
          ) : null}
        </Card>

        <Card
          title={`Running containers (${running.length})`}
          actions={
            <Link className="dim" to="/containers" style={{ fontSize: 'var(--fs-micro)' }}>
              View all
            </Link>
          }
        >
          {containers.loading && !containers.data ? (
            <SkeletonRows rows={5} cols={3} />
          ) : running.length === 0 ? (
            <EmptyState
              icon="container"
              title="No containers are running"
              action={
                <Link to="/templates" className="btn btn-primary">
                  Deploy from a template
                </Link>
              }
            >
              Start a container from the containers list, or deploy a template to create one.
            </EmptyState>
          ) : (
            <div className="table-wrap">
              <table className="data">
                <thead>
                  <tr>
                    <th>Name</th>
                    <th>Image</th>
                    <th>Status</th>
                    <th className="num">Created</th>
                  </tr>
                </thead>
                <tbody>
                  {running.slice(0, 8).map((c) => (
                    <tr key={c.id}>
                      <td className="primary" data-label="Name">
                        <Link to={`/containers/${c.id}`} className="truncate" style={{ maxWidth: 200 }} title={c.name}>
                          {c.name}
                        </Link>
                      </td>
                      <td className="mono-cell" data-label="Image">
                        <span className="truncate" title={c.image}>
                          {c.image}
                        </span>
                      </td>
                      <td data-label="Status">
                        <Pill state={c.state} />
                      </td>
                      <td className="num dim" data-label="Created">
                        {relativeTime(c.created)}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </Card>
      </div>

      <div className="grid grid-2" style={{ marginTop: 'var(--space-4)' }}>
        <Card
          title={`Active tunnels (${activeTunnels.length})`}
          actions={
            <Link className="dim" to="/tunnels" style={{ fontSize: 'var(--fs-micro)' }}>
              Manage
            </Link>
          }
        >
          {tunnels.loading && !tunnels.data ? (
            <SkeletonRows rows={3} cols={3} />
          ) : activeTunnels.length === 0 ? (
            <EmptyState icon="tunnel" title="No active tunnels" action={<Link to="/tunnels" className="btn">Create a tunnel</Link>}>
              Expose a container port or a URL through Cloudflare.
            </EmptyState>
          ) : (
            <div className="table-wrap">
              <table className="data">
                <thead>
                  <tr>
                    <th>Name</th>
                    <th>Mode</th>
                    <th>URL</th>
                  </tr>
                </thead>
                <tbody>
                  {activeTunnels.map((t) => (
                    <tr key={t.id}>
                      <td className="primary" data-label="Name">
                        {t.name}
                      </td>
                      <td data-label="Mode">
                        <span className="tag">{t.mode}</span>
                      </td>
                      <td className="mono-cell" data-label="URL">
                        {t.url ? <a href={t.url} target="_blank" rel="noreferrer">{t.url}</a> : <span className="dim">pending</span>}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </Card>

        {isAdmin ? (
          <Card
            title="Recent activity"
            actions={
              <Link className="dim" to="/audit" style={{ fontSize: 'var(--fs-micro)' }}>
                Full audit log
              </Link>
            }
          >
            {audit.loading && !audit.data ? (
              <SkeletonRows rows={5} cols={3} />
            ) : (audit.data ?? []).length === 0 ? (
              <EmptyState icon="audit" title="No audit entries yet">
                Actions you take in the console will appear here.
              </EmptyState>
            ) : (
              <div className="table-wrap">
                <table className="data">
                  <thead>
                    <tr>
                      <th>When</th>
                      <th>Action</th>
                      <th>Target</th>
                      <th>User</th>
                    </tr>
                  </thead>
                  <tbody>
                    {(audit.data ?? []).map((a) => (
                      <tr key={a.id}>
                        <td className="dim nowrap" data-label="When" title={formatDateTime(a.created_at)}>
                          {relativeTime(a.created_at)}
                        </td>
                        <td className="mono-cell" data-label="Action">
                          {a.action}
                        </td>
                        <td className="mono-cell" data-label="Target">
                          {a.target_type}
                          {a.target_id ? <span className="dim">:{a.target_id.slice(0, 12)}</span> : null}
                        </td>
                        <td className="dim" data-label="User">
                          {a.user_email ?? 'system'}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </Card>
        ) : null}
      </div>
    </>
  );
}
