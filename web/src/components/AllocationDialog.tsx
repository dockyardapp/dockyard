/**
 * Resource allocation editor.
 *
 * The panel's role ladder decides what a user may *do*; this decides what they
 * may *see*. A user is either unscoped (sees the whole host) or scoped to a list
 * of grants, and a grant is either one explicit resource or a label selector.
 *
 * Labels are the form worth defaulting to: an explicit container id stops
 * matching the moment that container is recreated, whereas a label is re-applied
 * to anything the user creates afterwards, so their own work stays visible.
 */

import { useEffect, useState } from 'react';
import { endpoints, errorMessage } from '../api/client';
import type { Grant, PublicUser, ResourceKind } from '../api/types';
import { Banner, Button, Dialog, EmptyState, Pill, SelectField, TextField } from './ui';

const KINDS: ResourceKind[] = [
  'container',
  'stack',
  'volume',
  'network',
  'image',
  'template',
  'tunnel',
];

const KIND_NOUNS: Record<ResourceKind, string> = {
  container: 'containers',
  stack: 'stacks',
  volume: 'volumes',
  network: 'networks',
  image: 'images',
  template: 'templates',
  tunnel: 'tunnels',
};

function describeGrant(g: Grant): string {
  if (g.resource_id) return g.resource_id;
  if (g.label_key) return `${g.label_key} = ${g.label_value === '' ? '(any)' : g.label_value}`;
  return 'unknown selector';
}

