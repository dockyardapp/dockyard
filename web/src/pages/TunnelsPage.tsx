import { useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { endpoints, errorMessage } from '../api/client';
import type {
  CloudflareStatus,
  ContainerSummary,
  CreateTunnelInput,
  Tunnel,
  TunnelMode,
} from '../api/types';
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
  CopyButton,
  Dialog,
  EmptyState,
  Field,
  PageHead,
  Pill,
  SkeletonRows,
  TextField,
  useConfirm,
} from '../components/ui';
import { formatDateTime, pluralize } from '../lib/format';

export function TunnelsPage() {
  const { user } = useAuth();
  const confirm = useConfirm();
  const canWrite = can.write(user?.role);
  const canDestroy = can.destroy(user?.role);
  const isAdmin = can.manageSettings(user?.role);

  const [pending, setPending] = useState<Record<string, boolean>>({});
  const [error, setError] = useState<string | null>(null);
  const [createOpen, setCreateOpen] = useState(false);

  const list = usePolling<Tunnel[]>(() => endpoints.tunnels.list(), { intervalMs: 5000 });
  const cf = usePolling<CloudflareStatus>(() => endpoints.cloudflare.status(), {
    enabled: isAdmin,
    intervalMs: 30000,
  });

  const tunnels = list.data ?? [];
  const capped = useRowCap(tunnels);

  useEvents((ev) => {
    if (ev.type === 'tunnel') void list.refresh();
  });

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

  const cfReady = cf.data?.verified ?? false;

  return (
    <>
      <PageHead
        title="Tunnels"
        desc={list.data ? pluralize(list.data.length, 'tunnel') : 'Expose containers and URLs through Cloudflare'}
        actions={
          <>
            <Button icon="refresh" busy={list.refreshing} onClick={() => void list.refresh()}>
              Refresh
            </Button>
            <Button variant="primary" icon="plus" disabled={!canWrite} onClick={() => setCreateOpen(true)}>
              Create tunnel
            </Button>
          </>
        }
      />

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

      {isAdmin ? <CloudflarePanel status={cf.data} loading={cf.loading} error={cf.error} onChanged={() => void cf.refresh()} /> : null}

      {list.loading && !list.data ? (
        <Card>
          <SkeletonRows rows={4} cols={5} />
        </Card>
      ) : (list.data ?? []).length === 0 ? (
        <EmptyState
          icon="tunnel"
          title="No tunnels yet"
          action={
            <Button variant="primary" icon="plus" disabled={!canWrite} onClick={() => setCreateOpen(true)}>
              Create a tunnel
            </Button>
          }
        >
          A quick tunnel needs no Cloudflare account. A named tunnel gives you a stable hostname on your own
          domain.
        </EmptyState>
      ) : (
        <div className="table-wrap card">
          <table className="data">
            <thead>
              <tr>
                <th>Name</th>
                <th>Mode</th>
                <th>Target</th>
                <th>Status</th>
                <th>URL</th>
                <th className="num">Actions</th>
              </tr>
            </thead>
            <tbody>
              {capped.visible.map((t) => (
                <tr key={t.id}>
                  <td className="primary" data-label="Name">
                    {t.name}
                    {t.auto_start ? <div className="dim" style={{ fontSize: 'var(--fs-micro)' }}>auto-start</div> : null}
                  </td>
                  <td data-label="Mode">
                    <span className="tag">{t.mode}</span>
                  </td>
                  <td className="mono-cell" data-label="Target">
                    <div className="stack" style={{ gap: 2 }}>
                      <span className="truncate" title={t.target_url}>{t.target_url}</span>
                      {t.container_name ? (
                        <span className="dim">
                          {t.container_id ? <Link to={`/containers/${t.container_id}`}>{t.container_name}</Link> : t.container_name}
                          {t.port ? ` :${t.port}` : ''}
                        </span>
                      ) : null}
                    </div>
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
          <RowCapNotice
            hidden={capped.hiddenCount}
            total={tunnels.length}
            noun="tunnels"
            onShowAll={capped.showAll}
          />
        </div>
      )}

      <CreateTunnelDrawer
        open={createOpen}
        onClose={() => setCreateOpen(false)}
        onCreated={() => {
          setCreateOpen(false);
          void list.refresh();
        }}
        namedReady={cfReady}
        zones={cf.data?.zones ?? []}
      />
    </>
  );
}

/* ------------------------------------------------------- cloudflare panel */

export function CloudflarePanel({
  status,
  loading,
  error,
  onChanged,
}: {
  status: CloudflareStatus | null;
  loading: boolean;
  error: unknown;
  onChanged: () => void;
}) {
  const [token, setToken] = useState('');
  const [accountId, setAccountId] = useState('');
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [editing, setEditing] = useState(false);

  const save = async () => {
    setBusy(true);
    setErr(null);
    setMsg(null);
    try {
      const res = await endpoints.cloudflare.setCredentials(token.trim() || undefined, accountId.trim());
      if (res.verified) setMsg('Credentials verified against the Cloudflare API.');
      else setMsg(res.error ? `Saved, but verification failed: ${res.error}` : 'Saved. Verification is pending.');
      setToken('');
      setEditing(false);
      onChanged();
    } catch (e) {
      setErr(errorMessage(e));
    } finally {
      setBusy(false);
    }
  };

  const clear = async () => {
    setBusy(true);
    setErr(null);
    setMsg(null);
    try {
      await endpoints.cloudflare.clearCredentials();
      setMsg('Credentials removed.');
      onChanged();
    } catch (e) {
      setErr(errorMessage(e));
    } finally {
      setBusy(false);
    }
  };

  const configured = status?.configured ?? false;
  const showForm = !configured || editing;

  return (
    <Card
      title="Cloudflare credentials"
      actions={
        configured && !editing ? (
          <>
            <Button size="sm" onClick={() => setEditing(true)}>
              Replace
            </Button>
            <Button size="sm" variant="danger" busy={busy} onClick={() => void clear()}>
              Remove
            </Button>
          </>
        ) : null
      }
    >
      {error ? (
        <Banner tone="error" title="Could not read Cloudflare status">
          {errorMessage(error)}
        </Banner>
      ) : null}
      {err ? <Banner tone="error" title="Credentials rejected">{err}</Banner> : null}
      {msg ? <Banner tone="info">{msg}</Banner> : null}

      {loading && !status ? (
        <SkeletonRows rows={2} cols={2} />
      ) : (
        <>
          <div className="row" style={{ gap: 'var(--space-3)', marginBottom: 'var(--space-3)' }}>
            <Pill state={configured ? (status?.verified ? 'running' : 'paused') : 'stopped'}>
              {configured ? (status?.verified ? 'verified' : 'unverified') : 'not configured'}
            </Pill>
            {configured && status?.accountId ? (
              <span className="mono-cell">account {status.accountId}</span>
            ) : null}
          </div>

          {showForm ? (
            <>
              <TextField
                label="API token"
                type="password"
                value={token}
                onChange={(e) => setToken(e.target.value)}
                autoComplete="off"
                placeholder={configured ? 'Leave blank to keep the stored token' : 'Cloudflare API token'}
                hint="Stored encrypted. It is never returned by the API."
              />
              <TextField
                label="Account ID"
                value={accountId}
                onChange={(e) => setAccountId(e.target.value)}
                placeholder="Cloudflare account id"
                hint={
                  status && status.accounts.length > 0
                    ? `Known accounts: ${status.accounts.map((a) => `${a.name} (${a.id})`).join(', ')}`
                    : undefined
                }
              />
              <div className="btn-row">
                <Button variant="primary" busy={busy} disabled={!accountId.trim()} onClick={() => void save()}>
                  Save credentials
                </Button>
                {editing ? (
                  <Button onClick={() => setEditing(false)} disabled={busy}>
                    Cancel
                  </Button>
                ) : null}
              </div>
            </>
          ) : (
            <div className="row" style={{ gap: 'var(--space-3)' }}>
              <Icon name="shield" size={14} />
              <span className="muted" style={{ fontSize: 'var(--fs-xs)' }}>
                {status?.zones.length ?? 0} zone{(status?.zones.length ?? 0) === 1 ? '' : 's'} available for named
                tunnels.
              </span>
            </div>
          )}

          {configured && (status?.zones.length ?? 0) > 0 ? (
            <dl className="kv" style={{ marginTop: 'var(--space-3)' }}>
              {status?.zones.map((z) => (
                <div key={z.id} style={{ display: 'contents' }}>
                  <dt className="mono-cell">{z.name}</dt>
                  <dd className="mono-cell dim">{z.id}</dd>
                </div>
              ))}
            </dl>
          ) : null}
        </>
      )}
    </Card>
  );
}

/* ------------------------------------------------------ create tunnel drawer */

function CreateTunnelDrawer({
  open,
  onClose,
  onCreated,
  namedReady,
  zones,
}: {
  open: boolean;
  onClose: () => void;
  onCreated: () => void;
  namedReady: boolean;
  zones: Array<{ id: string; name: string; accountId: string }>;
}) {
  const [name, setName] = useState('');
  const [mode, setMode] = useState<TunnelMode>('quick');
  const [targetType, setTargetType] = useState<'container' | 'url'>('container');
  const [containerId, setContainerId] = useState('');
  const [port, setPort] = useState('');
  const [targetUrl, setTargetUrl] = useState('');
  const [hostname, setHostname] = useState('');
  const [zoneId, setZoneId] = useState('');
  const [autoStart, setAutoStart] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const containers = usePolling<ContainerSummary[]>(() => endpoints.containers.list({ all: true }), {
    enabled: open,
    intervalMs: 20000,
  });

  const withPorts = useMemo(
    () => (containers.data ?? []).filter((c) => c.ports.some((p) => p.publicPort)),
    [containers.data],
  );
  const selected = withPorts.find((c) => c.id === containerId);
  const publishedPorts = selected ? selected.ports.filter((p) => p.publicPort) : [];

  const canSubmit =
    name.trim().length > 0 &&
    (targetType === 'url' ? targetUrl.trim().length > 0 : containerId.length > 0) &&
    (mode !== 'named' || (hostname.trim().length > 0 && zoneId.length > 0));

  const submit = async () => {
    setError(null);
    if (!canSubmit) return;
    const input: CreateTunnelInput = {
      name: name.trim(),
      mode,
      auto_start: autoStart,
    };
    if (targetType === 'url') input.target_url = targetUrl.trim();
    else {
      input.container_id = containerId;
      if (port) input.port = Number(port);
    }
    if (mode === 'named') {
      input.hostname = hostname.trim();
      input.zone_id = zoneId;
    }
    setBusy(true);
    try {
      await endpoints.tunnels.create(input);
      onCreated();
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
      title="Create tunnel"
      footer={
        <>
          <Button onClick={onClose} disabled={busy}>
            Cancel
          </Button>
          <Button variant="primary" icon="plus" busy={busy} disabled={!canSubmit} onClick={() => void submit()}>
            Create tunnel
          </Button>
        </>
      }
    >
      {error ? <Banner tone="error" title="Could not create tunnel">{error}</Banner> : null}

      <TextField label="Name" value={name} onChange={(e) => setName(e.target.value)} required disabled={busy} placeholder="web-preview" />

      <Field
        label="Mode"
        hint={
          mode === 'quick'
            ? 'Quick tunnels need no Cloudflare account. The URL changes each time.'
            : mode === 'localtunnel'
              ? 'LocalTunnel needs no account either, and is the quickest to set up. The URL is assigned by localtunnel.me and changes each time. A browser visitor is shown a localtunnel.me reminder page once and has to enter this host\'s public IP to continue.'
              : 'Named tunnels use your Cloudflare account and keep a stable hostname.'
        }
      >
        <div className="row" style={{ gap: 'var(--space-2)' }}>
          <button type="button" className="chip" aria-pressed={mode === 'quick'} onClick={() => setMode('quick')}>
            quick
          </button>
          <button
            type="button"
            className="chip"
            aria-pressed={mode === 'localtunnel'}
            onClick={() => setMode('localtunnel')}
          >
            localtunnel
          </button>
          <button
            type="button"
            className="chip"
            aria-pressed={mode === 'named'}
            onClick={() => setMode('named')}
            disabled={!namedReady}
            title={namedReady ? undefined : 'Add and verify Cloudflare credentials first'}
          >
            named
          </button>
        </div>
      </Field>

      <Field label="Target">
        <div className="row" style={{ gap: 'var(--space-2)' }}>
          <button type="button" className="chip" aria-pressed={targetType === 'container'} onClick={() => setTargetType('container')}>
            container port
          </button>
          <button type="button" className="chip" aria-pressed={targetType === 'url'} onClick={() => setTargetType('url')}>
            raw URL
          </button>
        </div>
      </Field>

      {targetType === 'container' ? (
        <>
          <Field label="Container" hint="Only containers with a published port can be targeted.">
            <select value={containerId} onChange={(e) => { setContainerId(e.target.value); setPort(''); }} disabled={busy}>
              <option value="">Select a container</option>
              {withPorts.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.name}
                </option>
              ))}
            </select>
          </Field>
          {withPorts.length === 0 && !containers.loading ? (
            <Banner tone="warn" title="No container has a published port">
              Start a container with a published port, or target a raw URL instead.
            </Banner>
          ) : null}
          <Field label="Published port" hint={publishedPorts.length === 1 ? 'The single published port is used automatically.' : 'Leave blank to use the container default.'}>
            <select value={port} onChange={(e) => setPort(e.target.value)} disabled={busy || publishedPorts.length === 0}>
              <option value="">auto</option>
              {publishedPorts.map((p) => (
                <option key={`${p.publicPort}-${p.type}`} value={String(p.publicPort)}>
                  {p.publicPort} -&gt; {p.privatePort}/{p.type}
                </option>
              ))}
            </select>
          </Field>
        </>
      ) : (
        <TextField
          label="Target URL"
          value={targetUrl}
          onChange={(e) => setTargetUrl(e.target.value)}
          placeholder="http://127.0.0.1:8080"
          className="mono"
          disabled={busy}
        />
      )}

      {mode === 'named' ? (
        <>
          <TextField
            label="Hostname"
            value={hostname}
            onChange={(e) => setHostname(e.target.value)}
            placeholder="app.example.com"
            hint="A DNS record is created in the selected zone."
            disabled={busy}
          />
          <Field label="Zone">
            <select value={zoneId} onChange={(e) => setZoneId(e.target.value)} disabled={busy}>
              <option value="">Select a zone</option>
              {zones.map((z) => (
                <option key={z.id} value={z.id}>
                  {z.name}
                </option>
              ))}
            </select>
          </Field>
        </>
      ) : null}

      <label className="checkbox">
        <input type="checkbox" checked={autoStart} onChange={(e) => setAutoStart(e.target.checked)} disabled={busy} />
        Start automatically on server boot
      </label>

      <p className="dim" style={{ fontSize: 'var(--fs-micro)', marginTop: 'var(--space-3)' }}>
        <Icon name="info" size={12} /> Quick tunnel URLs are read from cloudflared output and can take a few
        seconds to appear. Created {formatDateTime(new Date())}.
      </p>
    </Dialog>
  );
}
