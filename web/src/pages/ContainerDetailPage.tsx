import { useState } from 'react';
import { Link, useParams, useSearchParams } from 'react-router-dom';
import { endpoints, errorMessage } from '../api/client';
import type { ContainerDetail, ContainerStats } from '../api/types';
import { usePolling } from '../hooks/usePolling';
import { useStats } from '../hooks/useStats';
import { useAuth } from '../hooks/useAuth';
import { can } from '../lib/rbac';
import { Icon } from '../components/Icons';
import { LogViewer } from '../components/LogViewer';
import { JsonView } from '../components/JsonView';
import { StatsChart } from '../components/Sparkline';
import {
  Banner,
  Button,
  Card,
  CopyButton,
  EmptyState,
  PageHead,
  Pill,
  SkeletonRows,
  Spinner,
  StatTile,
  Tabs,
  useConfirm,
} from '../components/ui';
import {
  formatBytes,
  formatDateTime,
  formatPercent,
  formatPorts,
  parseDockerTime,
  relativeTime,
  shortId,
  splitCommandLine,
} from '../lib/format';

type TabId = 'overview' | 'logs' | 'stats' | 'inspect' | 'console';
const TABS: Array<{ id: TabId; label: string }> = [
  { id: 'overview', label: 'Overview' },
  { id: 'logs', label: 'Logs' },
  { id: 'stats', label: 'Stats' },
  { id: 'inspect', label: 'Inspect' },
  { id: 'console', label: 'Console' },
];

