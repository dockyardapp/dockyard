import { useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { endpoints, errorMessage } from '../api/client';
import type { DeployResponse, Template, TemplateCategory, TemplateSpec } from '../api/types';
import { usePolling } from '../hooks/usePolling';
import { useRowCap } from '../hooks/useRowCap';
import { RowCapNotice } from '../components/RowCapNotice';
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
  const [source, setSource] = useState<'all' | 'builtin' | 'user'>('all');
  const [query, setQuery] = useState('');
  const [active, setActive] = useState<Template | null>(null);
  const [editorOpen, setEditorOpen] = useState(false);
  const [editTarget, setEditTarget] = useState<Template | null>(null);
  const [error, setError] = useState<string | null>(null);

  const list = usePolling<Template[]>(() => endpoints.templates.list(), { intervalMs: 60000 });

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
      body: 'User templates are removed permanently. Built-in templates cannot be deleted.',
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
                <span className="tpl-icon" aria-hidden="true">
                  {t.icon}
                </span>
                <div style={{ minWidth: 0 }}>
                  <div className="tpl-name truncate" title={t.name}>
                    {t.name}
                  </div>
                  <div className="row" style={{ gap: 'var(--space-2)', marginTop: 2 }}>
                    <span className="tag">{t.category}</span>
                    {t.source === 'builtin' ? <span className="tag">built-in</span> : null}
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

  const preview = renderPreview(spec, values);
  const nameError = !name.trim() ? 'A name is required.' : null;
  const canDeploy = !nameError && preview.missing.length === 0;

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
          <h3 style={{ margin: 'var(--space-5) 0 var(--space-3)' }}>Ports</h3>
          {spec.ports.map((p) => (
            <Field key={p.container} label={p.label ?? `Container port ${p.container}`} hint={`Host port (default ${p.defaultHost ?? 'auto'})`}>
              <input
                type="number"
                min={1}
                max={65535}
                value={values[`port:${p.container}`] ?? ''}
                placeholder={p.defaultHost ? String(p.defaultHost) : 'auto'}
                onChange={(ev) => setValue(`port:${p.container}`, ev.target.value)}
                disabled={busy || !!result}
              />
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
              label={v.label ?? v.container}
              hint={v.named ? 'Named volume (leave blank for a generated name)' : 'Host path'}
            >
              <input
                type="text"
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
              : preview.ports.map((p) => `${p.host ?? 'auto'}->${p.container}`).join(', ')}
          </dd>
          <dt>Volumes</dt>
          <dd className="mono-cell">
            {preview.volumes.length === 0
              ? '-'
              : preview.volumes.map((v) => `${v.host ?? (v.named ? 'auto' : '')}${v.host || v.named ? ':' : ''}${v.container}`).join(', ')}
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
