import { useMemo, useState } from 'react';
import { endpoints, errorMessage } from '../api/client';
import type { ImageSummary } from '../api/types';
import { usePolling } from '../hooks/usePolling';
import { useRowCap } from '../hooks/useRowCap';
import { RowCapNotice } from '../components/RowCapNotice';
import { useEvents } from '../hooks/useEvents';
import { useAuth } from '../hooks/useAuth';
import { can } from '../lib/rbac';
import {
  Banner,
  Button,
  Card,
  EmptyState,
  PageHead,
  SkeletonRows,
  TextField,
  useConfirm,
} from '../components/ui';
import { formatBytes, formatDateTime, matchesQuery, shortId } from '../lib/format';

export function ImagesPage() {
  const { user } = useAuth();
  const confirm = useConfirm();
  const canWrite = can.write(user?.role);
  const canDestroy = can.destroy(user?.role);

  const [query, setQuery] = useState('');
  const [pullRef, setPullRef] = useState('');
  const [pullBusy, setPullBusy] = useState(false);
  const [pending, setPending] = useState<Record<string, boolean>>({});
  const [notice, setNotice] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const list = usePolling<ImageSummary[]>(() => endpoints.images.list(), { intervalMs: 20000 });

  useEvents((ev) => {
    if (ev.type === 'container') void list.refresh();
  });

  const filtered = useMemo(() => {
    const rows = list.data ?? [];
    return rows.filter((i) => matchesQuery(query, ...i.repoTags, i.id));
  }, [list.data, query]);

  const capped = useRowCap(filtered);

  const pull = async () => {
    const ref = pullRef.trim();
    if (!ref) return;
    setPullBusy(true);
    setError(null);
    setNotice(null);
    try {
      await endpoints.images.pull(ref);
      setNotice(`Pulled ${ref}.`);
      setPullRef('');
      await list.refresh();
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setPullBusy(false);
    }
  };

  const removeImage = async (img: ImageSummary) => {
    const label = img.repoTags[0] ?? shortId(img.id);
    const ok = await confirm({
      title: `Delete image ${label}?`,
      body: img.containers > 0 ? `${img.containers} container(s) reference this image. Force removal may break them.` : 'The image is removed from the host.',
      confirmLabel: 'Delete image',
      danger: true,
    });
    if (!ok) return;
    setPending((p) => ({ ...p, [`${img.id}:remove`]: true }));
    setError(null);
    try {
      await endpoints.images.remove(img.id, { force: img.containers > 0 });
      await list.refresh();
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setPending((p) => ({ ...p, [`${img.id}:remove`]: false }));
    }
  };

  return (
    <>
      <PageHead
        title="Images"
        desc={list.data ? `${filtered.length} of ${list.data.length} images` : 'Local Docker images'}
        actions={
          <Button icon="refresh" busy={list.refreshing} onClick={() => void list.refresh()}>
            Refresh
          </Button>
        }
      />

      {error ? (
        <Banner tone="error" title="Image action failed" onDismiss={() => setError(null)}>
          {error}
        </Banner>
      ) : null}
      {notice ? (
        <Banner tone="info" onDismiss={() => setNotice(null)}>
          {notice}
        </Banner>
      ) : null}
      {list.error ? (
        <Banner tone="error" title="Could not load images" onDismiss={() => void list.refresh()}>
          {errorMessage(list.error)}
        </Banner>
      ) : null}

      <Card title="Pull an image">
        <div className="row" style={{ gap: 'var(--space-2)', alignItems: 'flex-end' }}>
          <div style={{ flex: '1 1 320px' }}>
            <TextField
              label="Image reference"
              value={pullRef}
              onChange={(e) => setPullRef(e.target.value)}
              placeholder="nginx:alpine"
              disabled={!canWrite || pullBusy}
              onKeyDown={(e) => {
                if (e.key === 'Enter') void pull();
              }}
              hint="Pulling can take up to two minutes."
            />
          </div>
          <Button variant="primary" icon="download" busy={pullBusy} disabled={!canWrite || !pullRef.trim()} onClick={() => void pull()}>
            Pull
          </Button>
        </div>
      </Card>

      <div className="toolbar" style={{ marginTop: 'var(--space-4)' }}>
        <input
          type="search"
          className="search-input"
          placeholder="Filter by tag or id"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          aria-label="Filter images"
        />
      </div>

      <Card flush>
        {list.loading && !list.data ? (
          <SkeletonRows rows={6} cols={5} />
        ) : list.error && !list.data ? null : filtered.length === 0 ? (
          <div style={{ padding: 'var(--space-4)' }}>
            <EmptyState
              icon="image"
              title={list.data && list.data.length > 0 ? 'No images match' : 'No images on the host'}
              action={
                list.data && list.data.length > 0 ? (
                  <Button onClick={() => setQuery('')}>Clear filter</Button>
                ) : (
                  <Button onClick={() => setPullRef('nginx:alpine')} disabled={!canWrite}>
                    Suggest a pull
                  </Button>
                )
              }
            >
              {list.data && list.data.length > 0
                ? 'Adjust the filter text to see other images.'
                : 'Pull an image by reference to get started.'}
            </EmptyState>
          </div>
        ) : (
          <div className="table-wrap">
            <table className="data">
              <thead>
                <tr>
                  <th>Repository</th>
                  <th>Tag</th>
                  <th>Image id</th>
                  <th className="num">Size</th>
                  <th className="num">Containers</th>
                  <th>Created</th>
                  <th className="num">Actions</th>
                </tr>
              </thead>
              <tbody>
                {capped.visible.map((img) => {
                  const tag = img.repoTags[0];
                  const repo = tag ? tag.split(':').slice(0, -1).join(':') || '<none>' : '<none>';
                  const tagName = tag ? tag.split(':').pop() : '<none>';
                  return (
                    <tr key={img.id}>
                      <td className="primary mono-cell" data-label="Repository">
                        <span className="truncate" title={tag ?? img.id}>{repo}</span>
                        {img.dangling ? <span className="tag" style={{ marginLeft: 6 }}>dangling</span> : null}
                      </td>
                      <td className="mono-cell" data-label="Tag">{tagName}</td>
                      <td className="mono-cell" data-label="Image id" title={img.id}>
                        {shortId(img.id)}
                      </td>
                      <td className="num tnum" data-label="Size">{formatBytes(img.size)}</td>
                      <td className="num tnum" data-label="Containers">
                        {img.containers < 0 ? <span className="dim">unknown</span> : img.containers}
                      </td>
                      <td className="dim nowrap" data-label="Created">{formatDateTime(img.created)}</td>
                      <td className="cell-actions" data-label="Actions">
                        <Button
                          size="sm"
                          variant="danger"
                          icon="trash"
                          disabled={!canDestroy || pending[`${img.id}:remove`]}
                          busy={pending[`${img.id}:remove`]}
                          aria-label={`Delete image ${img.id.slice(0, 12)}`}
                          title={canDestroy ? 'Delete image' : 'Requires the admin role'}
                          onClick={() => void removeImage(img)}
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
              noun="images"
              onShowAll={capped.showAll}
            />
          </div>
        )}
      </Card>
    </>
  );
}
