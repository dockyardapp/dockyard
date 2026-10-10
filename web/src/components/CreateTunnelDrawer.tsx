/**
 * Create a tunnel: dial out to a provider and hand back a public URL.
 *
 * Opened from a container, the target is that container and its own published ports, and the name
 * and port arrive filled in, so exposing something is pick a mode and press Create. Opened with no
 * container it falls back to the general form: choose a container, or point at a raw URL the panel
 * can reach.
 */

import { useEffect, useMemo, useState } from 'react';
import { endpoints, errorMessage } from '../api/client';
import type { ContainerSummary, CreateTunnelInput, TunnelMode } from '../api/types';
import { usePolling } from '../hooks/usePolling';
import { Icon } from './Icons';
import { Banner, Button, Dialog, Field, TextField } from './ui';

export type PortBinding = {
  ip?: string;
  privatePort: number;
  publicPort?: number;
  type: string;
};

/** The container a tunnel is being created for, when the drawer was opened from one. */
export type TunnelTarget = {
  id: string;
  name: string;
  ports: PortBinding[];
};

export function CreateTunnelDrawer({
  open,
  onClose,
  onCreated,
  namedReady,
  zones,
  target,
  initialPort,
}: {
  open: boolean;
  onClose: () => void;
  onCreated: () => void;
  namedReady: boolean;
  zones: Array<{ id: string; name: string; accountId: string }>;
  target?: TunnelTarget | null;
  initialPort?: number | null;
}) {
  const locked = !!target;

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

  // The container picker only matters when the drawer was not opened from a container.
  const containers = usePolling<ContainerSummary[]>(() => endpoints.containers.list({ all: true }), {
    enabled: open && !locked,
    intervalMs: 20000,
  });

  /**
   * Start from a clean form every time it opens, filled in from the container when there is one.
   *
   * The drawer stays mounted between opens, so without this the previous tunnel's name, hostname
   * and target would still be sitting in it.
   */
  useEffect(() => {
    if (!open) return;
    const published = (target?.ports ?? []).filter((p) => p.publicPort);
    const chosen =
      initialPort && published.some((p) => p.publicPort === initialPort)
        ? initialPort
        : published.length === 1
          ? published[0].publicPort
          : undefined;
    setName(target ? `${target.name}-${chosen ?? 'expose'}` : '');
    setMode('quick');
    setTargetType('container');
    setContainerId(target?.id ?? '');
    setPort(chosen ? String(chosen) : '');
    setTargetUrl('');
    setHostname('');
    setZoneId('');
    setAutoStart(false);
    setError(null);
  }, [open, target?.id, target?.name, initialPort, target?.ports]);

  const withPorts = useMemo(
    () => (containers.data ?? []).filter((c) => c.ports.some((p) => p.publicPort)),
    [containers.data],
  );

  // A locked drawer already knows the container, so it reads the ports off it rather than waiting
  // for a list request that only exists to populate a picker it does not render.
  const publishedPorts = useMemo(() => {
    const source = locked ? (target?.ports ?? []) : (withPorts.find((c) => c.id === containerId)?.ports ?? []);
    return source.filter((p) => p.publicPort);
  }, [locked, target?.ports, withPorts, containerId]);

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
      title={locked ? `Expose ${target?.name}` : 'Create tunnel'}
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

      {locked ? (
        <Field label="Target" hint="The container you opened this from.">
          <div className="row" style={{ gap: 'var(--space-2)' }}>
            <span className="mono-cell">{target?.name}</span>
            <button
              type="button"
              className="chip"
              aria-pressed={targetType === 'url'}
              onClick={() => setTargetType(targetType === 'url' ? 'container' : 'url')}
            >
              {targetType === 'url' ? 'use this container' : 'raw URL instead'}
            </button>
          </div>
        </Field>
      ) : (
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
      )}

      {targetType === 'container' ? (
        <>
          {locked ? null : (
            <>
              <Field label="Container" htmlFor="tunnel-target-container" hint="Only containers with a published port can be targeted.">
                <select
                  id="tunnel-target-container"
                  value={containerId}
                  onChange={(e) => { setContainerId(e.target.value); setPort(''); }}
                  disabled={busy}
                >
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
            </>
          )}
          <Field
            label="Published port"
            htmlFor="tunnel-target-port"
            hint={
              publishedPorts.length === 0
                ? 'This container publishes no port. Publish one, or point at a raw URL instead.'
                : publishedPorts.length === 1
                  ? 'The single published port is used automatically.'
                  : 'Leave blank to use the container default.'
            }
          >
            <select
              id="tunnel-target-port"
              value={port}
              onChange={(e) => setPort(e.target.value)}
              disabled={busy || publishedPorts.length === 0}
            >
              <option value="">auto</option>
              {publishedPorts.map((p) => (
                <option
                  key={`${p.ip ?? 'any'}:${p.publicPort}->${p.privatePort}/${p.type}`}
                  value={String(p.publicPort)}
                >
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
          <Field label="Zone" htmlFor="tunnel-target-zone">
            <select id="tunnel-target-zone" value={zoneId} onChange={(e) => setZoneId(e.target.value)} disabled={busy}>
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
        seconds to appear.
      </p>
    </Dialog>
  );
}
