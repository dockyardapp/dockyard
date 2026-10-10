/**
 * The Cloudflare account the named-tunnel mode runs on.
 *
 * This is an admin credential, so it belongs on Settings with the other account-level state rather
 * than beside the tunnels it enables. It used to live on the tunnels page, which put a token field
 * one click away from a list any operator reads.
 */

import { useState } from 'react';
import { endpoints, errorMessage } from '../api/client';
import type { CloudflareStatus } from '../api/types';
import { Icon } from './Icons';
import { Banner, Button, Card, Pill, SkeletonRows, TextField } from './ui';

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
