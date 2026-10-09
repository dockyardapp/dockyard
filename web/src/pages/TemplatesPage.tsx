import { useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { endpoints, errorMessage } from '../api/client';
import type {
  DeployResponse,
  Template,
  TemplateCategory,
  TemplateFileSync,
  TemplateFilesStatus,
  TemplateRemoteStatus,
  TemplateSource,
  TemplateSpec,
} from '../api/types';
import { usePolling } from '../hooks/usePolling';
import { useRowCap } from '../hooks/useRowCap';
import { RowCapNotice } from '../components/RowCapNotice';
import { useAuth } from '../hooks/useAuth';
import { atLeast, can } from '../lib/rbac';
import { Icon } from '../components/Icons';
import { TemplateLogo } from '../components/TemplateLogo';
import {
  Banner,
  Button,
  Card,
  Dialog,
  EmptyState,
  Field,
  PageHead,
  SkeletonRows,
  TextField,
  useConfirm,
} from '../components/ui';
import { matchesQuery } from '../lib/format';

const CATEGORIES: Array<TemplateCategory | 'all'> = [
  'all',
  'database',
  'web',
  'monitoring',
  'storage',
  'devtools',
  'messaging',
  'other',
];

export function TemplatesPage() {
  const { user } = useAuth();
  const confirm = useConfirm();
  const canWrite = can.write(user?.role);
  const canDestroy = can.destroy(user?.role);

  const [category, setCategory] = useState<TemplateCategory | 'all'>('all');
  const [source, setSource] = useState<'all' | TemplateSource>('all');
  const [query, setQuery] = useState('');
  const [active, setActive] = useState<Template | null>(null);
  const [editorOpen, setEditorOpen] = useState(false);
  const [editTarget, setEditTarget] = useState<Template | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [reloadNote, setReloadNote] = useState<string | null>(null);
  const [reloadingFiles, setReloadingFiles] = useState(false);
  const [pullingRemote, setPullingRemote] = useState(false);

  const canManageSources = atLeast(user?.role, 'admin');

  const list = usePolling<Template[]>(() => endpoints.templates.list(), { intervalMs: 60000 });
  const files = usePolling<TemplateFilesStatus>(() => endpoints.templates.files(), { intervalMs: 120000 });

  const reloadFiles = async () => {
    setReloadingFiles(true);
    setError(null);
    setReloadNote(null);
    try {
      const report = await endpoints.templates.reloadFiles();
      await Promise.all([files.refresh(), list.refresh()]);
      setReloadNote(describeSync(report));
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setReloadingFiles(false);
    }
  };

  const pullRemote = async () => {
    setPullingRemote(true);
    setError(null);
    setReloadNote(null);
    try {
      const { pull, reconcile } = await endpoints.templates.pullRemote();
      await Promise.all([files.refresh(), list.refresh()]);
      // A failed pull still returns 200: the cached copy keeps being served, so report the failure
      // rather than a count of what did not change.
      setReloadNote(pull.stale ? pull.message : describeSync(reconcile));
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setPullingRemote(false);
    }
  };

  const filtered = useMemo(() => {
    const rows = list.data ?? [];
    return rows.filter(
      (t) =>
        (category === 'all' || t.category === category) &&
        (source === 'all' || t.source === source) &&
        matchesQuery(query, t.name, t.slug, t.description, t.category),
    );
  }, [list.data, category, source, query]);

  const capped = useRowCap(filtered);

  const removeTemplate = async (t: Template) => {
    const ok = await confirm({
      title: `Delete template ${t.name}?`,
      body: 'This removes the template permanently. Templates that come from a file are removed by deleting the file, and built-in templates cannot be deleted.',
      confirmLabel: 'Delete template',
      danger: true,
    });
    if (!ok) return;
    setError(null);
    try {
      await endpoints.templates.remove(t.slug);
      await list.refresh();
    } catch (err) {
      setError(errorMessage(err));
    }
  };

  return (
    <>
      <PageHead
        title="Templates"
        desc={list.data ? `${filtered.length} of ${list.data.length} templates` : 'Deploy a container from a template'}
        actions={
          <>
            <Button icon="refresh" busy={list.refreshing} onClick={() => void list.refresh()}>
              Refresh
            </Button>
            <Button
              variant="primary"
              icon="plus"
              disabled={!canWrite}
              onClick={() => {
                setEditTarget(null);
                setEditorOpen(true);
              }}
            >
              New template
            </Button>
          </>
        }
      />

      {error ? (
        <Banner tone="error" title="Template action failed" onDismiss={() => setError(null)}>
          {error}
        </Banner>
      ) : null}
      {list.error ? (
        <Banner tone="error" title="Could not load templates" onDismiss={() => void list.refresh()}>
          {errorMessage(list.error)}
        </Banner>
      ) : null}
      {reloadNote ? (
        <Banner tone="info" title="Template sources updated" onDismiss={() => setReloadNote(null)}>
          {reloadNote}
        </Banner>
      ) : null}

      <div className="filter-bar">
        {CATEGORIES.map((c) => (
          <button
            key={c}
            className="chip"
            aria-pressed={category === c}
            onClick={() => setCategory(c)}
          >
            {c}
          </button>
        ))}
        <div className="spacer" style={{ flex: 1 }} />
        <select value={source} onChange={(e) => setSource(e.target.value as typeof source)} aria-label="Filter by source" style={{ width: 'auto' }}>
          <option value="all">all sources</option>
          <option value="builtin">built-in</option>
          <option value="file">from a file</option>
          <option value="remote">from the repo</option>
          <option value="user">user</option>
        </select>
        <input
          type="search"
          className="search-input"
          placeholder="Search templates"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          aria-label="Search templates"
        />
      </div>

      {list.loading && !list.data ? (
        <Card>
          <SkeletonRows rows={6} cols={4} />
        </Card>
      ) : list.error && !list.data ? null : filtered.length === 0 ? (
        <EmptyState
          icon="template"
          title="No templates match"
          action={
            <Button
              onClick={() => {
                setCategory('all');
                setSource('all');
                setQuery('');
              }}
            >
              Clear filters
            </Button>
          }
        >
          Change the category, source or search text to find a template.
        </EmptyState>
      ) : (
        <div className="grid grid-auto">
          {capped.visible.map((t) => (
            <div className="tpl-card" key={t.id}>
              <div className="tpl-head">
                <TemplateLogo slug={t.slug} spec={t.spec} fallback={t.icon} />
                <div style={{ minWidth: 0 }}>
                  <div className="tpl-name truncate" title={t.name}>
                    {t.name}
                  </div>
                  <div className="row" style={{ gap: 'var(--space-2)', marginTop: 2 }}>
                    <span className="tag">{t.category}</span>
                    {t.source === 'builtin' ? <span className="tag">built-in</span> : null}
                    {t.source === 'file' ? (
                      <span className="tag" title="Loaded from a JSON file in the template directory">
                        from a file
                      </span>
                    ) : null}
                    {t.source === 'remote' ? (
                      <span className="tag" title="Pulled from the template repository">
                        from the repo
                      </span>
                    ) : null}
                  </div>
                </div>
              </div>
              <p className="tpl-desc">{t.description || 'No description.'}</p>
              <div className="tpl-meta">
                <span className="mono-cell">
                  {t.spec.image}:{t.spec.tag}
                </span>
              </div>
              <div className="btn-row">
                <Button
                  variant="primary"
                  size="sm"
                  icon="play"
                  disabled={!canWrite}
                  onClick={() => setActive(t)}
                >
                  Deploy
                </Button>
                {t.source === 'user' ? (
                  <>
                    <Button size="sm" disabled={!canWrite} onClick={() => { setEditTarget(t); setEditorOpen(true); }}>
                      Edit
                    </Button>
                    <Button size="sm" variant="danger" icon="trash" disabled={!canDestroy} onClick={() => void removeTemplate(t)}>
                      Delete
                    </Button>
                  </>
                ) : null}
              </div>
            </div>
          ))}
        </div>
      )}

      <RowCapNotice
        hidden={capped.hiddenCount}
        total={filtered.length}
        noun="templates"
        onShowAll={capped.showAll}
      />

      <TemplateSourcesCard
        status={files.data}
        loading={files.loading && !files.data}
        error={files.error}
        canManage={canManageSources}
        reloading={reloadingFiles}
        pulling={pullingRemote}
        onReload={() => void reloadFiles()}
        onPull={() => void pullRemote()}
      />

      {active ? (
        <DeployDrawer
          template={active}
          onClose={() => setActive(null)}
          onDeployed={() => {
            setActive(null);
            void list.refresh();
          }}
        />
      ) : null}

      <TemplateEditor
        open={editorOpen}
        template={editTarget}
        onClose={() => setEditorOpen(false)}
        onSaved={() => {
          setEditorOpen(false);
          void list.refresh();
        }}
      />
    </>
  );
}

/* -------------------------------------------------------- template sources card */

/**
 * A plain-language summary of what a reconcile did, used for the banner after a manual reload and
 * for the card's own "last reconcile" line.
 */
function describeSync(report: TemplateFileSync): string {
  const files = `${report.files} ${report.files === 1 ? 'file' : 'files'}`;
  const templates = `${report.templates} ${report.templates === 1 ? 'template' : 'templates'}`;
  const parts: string[] = [];
  if (report.inserted > 0) parts.push(`${report.inserted} added`);
  if (report.updated > 0) parts.push(`${report.updated} updated`);
  if (report.removed.length > 0) parts.push(`${report.removed.length} removed`);
  if (report.overrides.length > 0) parts.push(`${report.overrides.length} replacing a built-in`);
  if (report.skippedUser.length > 0) parts.push(`${report.skippedUser.length} skipped, edited in the panel`);
  if (report.errors.length > 0) parts.push(`${report.errors.length} rejected`);
  return parts.length === 0
    ? `Read ${files} holding ${templates}. Nothing changed.`
    : `Read ${files} holding ${templates}: ${parts.join(', ')}.`;
}

function when(iso: string | null | undefined): string {
  if (!iso) return 'never';
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? iso : d.toLocaleString();
}

/** The repository half of the card: what is being pulled, and what came of the last pull. */
function TemplateRepoSection({ remote }: { remote: TemplateRemoteStatus | null | undefined }) {
  if (!remote) return null;

  if (!remote.enabled) {
    return (
      <p className="dim" style={{ fontSize: 'var(--fs-xs)', marginTop: 0 }}>
        No template repository is configured. Set <code>DOCKYARD_TEMPLATES_REPO</code> to pull
        templates from one.
      </p>
    );
  }

  const pull = remote.pull;

  return (
    <>
      <p className="dim" style={{ fontSize: 'var(--fs-xs)', marginTop: 0 }}>
        Templates are also pulled from{' '}
        <a href={`https://github.com/${remote.repo}`} target="_blank" rel="noreferrer">
          {remote.repo}
        </a>{' '}
        on <code>{remote.branch}</code>, refreshed at most every {remote.refreshMinutes} minutes. A
        template pushed there appears here on the next refresh, or immediately with Pull now. Your
        own files and anything you edited here always win over the repository copy.
      </p>

      <dl className="kv">
        <dt>Repository</dt>
        <dd className="mono-cell">{remote.repo}</dd>
        <dt>Branch</dt>
        <dd className="mono-cell">{remote.branch}</dd>
        <dt>Loaded from it</dt>
        <dd>
          {remote.cached} {remote.cached === 1 ? 'template' : 'templates'}
        </dd>
        <dt>Last pull</dt>
        <dd>
          {when(pull?.at)}
          {pull?.commit ? <span className="mono-cell"> at {pull.commit.slice(0, 7)}</span> : null}
        </dd>
      </dl>

      {pull?.stale ? (
        <Banner tone="warn" title="The last pull failed, so the cached copy is still in use">
          {pull.message}
        </Banner>
      ) : null}

      {remote.errors.length > 0 ? (
        <Banner tone="error" title="Some files from the repository were rejected">
          <div className="stack" style={{ gap: 2 }}>
            {remote.errors.map((entry) => (
              <span key={entry.file} className="mono-cell" style={{ fontSize: 'var(--fs-micro)' }}>
                {entry.file}: {entry.errors.join('; ')}
              </span>
            ))}
          </div>
        </Banner>
      ) : null}
      </>
    );
  }

function TemplateSourcesCard({
  status,
  loading,
  error,
  canManage,
  reloading,
  pulling,
  onReload,
  onPull,
}: {
  status: TemplateFilesStatus | null | undefined;
  loading: boolean;
  error: unknown;
  canManage: boolean;
  reloading: boolean;
  pulling: boolean;
  onReload: () => void;
  onPull: () => void;
}) {
  const remote = status?.remote;

  return (
    <div style={{ marginTop: 'var(--space-5)' }}>
      <Card
        title="Template sources"
        actions={
          <>
            <Button size="sm" icon="refresh" busy={pulling} disabled={!canManage || !remote?.enabled} onClick={onPull}>
              Pull now
            </Button>
            <Button size="sm" icon="refresh" busy={reloading} disabled={!canManage} onClick={onReload}>
              Reload files
            </Button>
          </>
        }
      >
        {error ? (
          <Banner tone="error" title="Could not read the template sources">
            {errorMessage(error)}
          </Banner>
        ) : loading ? (
          <SkeletonRows rows={3} cols={3} />
        ) : !status ? null : (
          <>
            <h3 style={{ marginTop: 0 }}>Template repository</h3>
            <TemplateRepoSection remote={remote} />

            <h3 style={{ marginTop: 'var(--space-5)' }}>Local files</h3>
            <p className="dim" style={{ fontSize: 'var(--fs-xs)', marginTop: 0 }}>
              Templates can also come from JSON files. Put a <code>*.json</code> file in{' '}
              <code>{status.dir}</code> and it appears in the list above with no rebuild and no
              restart. One file can hold a single template, an array of them, or{' '}
              <code>{'{ "templates": [ ... ] }'}</code>. Naming a file with a leading <code>.</code>{' '}
              or <code>_</code> parks it, so it is ignored but kept. A local file overrides a
              template of the same name from the repository.
            </p>

            {!status.exists ? (
              <Banner tone="warn" title="The template directory does not exist">
                Create <code>{status.dir}</code> and put a template file in it. In a Compose
                deployment that is the <code>data/templates</code> folder next to the compose file.
              </Banner>
            ) : status.entries.length === 0 ? (
              <p className="dim" style={{ fontSize: 'var(--fs-xs)', marginBottom: 0 }}>
                No template files in <code>{status.dir}</code> yet.
              </p>
            ) : (
              <div className="table-wrap">
                <table className="data">
                  <thead>
                    <tr>
                      <th>File</th>
                      <th>Templates</th>
                      <th>Status</th>
                    </tr>
                  </thead>
                  <tbody>
                    {status.entries.map((entry) => (
                      <tr key={entry.file}>
                        <td className="mono-cell">{entry.file}</td>
                        <td className="mono-cell">
                          {entry.templates.length > 0 ? entry.templates.join(', ') : '-'}
                        </td>
                        <td>
                          {entry.errors.length === 0 ? (
                            <span className="pill pill-running">loaded</span>
                          ) : (
                            <span className="pill pill-error">error</span>
                          )}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}

            {status.errors.length > 0 ? (
              <div style={{ marginTop: 'var(--space-3)' }}>
                <Banner tone="error" title="Some files were rejected">
                  <div className="stack" style={{ gap: 2 }}>
                    {status.errors.map((entry) => (
                      <span key={entry.file} className="mono-cell" style={{ fontSize: 'var(--fs-micro)' }}>
                        {entry.file}: {entry.errors.join('; ')}
                      </span>
                    ))}
                  </div>
                </Banner>
              </div>
            ) : null}

            {status.parked.length > 0 ? (
              <p className="dim" style={{ fontSize: 'var(--fs-micro)', marginBottom: 0 }}>
                Parked: <code>{status.parked.join(', ')}</code>
              </p>
            ) : null}

            {status.lastSync ? (
              <p className="dim" style={{ fontSize: 'var(--fs-micro)', marginBottom: 0 }}>
                Last local reconcile at {when(status.lastSync.at)}. {describeSync(status.lastSync)}
              </p>
            ) : null}

            {remote?.lastSync ? (
              <p className="dim" style={{ fontSize: 'var(--fs-micro)', marginBottom: 0 }}>
                Last repository reconcile at {when(remote.lastSync.at)}.{' '}
                {describeSync(remote.lastSync)}
              </p>
            ) : null}
          </>
        )}
      </Card>
    </div>
  );
}

/* --------------------------------------------------------------- deploy drawer */

type Rendered = {
  image: string;
  env: Array<{ key: string; value: string; secret: boolean }>;
  ports: Array<{ container: number; host?: number }>;
  volumes: Array<{ container: string; host?: string; named?: boolean }>;
  restartPolicy: string;
  missing: string[];
};

function renderPreview(spec: TemplateSpec, values: Record<string, string>): Rendered {
  const env: Rendered['env'] = [];
  const missing: string[] = [];
  for (const e of spec.env) {
    const value = values[e.key] ?? e.default ?? '';
    if (e.required && !value) missing.push(e.key);
    env.push({ key: e.key, value, secret: Boolean(e.secret) });
  }
  const ports = spec.ports.map((p) => {
    const override = values[`port:${p.container}`];
    const host = override ? Number(override) : p.defaultHost;
    return { container: p.container, host: Number.isFinite(host) ? host : undefined };
  });
  const volumes = spec.volumes.map((v) => {
    const override = values[`volume:${v.container}`];
    return { container: v.container, host: override || undefined, named: v.named };
  });
  return {
    image: `${spec.image}:${spec.tag}`,
    env,
    ports,
    volumes,
    restartPolicy: spec.restartPolicy,
    missing,
  };
}

function DeployDrawer({
  template,
  onClose,
  onDeployed,
}: {
  template: Template;
  onClose: () => void;
  onDeployed: () => void;
}) {
  const spec = template.spec;
  const [name, setName] = useState(template.slug);
  const [values, setValues] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<DeployResponse | null>(null);
  /** Host port -> the running container publishing it, so a clash is caught before Docker rejects it. */
  const [published, setPublished] = useState<Map<number, string>>(new Map());

  useEffect(() => {
    let cancelled = false;
    endpoints.containers
      .list({ all: true })
      .then((rows) => {
        if (cancelled) return;
        const used = new Map<number, string>();
        for (const c of rows) {
          // Only a running container holds its host port. A stopped one has released it, and
          // warning about that would stop a legitimate redeploy.
          if (c.state !== 'running') continue;
          for (const p of c.ports) if (p.publicPort) used.set(p.publicPort, c.name);
        }
        setPublished(used);
      })
      .catch(() => {
        // A lookup that fails must not block a deploy. Docker is the authority on a clash anyway, and
        // an empty map just means no warning is shown.
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const preview = renderPreview(spec, values);
  const nameError = !name.trim() ? 'A name is required.' : null;

  // What each declared port will actually publish, and whether something already holds it. This
  // mirrors the server's rule (blank falls back to the template default) so the warning appears
  // against the same value the deploy will use.
  const portRows = spec.ports.map((p) => {
    const entered = values[`port:${p.container}`] ?? '';
    const host = entered === '' ? p.defaultHost : Number(entered);
    const valid = host !== undefined && Number.isInteger(host) && host >= 1 && host <= 65535;
    return { port: p, entered, host, valid, takenBy: valid ? published.get(host) ?? null : null };
  });
  const clash = portRows.find((r) => r.takenBy) ?? null;

  const canDeploy = !nameError && preview.missing.length === 0 && !clash;

  const setValue = (key: string, v: string) => setValues((prev) => ({ ...prev, [key]: v }));

  const deploy = async () => {
    setError(null);
    if (!canDeploy) return;
    setBusy(true);
    try {
      const res = await endpoints.templates.deploy(template.slug, name.trim(), values);
      setResult(res);
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog
      open
      onClose={onClose}
      variant="drawer"
      title={`Deploy ${template.name}`}
      footer={
        result ? (
          <Button variant="primary" onClick={onDeployed}>
            Done
          </Button>
        ) : (
          <>
            <Button onClick={onClose} disabled={busy}>
              Cancel
            </Button>
            <Button variant="primary" icon="play" busy={busy} disabled={!canDeploy} onClick={() => void deploy()}>
              Deploy
            </Button>
          </>
        )
      }
    >
      {error ? <Banner tone="error" title="Deploy failed">{error}</Banner> : null}

      {result ? (
        <Banner tone="info" title="Deployed">
          Stack <code>{result.stack.name}</code> created with container <code>{result.container.name}</code>.{' '}
          <Link to="/stacks">Open stacks</Link>
        </Banner>
      ) : null}

      <TextField
        label="Deployment name"
        value={name}
        onChange={(e) => setName(e.target.value)}
        error={nameError ?? undefined}
        required
        disabled={busy || !!result}
      />

      {spec.env.length > 0 ? (
        <>
          <h3 style={{ margin: 'var(--space-5) 0 var(--space-3)' }}>Environment</h3>
          {spec.env.map((e) => (
            <Field
              key={e.key}
              label={e.label ?? e.key}
              hint={e.description}
              required={e.required}
              htmlFor={`env-${e.key}`}
            >
              <input
                id={`env-${e.key}`}
                type={e.secret ? 'password' : 'text'}
                value={values[e.key] ?? ''}
                placeholder={e.default ?? ''}
                onChange={(ev) => setValue(e.key, ev.target.value)}
                disabled={busy || !!result}
                autoComplete="off"
                className="mono"
              />
            </Field>
          ))}
        </>
      ) : null}

      {spec.ports.length > 0 ? (
        <>
          <h3 style={{ margin: 'var(--space-5) 0 var(--space-2)' }}>Ports</h3>
          <p className="dim" style={{ fontSize: 'var(--fs-xs)', marginTop: 0 }}>
            Published on the host, forwarded to the container. If you plan to tunnel it, a high port
            is easier to keep track of and less likely to be taken.
          </p>
          {portRows.map(({ port: p, host, takenBy }) => (
            <Field
              key={p.container}
              label="Host port"
              error={takenBy ? `Port ${host} is already published by ${takenBy}. Pick another.` : null}
              hint={
                <>
                  {p.label ? `${p.label} listens on ` : 'Listens on '}
                  <span className="mono-cell">{p.container}</span> inside the container.
                  {p.defaultHost
                    ? ` Leave blank to publish it on ${p.defaultHost}.`
                    : ' Leave blank to let Docker choose.'}
                </>
              }
            >
              <div className="row" style={{ gap: 'var(--space-2)', alignItems: 'center' }}>
                <input
                  type="number"
                  min={1}
                  max={65535}
                  style={{ flex: '0 1 9rem' }}
                  aria-label={`Host port for ${p.label ?? `container port ${p.container}`}`}
                  aria-invalid={takenBy ? true : undefined}
                  value={values[`port:${p.container}`] ?? ''}
                  placeholder={p.defaultHost ? String(p.defaultHost) : 'auto'}
                  onChange={(ev) => setValue(`port:${p.container}`, ev.target.value)}
                  disabled={busy || !!result}
                />
                <span className="dim mono-cell" style={{ fontSize: 'var(--fs-xs)' }}>
                  → container {p.container}
                </span>
              </div>
            </Field>
          ))}
        </>
      ) : null}

      {spec.volumes.length > 0 ? (
        <>
          <h3 style={{ margin: 'var(--space-5) 0 var(--space-3)' }}>Volumes</h3>
          {spec.volumes.map((v) => (
            <Field
              key={v.container}
              label={v.named ? 'Volume name' : 'Host path'}
              hint={
                <>
                  {v.label ? `${v.label} is mounted at ` : 'Mounted at '}
                  <span className="mono-cell">{v.container}</span> in the container.
                  {v.named
                    ? ' Leave blank for a generated name.'
                    : ' Leave blank and Docker creates an anonymous volume instead.'}
                </>
              }
            >
              <input
                type="text"
                aria-label={`${v.named ? 'Volume name' : 'Host path'} for ${v.label ?? v.container}`}
                value={values[`volume:${v.container}`] ?? ''}
                placeholder={v.named ? 'auto' : `/srv/${template.slug}`}
                onChange={(ev) => setValue(`volume:${v.container}`, ev.target.value)}
                disabled={busy || !!result}
                className="mono"
              />
            </Field>
          ))}
        </>
      ) : null}

      <h3 style={{ margin: 'var(--space-5) 0 var(--space-3)' }}>Rendered result</h3>
      <Card>
        <dl className="kv">
          <dt>Image</dt>
          <dd className="mono-cell">{preview.image}</dd>
          <dt>Restart policy</dt>
          <dd>{preview.restartPolicy}</dd>
          <dt>Ports</dt>
          <dd className="mono-cell">
            {preview.ports.length === 0
              ? '-'
              : preview.ports
                  .map((p) => `host ${p.host ?? 'auto'} -> container ${p.container}`)
                  .join(', ')}
          </dd>
          <dt>Volumes</dt>
          <dd className="mono-cell">
            {preview.volumes.length === 0
              ? '-'
              : preview.volumes
                  .map((v) =>
                    v.named
                      ? `volume ${v.host ?? 'auto'} -> container ${v.container}`
                      : `host ${v.host ?? 'unset'} -> container ${v.container}`,
                  )
                  .join(', ')}
          </dd>
          <dt>Environment</dt>
          <dd className="mono-cell">
            {preview.env.length === 0 ? (
              '-'
            ) : (
              <div className="stack" style={{ gap: 2 }}>
                {preview.env.map((e) => (
                  <span key={e.key}>
                    {e.key}={e.secret ? (e.value ? '••••••' : '') : e.value || ''}
                  </span>
                ))}
              </div>
            )}
          </dd>
        </dl>
        {preview.missing.length > 0 ? (
          <div style={{ marginTop: 'var(--space-3)' }}>
            <Banner tone="warn" title="Required values missing">
              {preview.missing.join(', ')}
            </Banner>
          </div>
        ) : clash ? (
          <div style={{ marginTop: 'var(--space-3)' }}>
            <Banner tone="warn" title="That host port is taken">
              {clash.takenBy} is already publishing port {clash.host} on this host. Choose a
              different one, or stop that container first.
            </Banner>
          </div>
        ) : (
          <div className="row" style={{ marginTop: 'var(--space-3)', gap: 'var(--space-2)' }}>
            <Icon name="check" size={14} style={{ color: 'var(--state-running-fg)' }} />
            <span className="dim" style={{ fontSize: 'var(--fs-micro)' }}>All required values are set.</span>
          </div>
        )}
      </Card>

      {spec.notes ? (
        <p className="dim" style={{ fontSize: 'var(--fs-xs)', marginTop: 'var(--space-3)' }}>
          {spec.notes}
          {spec.docsUrl ? (
            <>
              {' '}
              <a href={spec.docsUrl} target="_blank" rel="noreferrer">
                Documentation <Icon name="external" size={11} />
              </a>
            </>
          ) : null}
        </p>
      ) : null}
    </Dialog>
  );
}

/* ------------------------------------------------------------- spec editor */

const EMPTY_SPEC = {
  schemaVersion: 1,
  slug: 'my-template',
  name: 'My template',
  category: 'other',
  icon: '📦',
  description: '',
  image: 'nginx',
  tag: 'alpine',
  ports: [],
  env: [],
  volumes: [],
  restartPolicy: 'unless-stopped',
};

function TemplateEditor({
  open,
  template,
  onClose,
  onSaved,
}: {
  open: boolean;
  template: Template | null;
  onClose: () => void;
  onSaved: () => void;
}) {
  const initial = template ? JSON.stringify(template.spec, null, 2) : JSON.stringify(EMPTY_SPEC, null, 2);
  const [text, setText] = useState(initial);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [dirtyKey, setDirtyKey] = useState<string>('');

  // Reset the editor when a different template is opened.
  const key = template?.slug ?? '__new__';
  if (key !== dirtyKey && open) {
    setDirtyKey(key);
    setText(initial);
    setError(null);
  }

  const save = async () => {
    setError(null);
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch (err) {
      setError(`Invalid JSON: ${errorMessage(err)}`);
      return;
    }
    setBusy(true);
    try {
      if (template) await endpoints.templates.update(template.slug, parsed as TemplateSpec);
      else await endpoints.templates.create(parsed as TemplateSpec);
      onSaved();
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
      title={template ? `Edit ${template.name}` : 'New template'}
      footer={
        <>
          <Button onClick={onClose} disabled={busy}>
            Cancel
          </Button>
          <Button variant="primary" busy={busy} onClick={() => void save()}>
            {template ? 'Save changes' : 'Create template'}
          </Button>
        </>
      }
    >
      {error ? <Banner tone="error" title="Could not save">{error}</Banner> : null}
      <p className="dim" style={{ fontSize: 'var(--fs-xs)' }}>
        The editor takes a TemplateSpec JSON document. The server validates it against the schema and
        reports any field it rejects.
      </p>
      <Field label="Template spec (JSON)">
        <textarea
          value={text}
          onChange={(e) => setText(e.target.value)}
          rows={22}
          spellCheck={false}
          style={{ minHeight: 360 }}
        />
      </Field>
    </Dialog>
  );
}