export function AllocationDialog({
  user,
  onClose,
  onChanged,
}: {
  user: PublicUser | null;
  onClose: () => void;
  onChanged: () => void | Promise<void>;
}) {
  const [grants, setGrants] = useState<Grant[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [modeBusy, setModeBusy] = useState(false);

  const [kind, setKind] = useState<ResourceKind>('container');
  const [selector, setSelector] = useState<'label' | 'id'>('label');
  const [resourceId, setResourceId] = useState('');
  const [labelKey, setLabelKey] = useState('');
  const [labelValue, setLabelValue] = useState('');

  const isAdmin = user?.role === 'admin';

  const load = async () => {
    if (!user) return;
    if (user.role === 'admin') {
      // An admin is never scoped, so there is nothing to fetch or display.
      setGrants([]);
      return;
    }
    setError(null);
    try {
      setGrants(await endpoints.users.grants(user.id));
    } catch (err) {
      setError(errorMessage(err));
      setGrants([]);
    }
  };

  useEffect(() => {
    if (!user) {
      setGrants(null);
      return;
    }
    setGrants(null);
    setResourceId('');
    setLabelKey('');
    setLabelValue('');
    void load();
    // Re-fetch whenever the dialog is pointed at a different user.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [user?.id]);

  const addGrant = async () => {
    if (!user) return;
    setBusy(true);
    setError(null);
    try {
      await endpoints.users.addGrant(
        user.id,
        selector === 'label'
          ? { resource_kind: kind, label_key: labelKey.trim(), label_value: labelValue.trim() }
          : { resource_kind: kind, resource_id: resourceId.trim() },
      );
      setResourceId('');
      setLabelValue('');
      await load();
      await onChanged();
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  };

  const removeGrant = async (grantId: string) => {
    if (!user) return;
    setBusy(true);
    setError(null);
    try {
      await endpoints.users.removeGrant(user.id, grantId);
      await load();
      await onChanged();
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  };

  const clearGrants = async () => {
    if (!user) return;
    setBusy(true);
    setError(null);
    try {
      await endpoints.users.clearGrants(user.id);
      await load();
      await onChanged();
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  };

  const setMode = async (mode: 'all' | 'granted') => {
    if (!user) return;
    setModeBusy(true);
    setError(null);
    try {
      await endpoints.users.update(user.id, { scope_mode: mode });
      await onChanged();
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setModeBusy(false);
    }
  };

  const canAdd =
    !busy && (selector === 'label' ? labelKey.trim().length > 0 : resourceId.trim().length > 0);

  return (
    <Dialog
      open={user !== null}
      onClose={onClose}
      title="Resource allocation"
      width={720}
      footer={<Button onClick={onClose}>Close</Button>}
    >
      {user ? (
        <>
          <p className="dim" style={{ marginTop: 0 }}>
            <strong>{user.email}</strong>
            {isAdmin ? (
              <>
                {' '}
                is an administrator. <Pill state="info">full host</Pill>
              </>
            ) : user.scope_mode === 'granted' ? (
              <>
                {' '}
                sees only the resources allocated below. <Pill state="info">scoped</Pill>
              </>
            ) : (
              <>
                {' '}
                sees the whole host. <Pill state="stopped">unscoped</Pill>
              </>
            )}
          </p>

          {error ? (
            <Banner tone="error" title="Allocation change failed" onDismiss={() => setError(null)}>
              {error}
            </Banner>
          ) : null}

          {isAdmin ? (
            <Banner tone="info" title="Administrators are never scoped">
              An admin always sees every resource, so there is always one account that can undo a
              bad allocation. Demote the user first if you need to restrict them.
            </Banner>
          ) : (
            <>
              <div className="row" style={{ marginBottom: 12 }}>
                {user.scope_mode === 'granted' ? (
                  <Button size="sm" busy={modeBusy} onClick={() => void setMode('all')}>
                    Grant full host access
                  </Button>
                ) : (
                  <Button size="sm" busy={modeBusy} onClick={() => void setMode('granted')}>
                    Restrict to allocated resources
                  </Button>
                )}
                {grants && grants.length > 0 ? (
                  <Button size="sm" variant="danger" busy={busy} onClick={() => void clearGrants()}>
                    Clear all grants
                  </Button>
                ) : null}
              </div>

              {user.scope_mode !== 'granted' ? (
                <Banner tone="info" title="Grants have no effect while this user is unscoped">
                  Adding one below switches them to a scoped account automatically.
                </Banner>
              ) : null}

              {grants === null ? (
                <p className="dim">Loading allocation.</p>
              ) : grants.length === 0 ? (
                <EmptyState icon="shield" title="Nothing allocated">
                  {user.scope_mode === 'granted'
                    ? 'This user currently sees no resources at all.'
                    : 'This user sees the whole host until you allocate something.'}
                </EmptyState>
              ) : (
                <div className="table-wrap">
                  <table className="data">
                    <thead>
                      <tr>
                        <th>Kind</th>
                        <th>Selector</th>
                        <th>Match</th>
                        <th className="num">Remove</th>
                      </tr>
                    </thead>
                    <tbody>
                      {grants.map((g) => (
                        <tr key={g.id}>
                          <td className="primary" data-label="Kind">
                            {KIND_NOUNS[g.resource_kind] ?? g.resource_kind}
                          </td>
                          <td className="mono" data-label="Selector">
                            {describeGrant(g)}
                          </td>
                          <td className="dim" data-label="Match">
                            {g.label_key ? 'label' : 'exact'}
                          </td>
                          <td className="cell-actions" data-label="Remove">
                            <Button
                              size="sm"
                              variant="danger"
                              icon="trash"
                              busy={busy}
                              aria-label={`Remove grant ${describeGrant(g)}`}
                              onClick={() => void removeGrant(g.id)}
                            />
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}

              <h4 style={{ marginBottom: 4 }}>Allocate a resource</h4>
              <div className="grid grid-3">
                <SelectField
                  label="Kind"
                  value={kind}
                  onChange={(e) => setKind(e.target.value as ResourceKind)}
                >
                  {KINDS.map((k) => (
                    <option key={k} value={k}>
                      {KIND_NOUNS[k]}
                    </option>
                  ))}
                </SelectField>
                <SelectField
                  label="Selector"
                  value={selector}
                  onChange={(e) => setSelector(e.target.value as 'label' | 'id')}
                >
                  <option value="label">Label</option>
                  <option value="id">Exact id or name</option>
                </SelectField>
                {selector === 'id' ? (
                  <TextField
                    label="Id, name or slug"
                    value={resourceId}
                    onChange={(e) => setResourceId(e.target.value)}
                    placeholder="redis"
                  />
                ) : (
                  <TextField
                    label="Label key"
                    value={labelKey}
                    onChange={(e) => setLabelKey(e.target.value)}
                    placeholder="dockyard.team"
                    spellCheck={false}
                  />
                )}
              </div>
              {selector === 'label' ? (
                <TextField
                  label="Label value"
                  hint="Leave blank to match any value for that key."
                  value={labelValue}
                  onChange={(e) => setLabelValue(e.target.value)}
                  placeholder="alice"
                  spellCheck={false}
                />
              ) : null}
              <div className="row">
                <Button variant="primary" icon="plus" disabled={!canAdd} busy={busy} onClick={() => void addGrant()}>
                  Allocate
                </Button>
                <span className="dim" style={{ fontSize: 'var(--fs-xs)' }}>
                  Labels are durable: anything this user creates inherits the label and stays visible.
                  An exact id stops matching once the resource is recreated.
                </span>
              </div>
            </>
          )}
        </>
      ) : null}
    </Dialog>
  );
}