export function ContainerDetailPage() {
  const { id = '' } = useParams();
  const [params, setParams] = useSearchParams();
  const tab = (params.get('tab') as TabId) || 'overview';
  const { user } = useAuth();
  const confirm = useConfirm();
  const canWrite = can.write(user?.role);
  const canDestroy = can.destroy(user?.role);
  // Exec needs both the operator role and the explicit capability: on a host with
  // the Docker socket mounted a shell in a container is root-equivalent.
  const canExec = canWrite && can.exec(user?.role, user?.can_exec);

  const detail = usePolling<ContainerDetail>(() => endpoints.containers.get(id), {
    intervalMs: 15000,
    deps: [id],
  });

  const [actionError, setActionError] = useState<string | null>(null);
  const [pending, setPending] = useState<Record<string, boolean>>({});

  const runAction = async (action: 'start' | 'stop' | 'restart' | 'pause' | 'unpause' | 'kill') => {
    setPending((p) => ({ ...p, [action]: true }));
    setActionError(null);
    try {
      await endpoints.containers.action(id, action);
      await detail.refresh();
    } catch (err) {
      setActionError(errorMessage(err));
    } finally {
      setPending((p) => ({ ...p, [action]: false }));
    }
  };

  const remove = async () => {
    const c = detail.data;
    if (!c) return;
    const ok = await confirm({
      title: `Remove ${c.name}?`,
      body: 'This deletes the container permanently.',
      confirmLabel: 'Remove container',
      danger: true,
      phrase: c.name,
    });
    if (!ok) return;
    setPending((p) => ({ ...p, remove: true }));
    setActionError(null);
    try {
      await endpoints.containers.remove(id, { force: true });
    } catch (err) {
      setActionError(errorMessage(err));
    } finally {
      setPending((p) => ({ ...p, remove: false }));
    }
  };

  const c = detail.data;

  if (detail.error && !c) {
    const msg = errorMessage(detail.error);
    const gone = /not_found|404/i.test(msg);
    return (
      <EmptyState
        icon="warning"
        title={gone ? 'Container not found' : 'Could not load container'}
        action={
          <Link to="/containers" className="btn">
            Back to containers
          </Link>
        }
      >
        {msg}
      </EmptyState>
    );
  }

  return (
    <>
      <PageHead
        title={
          <span className="row" style={{ gap: 'var(--space-3)' }}>
            <Link to="/containers" className="dim" aria-label="Back to containers">
              <Icon name="chevron-right" size={16} style={{ transform: 'rotate(180deg)' }} />
            </Link>
            {c ? c.name : <span className="skeleton" style={{ width: 160, height: 20 }} />}
            {c ? <Pill state={c.state} /> : null}
            {c?.managed ? <span className="tag">managed</span> : null}
          </span>
        }
        desc={
          c ? (
            <span className="row" style={{ gap: 'var(--space-2)' }}>
              <span className="mono-cell">{c.image}</span>
              <span className="dim">·</span>
              <span className="mono-cell" title={c.id}>
                {shortId(c.id, 24)}
              </span>
              <CopyButton value={c.id} label="Copy container id" />
            </span>
          ) : (
            'Loading container'
          )
        }
        actions={
          c ? (
            <>
              {c.state !== 'running' && c.state !== 'paused' ? (
                <Button icon="play" disabled={!canWrite} busy={pending.start} onClick={() => void runAction('start')}>
                  Start
                </Button>
              ) : null}
              {c.state === 'running' ? (
                <Button
                  icon="stop"
                  disabled={!canWrite}
                  busy={pending.stop}
                  onClick={async () => {
                    const ok = await confirm({ title: `Stop ${c.name}?`, confirmLabel: 'Stop', danger: true });
                    if (ok) void runAction('stop');
                  }}
                >
                  Stop
                </Button>
              ) : null}
              <Button icon="restart" disabled={!canWrite} busy={pending.restart} onClick={() => void runAction('restart')}>
                Restart
              </Button>
              {c.state === 'paused' ? (
                <Button icon="play" disabled={!canWrite} busy={pending.unpause} onClick={() => void runAction('unpause')}>
                  Resume
                </Button>
              ) : (
                <Button icon="pause" disabled={!canWrite || c.state !== 'running'} busy={pending.pause} onClick={() => void runAction('pause')}>
                  Pause
                </Button>
              )}
              <Button
                variant="danger"
                icon="close"
                disabled={!canWrite}
                busy={pending.kill}
                onClick={async () => {
                  const ok = await confirm({
                    title: `Kill ${c.name}?`,
                    body: 'SIGKILL is sent immediately.',
                    confirmLabel: 'Kill',
                    danger: true,
                  });
                  if (ok) void runAction('kill');
                }}
              >
                Kill
              </Button>
              <Button variant="danger" icon="trash" disabled={!canDestroy} busy={pending.remove} onClick={() => void remove()}>
                Remove
              </Button>
            </>
          ) : null
        }
      />

      {actionError ? (
        <Banner tone="error" title="Action failed" onDismiss={() => setActionError(null)}>
          {actionError}
        </Banner>
      ) : null}
      {detail.error && c ? (
        <Banner tone="warn" title="Refresh failed">
          {errorMessage(detail.error)}
        </Banner>
      ) : null}

      <Tabs
        tabs={TABS}
        value={tab}
        onChange={(next) => setParams(next === 'overview' ? {} : { tab: next }, { replace: true })}
      />

      {tab === 'overview' ? (
        detail.loading && !c ? (
          <Card>
            <SkeletonRows rows={8} cols={2} />
          </Card>
        ) : c ? (
          <OverviewTab detail={c} />
        ) : null
      ) : null}
      {tab === 'logs' ? <LogViewer containerId={id} /> : null}
      {tab === 'stats' ? <StatsTab containerId={id} state={c?.state} /> : null}
      {tab === 'inspect' ? <InspectTab containerId={id} /> : null}
      {tab === 'console' ? (
        <ConsoleTab containerId={id} canExec={canExec} canWrite={canWrite} />
      ) : null}
    </>
  );
}

/* ------------------------------------------------------------------ overview */

