/**
 * Resource allocation editor.
 *
 * The role ladder (`lib/rbac`) decides what a user may *do*; this decides what
 * they may *see*. An admin picks a user, sees every resource on the host, and
 * ticks the ones that user should have.
 *
 * Resources are named, not numbered. The list reads "dy-demo-app", not a 64
 * character digest, because a wall of ids cannot be reviewed by a human.
 *
 * Label grants still exist, under Advanced. They are the durable form, since a
 * label survives a container being deleted and recreated, but the key/value form
 * is awkward to explain and easy to mistype, so it is not what an admin meets
 * first.
 */

import { useEffect, useMemo, useState } from 'react';
import { endpoints, errorMessage } from '../api/client';
import type { Grant, PublicUser, ResourceKind } from '../api/types';
import { formatBytes, matchesQuery, shortId } from '../lib/format';
import { Banner, Button, Dialog, Pill, SelectField, TextField } from './ui';

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

/** One row in the picker. `id` is what a grant stores. */
type Pickable = { id: string; name: string; detail: string };

/** A grant written by the picker names its resource; show that instead of the id. */
function looksLikeId(value: string): boolean {
  return /^[0-9a-f]{12,}$/i.test(value);
}

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
  const [listError, setListError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [modeBusy, setModeBusy] = useState(false);

  const [lists, setLists] = useState<Partial<Record<ResourceKind, Pickable[]>>>({});
  const [listsBusy, setListsBusy] = useState(true);
  const [kind, setKind] = useState<ResourceKind>('container');
  const [query, setQuery] = useState('');
  const [pending, setPending] = useState<Record<string, boolean>>({});

  const [advanced, setAdvanced] = useState(false);
  const [selector, setSelector] = useState<'label' | 'id'>('label');
  const [resourceId, setResourceId] = useState('');
  const [labelKey, setLabelKey] = useState('');
  const [labelValue, setLabelValue] = useState('');

  const isAdmin = user?.role === 'admin';

  const loadGrants = async () => {
    if (!user) return;
    if (user.role === 'admin') {
      // An admin is never scoped, so there is nothing to fetch or display.
      setGrants([]);
      return;
    }
    // Deliberately does not clear the error: this runs again after a failed
    // change to put the list back, and clearing here wiped the reason the change
    // failed before the admin could read it.
    try {
      setGrants(await endpoints.users.grants(user.id));
    } catch (err) {
      setError(errorMessage(err));
      setGrants([]);
    }
  };

  /**
   * Read every resource list up front so the picker is instant when the admin
   * switches kinds. Each list fails on its own: a host with no tunnels should
   * not blank the container list.
   *
   * An admin never sees the picker, so this is not called for one.
   */
  const loadLists = async () => {
    setListsBusy(true);
    setListError(null);

    const loaders: Array<[ResourceKind, () => Promise<Pickable[]>]> = [
      [
        'container',
        async () =>
          (await endpoints.containers.list({ all: true })).map((c) => ({
            id: c.name,
            name: c.name,
            detail: `${c.image} · ${c.state}`,
          })),
      ],
      [
        'stack',
        async () =>
          (await endpoints.stacks.list()).map((s) => ({
            id: s.name,
            name: s.name,
            detail: s.status,
          })),
      ],
      [
        'volume',
        async () =>
          (await endpoints.volumes.list()).map((v) => ({
            id: v.name,
            name: v.name,
            detail: v.driver,
          })),
      ],
      [
        'network',
        async () =>
          (await endpoints.networks.list()).map((n) => ({
            id: n.name,
            name: n.name,
            detail: n.driver,
          })),
      ],
      [
        'image',
        async () =>
          (await endpoints.images.list()).map((i) => ({
            id: i.repoTags[0] ?? i.id,
            name: i.repoTags[0] ?? shortId(i.id),
            detail: formatBytes(i.size),
          })),
      ],
      [
        'template',
        async () =>
          (await endpoints.templates.list()).map((t) => ({
            id: t.slug,
            name: t.name,
            detail: t.category,
          })),
      ],
      [
        'tunnel',
        async () =>
          (await endpoints.tunnels.list()).map((t) => ({
            id: t.name,
            name: t.name,
            detail: `${t.mode} · ${t.status}`,
          })),
      ],
    ];

    const next: Partial<Record<ResourceKind, Pickable[]>> = {};
    const failed: string[] = [];
    await Promise.all(
      loaders.map(async ([k, run]) => {
        try {
          next[k] = await run();
        } catch {
          next[k] = [];
          failed.push(KIND_NOUNS[k]);
        }
      }),
    );

    setLists(next);
    if (failed.length > 0) setListError(`Could not read ${failed.join(', ')} from the host.`);
    setListsBusy(false);
  };

  useEffect(() => {
    if (!user) {
      setGrants(null);
      return;
    }
    setGrants(null);
    setLists({});
    setQuery('');
    setKind('container');
    setAdvanced(false);
    setResourceId('');
    setLabelKey('');
    setLabelValue('');
    setError(null);
    setListError(null);
    void loadGrants();
    if (user.role !== 'admin') void loadLists();
    // Re-read whenever the dialog is pointed at a different user.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [user?.id]);

  const grantedIds = useMemo(() => {
    const set = new Set<string>();
    for (const g of grants ?? []) {
      if (g.resource_kind === kind && g.resource_id) set.add(g.resource_id);
    }
    return set;
  }, [grants, kind]);

  const pickable = useMemo(() => {
    const items = lists[kind] ?? [];
    const matched = query.trim()
      ? items.filter((i) => matchesQuery(query, i.name, i.detail))
      : items;
    // Already-allocated resources float to the top: they are the ones an admin
    // is most likely to be looking for.
    return [...matched].sort((a, b) => {
      const ga = grantedIds.has(a.id) ? 0 : 1;
      const gb = grantedIds.has(b.id) ? 0 : 1;
      return ga - gb || a.name.localeCompare(b.name);
    });
  }, [lists, kind, query, grantedIds]);

  /**
   * Tick a resource on or off. The checkbox moves immediately and the request
   * follows; a failure rolls the list back from the server.
   */
  const toggleResource = async (item: Pickable, on: boolean) => {
    if (!user) return;
    const before = grants ?? [];
    setPending((p) => ({ ...p, [item.id]: true }));
    setError(null);

    if (on) {
      setGrants([
        ...before,
        {
          id: `pending:${kind}:${item.id}`,
          resource_kind: kind,
          resource_id: item.id,
          label_key: null,
          label_value: null,
        },
      ]);
    } else {
      setGrants(
        before.filter((g) => !(g.resource_kind === kind && g.resource_id === item.id)),
      );
    }

    try {
      if (on) {
        await endpoints.users.addGrant(user.id, { resource_kind: kind, resource_id: item.id });
      } else {
        const existing = before.find(
          (g) => g.resource_kind === kind && g.resource_id === item.id && !g.id.startsWith('pending:'),
        );
        if (existing) await endpoints.users.removeGrant(user.id, existing.id);
      }
      await loadGrants();
      await onChanged();
    } catch (err) {
      setError(errorMessage(err));
      await loadGrants();
    } finally {
      setPending((p) => {
        const nextPending = { ...p };
        delete nextPending[item.id];
        return nextPending;
      });
    }
  };

  const removeGrant = async (grantId: string) => {
    if (!user) return;
    setBusy(true);
    setError(null);
    try {
      await endpoints.users.removeGrant(user.id, grantId);
      await loadGrants();
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
      await loadGrants();
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
      await loadGrants();
      await onChanged();
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setModeBusy(false);
    }
  };

  const addLabelGrant = async () => {
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
      await loadGrants();
      await onChanged();
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  };

  const canAddAdvanced =
    !busy && (selector === 'label' ? labelKey.trim().length > 0 : resourceId.trim().length > 0);

  const allocated = grants ?? [];

  return (
    <Dialog
      open={user !== null}
      onClose={onClose}
      title="Resource access"
      width={760}
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
                sees only what you tick below. <Pill state="info">scoped</Pill>
              </>
            ) : (
              <>
                {' '}
                sees the whole host. <Pill state="stopped">unscoped</Pill>
              </>
            )}
          </p>

          {error ? (
            <Banner tone="error" title="Access change failed" onDismiss={() => setError(null)}>
              {error}
            </Banner>
          ) : null}
          {listError ? (
            <Banner tone="warn" title="Some resources could not be listed" onDismiss={() => setListError(null)}>
              {listError}
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
                    Give full host access
                  </Button>
                ) : (
                  <Button size="sm" busy={modeBusy} onClick={() => void setMode('granted')}>
                    Restrict to ticked resources
                  </Button>
                )}
                {allocated.length > 0 ? (
                  <Button size="sm" variant="danger" busy={busy} onClick={() => void clearGrants()}>
                    Remove all access
                  </Button>
                ) : null}
              </div>

              {user.scope_mode !== 'granted' ? (
                <Banner tone="info" title="This user still sees the whole host">
                  Ticking a resource below restricts them to it automatically.
                </Banner>
              ) : null}

              <h4 style={{ marginBottom: 4 }}>
                Has access to {allocated.length > 0 ? `(${allocated.length})` : ''}
              </h4>
              {grants === null ? (
                <p className="dim">Loading access.</p>
              ) : allocated.length === 0 ? (
                <p className="dim" style={{ marginTop: 0 }}>
                  {user.scope_mode === 'granted'
                    ? 'Nothing yet, so this user currently sees no resources at all.'
                    : 'Nothing ticked yet. This user sees the whole host until you tick something.'}
                </p>
              ) : (
                <div className="table-wrap">
                  <table className="data">
                    <thead>
                      <tr>
                        <th>Kind</th>
                        <th>Resource</th>
                        <th>Matched by</th>
                        <th className="num">Remove</th>
                      </tr>
                    </thead>
                    <tbody>
                      {allocated.map((g) => (
                        <tr key={g.id}>
                          <td className="primary" data-label="Kind">
                            {KIND_NOUNS[g.resource_kind] ?? g.resource_kind}
                          </td>
                          <td className="mono" data-label="Resource">
                            {describeGrant(g)}
                          </td>
                          <td className="dim" data-label="Matched by">
                            {g.label_key
                              ? 'label'
                              : g.resource_id && looksLikeId(g.resource_id)
                                ? 'id'
                                : 'name'}
                          </td>
                          <td className="cell-actions" data-label="Remove">
                            <Button
                              size="sm"
                              variant="danger"
                              icon="trash"
                              busy={busy}
                              aria-label={`Remove access to ${describeGrant(g)}`}
                              onClick={() => void removeGrant(g.id)}
                            />
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}

              <h4 style={{ marginBottom: 4 }}>Give access to</h4>
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
                <TextField
                  label="Filter"
                  value={query}
                  onChange={(e) => setQuery(e.target.value)}
                  placeholder="name or image"
                  spellCheck={false}
                />
              </div>

              {listsBusy ? (
                <p className="dim">Reading {KIND_NOUNS[kind]} from the host.</p>
              ) : pickable.length === 0 ? (
                <p className="dim" style={{ marginTop: 0 }}>
                  {query.trim()
                    ? `No ${KIND_NOUNS[kind]} match "${query.trim()}".`
                    : `There are no ${KIND_NOUNS[kind]} on this host.`}
                </p>
              ) : (
                <div className="pick-list">
                  {pickable.map((item) => {
                    const granted = grantedIds.has(item.id);
                    return (
                      <label className="checkbox pick-row" key={item.id}>
                        <input
                          type="checkbox"
                          checked={granted}
                          disabled={Boolean(pending[item.id])}
                          aria-label={`${item.name} for ${user.email}`}
                          onChange={(e) => void toggleResource(item, e.target.checked)}
                        />
                        <span className="pick-name">{item.name}</span>
                        <span className="pick-detail">{item.detail}</span>
                      </label>
                    );
                  })}
                </div>
              )}

              <div className="row" style={{ marginTop: 12 }}>
                <Button
                  size="sm"
                  variant="subtle"
                  icon={advanced ? 'chevron-down' : 'chevron-right'}
                  aria-expanded={advanced}
                  onClick={() => setAdvanced(!advanced)}
                >
                  Advanced: match by label
                </Button>
              </div>

              {advanced ? (
                <div className="advanced-block">
                  <p className="dim" style={{ marginTop: 0, fontSize: 'var(--fs-xs)' }}>
                    Ticking above matches a {kind} by name, so renaming or recreating it drops the
                    grant, and a {kind} this user creates themselves stays hidden until you tick it.
                    A label avoids both: it keeps matching through a recreate, and anything they
                    create afterwards inherits it. This applies to {KIND_NOUNS[kind]}.
                  </p>
                  <div className="grid grid-2">
                    <SelectField
                      label="Match on"
                      value={selector}
                      onChange={(e) => setSelector(e.target.value as 'label' | 'id')}
                    >
                      <option value="label">Label</option>
                      <option value="id">Exact id, name or slug</option>
                    </SelectField>
                    {selector === 'id' ? (
                      <TextField
                        label="Id, name or slug"
                        value={resourceId}
                        onChange={(e) => setResourceId(e.target.value)}
                        placeholder="redis"
                        spellCheck={false}
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
                      placeholder="platform"
                      spellCheck={false}
                    />
                  ) : null}
                  <Button
                    variant="primary"
                    icon="plus"
                    disabled={!canAddAdvanced}
                    busy={busy}
                    onClick={() => void addLabelGrant()}
                  >
                    Add
                  </Button>
                </div>
              ) : null}
            </>
          )}
        </>
      ) : null}
    </Dialog>
  );
}
