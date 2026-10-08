import { useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { endpoints, errorMessage } from '../api/client';
import type { ContainerSummary, CreateContainerInput, NetworkSummary } from '../api/types';
import { usePolling } from '../hooks/usePolling';
import { useRowCap } from '../hooks/useRowCap';
import { RowCapNotice } from '../components/RowCapNotice';
import { useEvents } from '../hooks/useEvents';
import { useAuth } from '../hooks/useAuth';
import { can } from '../lib/rbac';
import { Icon } from '../components/Icons';
import {
  Banner,
  Button,
  Card,
  Dialog,
  EmptyState,
  Field,
  PageHead,
  Pill,
  SkeletonRows,
  TextField,
  useConfirm,
} from '../components/ui';
import { formatDateTime, formatPorts, matchesQuery, shortId } from '../lib/format';

type Action = 'start' | 'stop' | 'restart' | 'pause' | 'unpause' | 'kill';

const STATE_FILTERS = ['all', 'running', 'exited', 'paused', 'created'] as const;
type StateFilter = (typeof STATE_FILTERS)[number];

export function ContainersPage() {
  const { user } = useAuth();
  const confirm = useConfirm();
  const canWrite = can.write(user?.role);
  const canDestroy = can.destroy(user?.role);

  const [query, setQuery] = useState('');
  const [stateFilter, setStateFilter] = useState<StateFilter>('all');
  const [showAll, setShowAll] = useState(true);
  const [pending, setPending] = useState<Record<string, boolean>>({});
  const [actionError, setActionError] = useState<string | null>(null);
  const [createOpen, setCreateOpen] = useState(false);

  const list = usePolling<ContainerSummary[]>(() => endpoints.containers.list({ all: showAll }), {
    intervalMs: 10000,
    deps: [showAll],
  });

  useEvents((ev) => {
    if (ev.type === 'container') void list.refresh();
  });

  const filtered = useMemo(() => {
    const rows = list.data ?? [];
    return rows.filter(
      (c) =>
        (stateFilter === 'all' || c.state === stateFilter) &&
        matchesQuery(query, c.name, c.image, c.id, c.status),
    );
  }, [list.data, query, stateFilter]);

  const capped = useRowCap(filtered);

  const setBusy = (key: string, value: boolean) =>
    setPending((p) => ({ ...p, [key]: value }));

  const runAction = async (id: string, action: Action) => {
    const key = `${id}:${action}`;
    setBusy(key, true);
    setActionError(null);
    try {
      await endpoints.containers.action(id, action);
      await list.refresh();
    } catch (err) {
      setActionError(errorMessage(err));
    } finally {
      setBusy(key, false);
    }
  };

  const runRemove = async (c: ContainerSummary) => {
    const ok = await confirm({
      title: `Remove ${c.name}?`,
      body: 'This deletes the container. It cannot be undone.',
      confirmLabel: 'Remove container',
      danger: true,
      phrase: c.name,
    });
    if (!ok) return;
    const key = `${c.id}:remove`;
    setBusy(key, true);
    setActionError(null);
    try {
      await endpoints.containers.remove(c.id, { force: true, volumes: false });
      await list.refresh();
    } catch (err) {
      setActionError(errorMessage(err));
    } finally {
      setBusy(key, false);
    }
  };

  return (
    <>
      <PageHead
        title="Containers"
        desc={list.data ? `${filtered.length} of ${list.data.length} shown` : 'All containers on the host'}
        actions={
          <>
            <Button icon="refresh" busy={list.refreshing} onClick={() => void list.refresh()}>
              Refresh
            </Button>
            <Button
              variant="primary"
              icon="plus"
              disabled={!canWrite}
              title={canWrite ? undefined : 'Requires the operator role'}
              onClick={() => setCreateOpen(true)}
            >
              Run container
            </Button>
          </>
        }
      />

      {actionError ? (
        <Banner tone="error" title="Action failed" onDismiss={() => setActionError(null)}>
          {actionError}
        </Banner>
      ) : null}
      {list.error ? (
        <Banner tone="error" title="Could not load containers" onDismiss={() => void list.refresh()}>
          {errorMessage(list.error)}
        </Banner>
      ) : null}

      <div className="toolbar">
        <div className="search-input" style={{ position: 'relative', flex: '1 1 200px' }}>
          <input
            type="search"
            placeholder="Filter by name, image or id"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            aria-label="Filter containers"
          />
        </div>
        <select
          value={stateFilter}
          onChange={(e) => setStateFilter(e.target.value as StateFilter)}
          aria-label="Filter by state"
          style={{ width: 'auto' }}
        >
          {STATE_FILTERS.map((s) => (
            <option key={s} value={s}>
              {s}
            </option>
          ))}
        </select>
        <label className="checkbox">
          <input type="checkbox" checked={showAll} onChange={(e) => setShowAll(e.target.checked)} />
          include stopped
        </label>
      </div>

      <Card flush>
        {list.loading && !list.data ? (
          <SkeletonRows rows={6} cols={5} />
        ) : list.error && !list.data ? null : filtered.length === 0 ? (
          <div style={{ padding: 'var(--space-4)' }}>
            <EmptyState
              icon="container"
              title={list.data && list.data.length > 0 ? 'No containers match the filter' : 'No containers yet'}
              action={
                list.data && list.data.length > 0 ? (
                  <Button onClick={() => { setQuery(''); setStateFilter('all'); }}>Clear filters</Button>
                ) : (
                  <Button variant="primary" icon="plus" disabled={!canWrite} onClick={() => setCreateOpen(true)}>
                    Run a container
                  </Button>
                )
              }
            >
              {list.data && list.data.length > 0
                ? 'Adjust the search text or state filter to see other containers.'
                : 'Run a container from an image, or deploy a template to create one with sensible defaults.'}
            </EmptyState>
          </div>
        ) : (
          <div className="table-wrap">
            <table className="data">
              <thead>
                <tr>
                  <th>Name</th>
                  <th>Image</th>
                  <th>State</th>
                  <th>Ports</th>
                  <th>Created</th>
                  <th className="num">Actions</th>
                </tr>
              </thead>
              <tbody>
                {capped.visible.map((c) => {
                  const ports = formatPorts(c.ports);
                  const busy = (a: string) => Boolean(pending[`${c.id}:${a}`]);
                  return (
                    <tr key={c.id}>
                      <td className="primary" data-label="Name">
                        <div className="row" style={{ gap: 'var(--space-2)' }}>
                          <Link to={`/containers/${c.id}`} className="truncate" style={{ maxWidth: 220 }} title={c.name}>
                            {c.name}
                          </Link>
                          {c.managed ? <span className="tag">managed</span> : null}
                        </div>
                        <div className="dim mono-cell" title={c.id}>
                          {shortId(c.id)}
                        </div>
                      </td>
                      <td className="mono-cell" data-label="Image">
                        <span className="truncate" title={c.image}>
                          {c.image}
                        </span>
                        {c.health ? (
                          <div style={{ marginTop: 2 }}>
                            <Pill state={c.health === 'healthy' ? 'running' : c.health === 'unhealthy' ? 'error' : 'paused'}>
                              {c.health}
                            </Pill>
                          </div>
                        ) : null}
                      </td>
                      <td data-label="State">
                        <Pill state={c.state} />
                      </td>
                      <td className="mono-cell" data-label="Ports">
                        {ports.length === 0 ? (
                          <span className="dim">none</span>
                        ) : (
                          <div className="stack" style={{ gap: 2 }}>
                            {ports.slice(0, 3).map((p) => (
                              <span key={p}>{p}</span>
                            ))}
                            {ports.length > 3 ? <span className="dim">+{ports.length - 3} more</span> : null}
                          </div>
                        )}
                      </td>
                      <td className="dim nowrap" data-label="Created">{formatDateTime(c.created)}</td>
                      <td className="cell-actions" data-label="Actions">
                        {c.state !== 'running' && c.state !== 'paused' ? (
                          <Button
                            size="sm"
                            icon="play"
                            title={canWrite ? 'Start' : 'Requires operator'}
                            aria-label="Start"
                            disabled={!canWrite || busy('start')}
                            busy={busy('start')}
                            onClick={() => void runAction(c.id, 'start')}
                          />
                        ) : null}
                        {c.state === 'running' ? (
                          <Button
                            size="sm"
                            icon="stop"
                            title={canWrite ? 'Stop' : 'Requires operator'}
                            aria-label="Stop"
                            disabled={!canWrite || busy('stop')}
                            busy={busy('stop')}
                            onClick={async () => {
                              const ok = await confirm({
                                title: `Stop ${c.name}?`,
                                body: 'The container is stopped with a graceful shutdown.',
                                confirmLabel: 'Stop',
                                danger: true,
                              });
                              if (ok) void runAction(c.id, 'stop');
                            }}
                          />
                        ) : null}
                        <Button
                          size="sm"
                          icon="restart"
                          title={canWrite ? 'Restart' : 'Requires operator'}
                          aria-label="Restart"
                          disabled={!canWrite || busy('restart')}
                          busy={busy('restart')}
                          onClick={() => void runAction(c.id, 'restart')}
                        />
                        {c.state === 'paused' ? (
                          <Button
                            size="sm"
                            icon="play"
                            title="Resume"
                            aria-label="Resume"
                            disabled={!canWrite || busy('unpause')}
                            busy={busy('unpause')}
                            onClick={() => void runAction(c.id, 'unpause')}
                          />
                        ) : (
                          <Button
                            size="sm"
                            icon="pause"
                            title={canWrite ? 'Pause' : 'Requires operator'}
                            aria-label="Pause"
                            disabled={!canWrite || c.state !== 'running' || busy('pause')}
                            busy={busy('pause')}
                            onClick={() => void runAction(c.id, 'pause')}
                          />
                        )}
                        <Button
                          size="sm"
                          variant="danger"
                          icon="close"
                          title={canWrite ? 'Kill' : 'Requires operator'}
                          aria-label="Kill"
                          disabled={!canWrite || busy('kill')}
                          busy={busy('kill')}
                          onClick={async () => {
                            const ok = await confirm({
                              title: `Kill ${c.name}?`,
                              body: 'SIGKILL is sent immediately. The process gets no chance to shut down cleanly.',
                              confirmLabel: 'Kill',
                              danger: true,
                            });
                            if (ok) void runAction(c.id, 'kill');
                          }}
                        />
                        <Button
                          size="sm"
                          variant="danger"
                          icon="trash"
                          title={canDestroy ? 'Remove' : 'Requires the admin role'}
                          aria-label="Remove"
                          disabled={!canDestroy || busy('remove')}
                          busy={busy('remove')}
                          onClick={() => void runRemove(c)}
                        />
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
            <RowCapNotice
              hidden={capped.hiddenCount}
              total={filtered.length}
              noun="containers"
              onShowAll={capped.showAll}
            />
          </div>
        )}
      </Card>

      <CreateContainerDrawer open={createOpen} onClose={() => setCreateOpen(false)} onCreated={() => void list.refresh()} />
    </>
  );
}

/* ------------------------------------------------------- create container */

function parseEnv(text: string): { env: Record<string, string>; errors: string[] } {
  const env: Record<string, string> = {};
  const errors: string[] = [];
  for (const raw of text.split('\n')) {
    const line = raw.trim();
    if (!line) continue;
    const eq = line.indexOf('=');
    if (eq <= 0) {
      errors.push(`Env line "${line}" is not KEY=value.`);
      continue;
    }
    env[line.slice(0, eq).trim()] = line.slice(eq + 1);
  }
  return { env, errors };
}

function parsePorts(text: string): { ports: NonNullable<CreateContainerInput['ports']>; errors: string[] } {
  const ports: NonNullable<CreateContainerInput['ports']> = [];
  const errors: string[] = [];
  for (const raw of text.split('\n')) {
    const line = raw.trim();
    if (!line) continue;
    const proto = line.endsWith('/udp') ? 'udp' : 'tcp';
    const body = line.replace(/\/(tcp|udp)$/, '');
    const [a, b] = body.split(':');
    if (b !== undefined) {
      const host = Number(a);
      const container = Number(b);
      if (!Number.isInteger(host) || !Number.isInteger(container)) {
        errors.push(`Port "${line}" needs numeric host:container.`);
        continue;
      }
      ports.push({ host, container, proto });
    } else {
      const container = Number(a);
      if (!Number.isInteger(container)) {
        errors.push(`Port "${line}" is not a number.`);
        continue;
      }
      ports.push({ container, proto });
    }
  }
  return { ports, errors };
}

function parseVolumes(text: string): { volumes: NonNullable<CreateContainerInput['volumes']>; errors: string[] } {
  const volumes: NonNullable<CreateContainerInput['volumes']> = [];
  const errors: string[] = [];
  for (const raw of text.split('\n')) {
    const line = raw.trim();
    if (!line) continue;
    const parts = line.split(':');
    if (parts.length < 2) {
      errors.push(`Volume "${line}" needs host:container.`);
      continue;
    }
    const container = parts[1];
    const host = parts[0];
    const mode = parts.length >= 3 ? parts[2] : undefined;
    if (!host || !container) {
      errors.push(`Volume "${line}" is incomplete.`);
      continue;
    }
    volumes.push({ host, container, mode });
  }
  return { volumes, errors };
}

function CreateContainerDrawer({
  open,
  onClose,
  onCreated,
}: {
  open: boolean;
  onClose: () => void;
  onCreated: () => void;
}) {
  const [name, setName] = useState('');
  const [image, setImage] = useState('');
  const [cmd, setCmd] = useState('');
  const [envText, setEnvText] = useState('');
  const [portText, setPortText] = useState('');
  const [volumeText, setVolumeText] = useState('');
  const [restartPolicy, setRestartPolicy] = useState<CreateContainerInput['restartPolicy']>('unless-stopped');
  const [network, setNetwork] = useState('');
  const [pull, setPull] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const networks = usePolling<NetworkSummary[]>(() => endpoints.networks.list(), { enabled: open });

  const reset = () => {
    setName('');
    setImage('');
    setCmd('');
    setEnvText('');
    setPortText('');
    setVolumeText('');
    setRestartPolicy('unless-stopped');
    setNetwork('');
    setPull(true);
    setError(null);
  };

  const submit = async () => {
    setError(null);
    if (!name.trim() || !image.trim()) {
      setError('Name and image are required.');
      return;
    }
    const { env, errors: envErrors } = parseEnv(envText);
    const { ports, errors: portErrors } = parsePorts(portText);
    const { volumes, errors: volErrors } = parseVolumes(volumeText);
    const errors = [...envErrors, ...portErrors, ...volErrors];
    if (errors.length) {
      setError(errors.join(' '));
      return;
    }
    const input: CreateContainerInput = {
      name: name.trim(),
      image: image.trim(),
      cmd: cmd.trim() ? cmd.trim().split(/\s+/) : undefined,
      env: Object.keys(env).length ? env : undefined,
      ports: ports.length ? ports : undefined,
      volumes: volumes.length ? volumes : undefined,
      restartPolicy,
      network: network || undefined,
      pull,
    };
    setBusy(true);
    try {
      await endpoints.containers.create(input);
      onCreated();
      reset();
      onClose();
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog
      open={open}
      onClose={onClose}
      variant="drawer"
      title="Run container"
      footer={
        <>
          <Button onClick={onClose} disabled={busy}>
            Cancel
          </Button>
          <Button variant="primary" busy={busy} onClick={() => void submit()}>
            Create and start
          </Button>
        </>
      }
    >
      {error ? <Banner tone="error" title="Could not create container">{error}</Banner> : null}
      <TextField label="Name" value={name} onChange={(e) => setName(e.target.value)} required disabled={busy} placeholder="my-service" />
      <TextField
        label="Image"
        value={image}
        onChange={(e) => setImage(e.target.value)}
        required
        disabled={busy}
        placeholder="nginx:alpine"
      />
      <TextField label="Command" value={cmd} onChange={(e) => setCmd(e.target.value)} disabled={busy} hint="Optional, split on spaces." placeholder="/bin/sh -c 'echo hi'" />
      <Field label="Environment" hint="One KEY=value per line.">
        <textarea value={envText} onChange={(e) => setEnvText(e.target.value)} disabled={busy} placeholder={'TZ=UTC\nDEBUG=false'} />
      </Field>
      <Field label="Ports" hint="host:container, container, or add /udp.">
        <textarea value={portText} onChange={(e) => setPortText(e.target.value)} disabled={busy} placeholder={'8080:80\n53:53/udp'} />
      </Field>
      <Field label="Volumes" hint="host-or-named-volume:container[:ro].">
        <textarea value={volumeText} onChange={(e) => setVolumeText(e.target.value)} disabled={busy} placeholder={'/srv/data:/data\nmy-vol:/var/lib/data'} />
      </Field>
      <div className="grid grid-2">
        <Field label="Restart policy">
          <select
            value={restartPolicy}
            onChange={(e) => setRestartPolicy(e.target.value as CreateContainerInput['restartPolicy'])}
            disabled={busy}
          >
            <option value="no">no</option>
            <option value="always">always</option>
            <option value="unless-stopped">unless-stopped</option>
            <option value="on-failure">on-failure</option>
          </select>
        </Field>
        <Field label="Network" hint={networks.data ? undefined : 'Loading networks'}>
          <select value={network} onChange={(e) => setNetwork(e.target.value)} disabled={busy}>
            <option value="">default</option>
            {(networks.data ?? []).map((n) => (
              <option key={n.id} value={n.name}>
                {n.name}
              </option>
            ))}
          </select>
        </Field>
      </div>
      <label className="checkbox">
        <input type="checkbox" checked={pull} onChange={(e) => setPull(e.target.checked)} disabled={busy} />
        Pull the image if it is missing
      </label>
      <p className="dim" style={{ fontSize: 'var(--fs-micro)', marginTop: 'var(--space-3)' }}>
        <Icon name="info" size={12} /> Container creation can take a while when an image has to be pulled.
      </p>
    </Dialog>
  );
}