function OverviewTab({ detail }: { detail: ContainerDetail }) {
  const ports = formatPorts(detail.ports);
  const started = parseDockerTime(detail.startedAt);
  const finished = parseDockerTime(detail.finishedAt);

  return (
    <div className="stack">
      <Card title="Runtime">
        <dl className="kv">
          <dt>Image</dt>
          <dd className="mono-cell">{detail.image}</dd>
          <dt>Image id</dt>
          <dd className="mono-cell">{shortId(detail.imageId, 20)}</dd>
          <dt>Command</dt>
          <dd className="mono-cell">{detail.command || '-'}</dd>
          <dt>Entrypoint</dt>
          <dd className="mono-cell">{detail.entrypoint || '-'}</dd>
          <dt>Restart policy</dt>
          <dd>{detail.restartPolicy || '-'}</dd>
          <dt>Platform</dt>
          <dd className="mono-cell">{detail.platform || '-'}</dd>
          <dt>Created</dt>
          <dd>
            {formatDateTime(detail.created)} <span className="dim">({relativeTime(detail.created)})</span>
          </dd>
          <dt>Started</dt>
          <dd>{started ? formatDateTime(started) : '-'}</dd>
          <dt>Finished</dt>
          <dd>{finished ? formatDateTime(finished) : '-'}</dd>
          <dt>Exit code</dt>
          <dd className="tnum">{detail.exitCode === null ? '-' : detail.exitCode}</dd>
          <dt>Health</dt>
          <dd>{detail.health ? <Pill state={detail.health === 'healthy' ? 'running' : detail.health === 'unhealthy' ? 'error' : 'paused'}>{detail.health}</Pill> : <span className="dim">none</span>}</dd>
          {detail.stackId ? (
            <>
              <dt>Stack</dt>
              <dd className="mono-cell">
                <Link to="/stacks">{detail.stackId}</Link>
              </dd>
            </>
          ) : null}
          {detail.templateSlug ? (
            <>
              <dt>Template</dt>
              <dd className="mono-cell">{detail.templateSlug}</dd>
            </>
          ) : null}
        </dl>
      </Card>

      <div className="grid grid-2">
        <Card title={`Ports (${ports.length})`}>
          {ports.length === 0 ? (
            <p className="dim" style={{ fontSize: 'var(--fs-xs)', margin: 0 }}>No published ports.</p>
          ) : (
            <div className="table-wrap">
              <table className="data">
                <thead>
                  <tr>
                    <th>Host</th>
                    <th>Container</th>
                    <th>Protocol</th>
                  </tr>
                </thead>
                <tbody>
                  {detail.ports.map((p, i) => (
                    <tr key={i}>
                      <td className="mono-cell" data-label="Host">
                        {p.publicPort ? `${p.ip ?? '0.0.0.0'}:${p.publicPort}` : '-'}
                      </td>
                      <td className="mono-cell" data-label="Container">
                        {p.privatePort}
                      </td>
                      <td className="mono-cell" data-label="Protocol">
                        {p.type}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </Card>

        <Card title={`Networks (${detail.networks.length})`}>
          {detail.networks.length === 0 ? (
            <p className="dim" style={{ fontSize: 'var(--fs-xs)', margin: 0 }}>Not attached to a network.</p>
          ) : (
            <dl className="kv">
              {detail.networks.map((n) => (
                <div key={n.name} style={{ display: 'contents' }}>
                  <dt>{n.name}</dt>
                  <dd className="mono-cell">{n.ip ?? '-'}</dd>
                </div>
              ))}
            </dl>
          )}
        </Card>
      </div>

      <Card title={`Environment (${detail.env.length})`}>
        {detail.env.length === 0 ? (
          <p className="dim" style={{ fontSize: 'var(--fs-xs)', margin: 0 }}>No environment variables.</p>
        ) : (
          <div className="table-wrap">
            <table className="data">
              <tbody>
                {detail.env.map((e, i) => {
                  const eq = e.indexOf('=');
                  const key = eq >= 0 ? e.slice(0, eq) : e;
                  const val = eq >= 0 ? e.slice(eq + 1) : '';
                  const secret = /token|password|secret|key|authorization/i.test(key);
                  return (
                    <tr key={i}>
                      <td className="primary mono-cell" style={{ width: 240 }} data-label="Key">
                        {key}
                      </td>
                      <td className="mono-cell" data-label="Value">
                        {secret ? <span className="dim">masked</span> : val}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </Card>

      <Card title={`Mounts (${detail.mounts.length})`}>
        {detail.mounts.length === 0 ? (
          <p className="dim" style={{ fontSize: 'var(--fs-xs)', margin: 0 }}>No mounts.</p>
        ) : (
          <div className="table-wrap">
            <table className="data">
              <thead>
                <tr>
                  <th>Type</th>
                  <th>Source</th>
                  <th>Destination</th>
                  <th>Mode</th>
                </tr>
              </thead>
              <tbody>
                {detail.mounts.map((m, i) => (
                  <tr key={i}>
                    <td data-label="Type">{m.type}</td>
                    <td className="mono-cell" data-label="Source">
                      <span className="truncate" title={m.source}>{m.source}</span>
                    </td>
                    <td className="mono-cell" data-label="Destination">{m.destination}</td>
                    <td className="mono-cell" data-label="Mode">
                      {m.mode}
                      {m.rw ? '' : ' (ro)'}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>

      {Object.keys(detail.labels).length > 0 ? (
        <Card title={`Labels (${Object.keys(detail.labels).length})`}>
          <dl className="kv">
            {Object.entries(detail.labels).map(([k, v]) => (
              <div key={k} style={{ display: 'contents' }}>
                <dt className="mono-cell">{k}</dt>
                <dd className="mono-cell">{v}</dd>
              </div>
            ))}
          </dl>
        </Card>
      ) : null}
    </div>
  );
}

/* --------------------------------------------------------------------- stats */

function StatsTab({ containerId, state }: { containerId: string; state?: string }) {
  const { latest, history, status } = useStats(containerId, { enabled: true });

  if (state && state !== 'running' && state !== 'paused' && history.length === 0) {
    return (
      <EmptyState icon="activity" title="No live stats">
        The container is not running, so the stats stream has nothing to report. Start it to see CPU and
        memory.
      </EmptyState>
    );
  }

  const cpu = history.map((h) => h.cpuPercent);
  const mem = history.map((h) => h.memPercent);
  const s: ContainerStats | null = latest;

  return (
    <div className="stack">
      <div className="row" style={{ justifyContent: 'space-between' }}>
        <span className="dim" style={{ fontSize: 'var(--fs-micro)' }}>
          {history.length} samples · updated every 1500 ms
        </span>
        <Pill state={status === 'open' ? 'running' : status === 'connecting' ? 'starting' : 'error'}>{status}</Pill>
      </div>

      <div className="grid grid-4">
        <StatTile label="CPU" value={s ? formatPercent(s.cpuPercent) : '-'} meta={s ? s.readAt && relativeTime(s.readAt) : 'waiting'} />
        <StatTile
          label="Memory"
          value={s ? formatPercent(s.memPercent) : '-'}
          meta={s ? `${formatBytes(s.memUsed)} / ${formatBytes(s.memLimit)}` : 'waiting'}
        />
        <StatTile label="PIDs" value={s ? s.pids : '-'} meta="processes" />
        <StatTile label="Network" value={s ? `${formatBytes(s.netRx)} in` : '-'} meta={s ? `${formatBytes(s.netTx)} out` : 'waiting'} />
      </div>

      <Card title="CPU and memory">
        {history.length < 2 ? (
          <div style={{ padding: 'var(--space-4)' }}>
            <Spinner label="Collecting samples" />
          </div>
        ) : (
          <StatsChart cpu={cpu} mem={mem} />
        )}
      </Card>

      <Card title="I/O">
        <dl className="kv">
          <dt>Block read</dt>
          <dd className="tnum">{s ? formatBytes(s.blkRead) : '-'}</dd>
          <dt>Block write</dt>
          <dd className="tnum">{s ? formatBytes(s.blkWrite) : '-'}</dd>
          <dt>Network received</dt>
          <dd className="tnum">{s ? formatBytes(s.netRx) : '-'}</dd>
          <dt>Network sent</dt>
          <dd className="tnum">{s ? formatBytes(s.netTx) : '-'}</dd>
          <dt>Sample time</dt>
          <dd className="mono-cell">{s ? s.readAt : '-'}</dd>
        </dl>
      </Card>
    </div>
  );
}

/* ------------------------------------------------------------------- inspect */

function InspectTab({ containerId }: { containerId: string }) {
  const inspect = usePolling<Record<string, unknown>>(() => endpoints.containers.inspect(containerId), {
    deps: [containerId],
  });
  if (inspect.loading && !inspect.data) {
    return (
      <Card>
        <SkeletonRows rows={10} cols={2} />
      </Card>
    );
  }
  if (inspect.error) {
    return (
      <Banner tone="error" title="Inspect failed">
        {errorMessage(inspect.error)}
      </Banner>
    );
  }
  return (
    <Card title="Raw inspect" actions={<Button size="sm" icon="refresh" busy={inspect.refreshing} onClick={() => void inspect.refresh()}>Refresh</Button>}>
      <JsonView value={inspect.data} />
    </Card>
  );
}

/* ------------------------------------------------------------------- console */

type ExecResult = { cmd: string[]; stdout: string; stderr: string; exitCode: number };

function ConsoleTab({
  containerId,
  canExec,
  canWrite,
}: {
  containerId: string;
  canExec: boolean;
  canWrite: boolean;
}) {
  const [input, setInput] = useState('');
  const [results, setResults] = useState<ExecResult[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const run = async () => {
    const cmd = splitCommandLine(input);
    if (cmd.length === 0) return;
    setBusy(true);
    setError(null);
    try {
      const res = await endpoints.containers.exec(containerId, cmd);
      setResults((prev) => [...prev, { cmd, ...res }].slice(-50));
      setInput('');
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="stack">
      {error ? <Banner tone="error" title="Command failed">{error}</Banner> : null}
      {!canExec ? (
        <Banner tone="warn" title="Exec not enabled">
          {canWrite
            ? 'Running commands in a container is disabled for this account. An administrator can enable it under Settings.'
            : 'Running commands in a container requires the operator role.'}
        </Banner>
      ) : null}

      <Card title="Exec console" flush>
        <div className="dialog-body" style={{ maxHeight: 460 }}>
          {results.length === 0 ? (
            <p className="dim" style={{ fontSize: 'var(--fs-xs)', margin: 0 }}>
              Run a command in this container. Output is captured and returned when the command exits.
            </p>
          ) : (
            <div className="console-out" style={{ minHeight: 0, maxHeight: 'none', border: 'none', padding: 0 }}>
              {results.map((r, i) => (
                <div key={i} style={{ marginBottom: 'var(--space-3)' }}>
                  <div className="cmd">$ {r.cmd.join(' ')}</div>
                  {r.stdout ? <div>{r.stdout.replace(/\n$/, '')}</div> : null}
                  {r.stderr ? <div className="err">{r.stderr.replace(/\n$/, '')}</div> : null}
                  <div className="exit">exit {r.exitCode}</div>
                </div>
              ))}
            </div>
          )}
        </div>
        <div className="dialog-foot" style={{ justifyContent: 'stretch' }}>
          <input
            type="text"
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') void run();
            }}
            placeholder="sh -c 'ls -la /'"
            aria-label="Command"
            disabled={!canExec || busy}
            className="mono"
            style={{ flex: 1 }}
          />
          <Button variant="primary" icon="play" busy={busy} disabled={!canExec || !input.trim()} onClick={() => void run()}>
            Run
          </Button>
        </div>
      </Card>
      <p className="dim" style={{ fontSize: 'var(--fs-micro)' }}>
        <Icon name="info" size={12} /> Commands run without a TTY and are killed after the server timeout.
      </p>
    </div>
  );
}
