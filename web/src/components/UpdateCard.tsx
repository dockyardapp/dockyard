import { useEffect, useState } from 'react';
import { endpoints, errorMessage } from '../api/client';
import type { UpdateJob, UpdateStatus } from '../api/types';
import { usePolling } from '../hooks/usePolling';
import { formatDateTime, pluralize, relativeTime } from '../lib/format';
import { Banner, Button, Card, Pill, SkeletonRows, useConfirm } from './ui';

const JOB_PILL: Record<UpdateJob['state'], string> = {
  queued: 'created',
  running: 'starting',
  success: 'running',
  failed: 'error',
  'rolled-back': 'partial',
  stale: 'error',
};

const JOB_TITLE: Record<UpdateJob['state'], string> = {
  queued: 'Update requested',
  running: 'Updating',
  success: 'Update finished',
  failed: 'Update failed',
  'rolled-back': 'Update failed and was rolled back',
  stale: 'The updater stopped reporting',
};

/** Poll hard while a job is in flight, slowly otherwise. */
function intervalFor(jobState: UpdateJob['state'] | undefined): number {
  return jobState === 'queued' || jobState === 'running' ? 5_000 : 30_000;
}

/**
 * Which build is running, what is upstream, and how to move to it.
 *
 * The panel cannot replace its own container, so "Install update" writes a request that a host
 * updater collects. Everything here is written to say exactly that, including when no updater is
 * installed: a button that silently does nothing is worse than a disabled one.
 */
export function UpdateCard() {
  const confirm = useConfirm();
  const [intervalMs, setIntervalMs] = useState(30_000);
  const status = usePolling<UpdateStatus>(() => endpoints.system.update(), { intervalMs });
  const [busy, setBusy] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const data = status.data;
  const jobState = data?.job?.state;
  // Speed up while a job runs, so the operator watches the steps instead of a 30s-stale line.
  useEffect(() => {
    setIntervalMs(intervalFor(jobState));
  }, [jobState]);

  const install = async () => {
    if (!data) return;
    const ok = await confirm({
      title: 'Install the update?',
      body:
        `The host will pull ${data.check.branch}, rebuild the panel image and restart it. ` +
        'The panel is unreachable for the length of a build. If the new build fails its health ' +
        'check the updater rolls back to the build you are running now.',
      confirmLabel: 'Install update',
    });
    if (!ok) return;
    setBusy(true);
    setActionError(null);
    setNotice(null);
    try {
      await endpoints.system.startUpdate();
      setNotice('Update requested. The host updater picks it up within a few seconds.');
      await status.refresh();
    } catch (err) {
      setActionError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Card
      title="Version"
      actions={
        <Button size="sm" busy={status.refreshing} onClick={() => void status.refresh()}>
          Check for updates
        </Button>
      }
    >
      {status.error ? (
        <Banner tone="error" title="Could not read the version">
          {errorMessage(status.error)}
        </Banner>
      ) : null}

      {status.loading && !data ? <SkeletonRows rows={4} cols={2} /> : null}

      {data ? (
        <>
          {data.check.error ? (
            <Banner tone="warn" title="Could not check for updates">
              {data.check.error}
            </Banner>
          ) : null}

          {actionError ? (
            <Banner tone="error" title="Update request failed" onDismiss={() => setActionError(null)}>
              {actionError}
            </Banner>
          ) : null}
          {notice ? (
            <Banner tone="info" onDismiss={() => setNotice(null)}>
              {notice}
            </Banner>
          ) : null}

          <dl className="kv">
            <dt>Running</dt>
            <dd>
              v{data.build.version}
              {data.build.commitShort ? (
                <>
                  {' · '}
                  <a
                    className="link mono-cell"
                    href={`https://github.com/${data.check.repo}/commit/${data.build.commit}`}
                    target="_blank"
                    rel="noreferrer"
                  >
                    {data.build.commitShort}
                  </a>
                </>
              ) : (
                <span className="dim"> · commit unknown</span>
              )}
            </dd>

            <dt>Built</dt>
            <dd className="mono-cell">{data.build.builtAt ? formatDateTime(data.build.builtAt) : '-'}</dd>

            <dt>Source</dt>
            <dd>
              <a className="link" href={`https://github.com/${data.check.repo}`} target="_blank" rel="noreferrer">
                {data.check.repo}
              </a>
              {' · '}
              <span className="mono-cell">{data.check.branch}</span>
              {data.check.authenticated ? null : <span className="dim"> · anonymous check</span>}
            </dd>

            <dt>Upstream</dt>
            <dd>
              {data.check.latest ? (
                <>
                  {data.check.latest.version ? `v${data.check.latest.version} · ` : ''}
                  <a
                    className="link mono-cell"
                    href={data.check.latest.url}
                    target="_blank"
                    rel="noreferrer"
                  >
                    {data.check.latest.commitShort}
                  </a>
                </>
              ) : (
                <span className="dim">unknown</span>
              )}
            </dd>

            <dt>Checked</dt>
            <dd className="dim">{relativeTime(data.check.checkedAt)}</dd>
          </dl>

          <UpdateState data={data} />

          {data.job ? <JobBanner job={data.job} /> : null}

          <div className="row" style={{ marginTop: 'var(--space-4)', alignItems: 'center' }}>
            {data.canUpdate ? (
              <Button
                variant="primary"
                icon="refresh"
                busy={busy}
                disabled={!canInstall(data)}
                title={installHint(data)}
                onClick={() => void install()}
              >
                Install update
              </Button>
            ) : null}
            {data.canUpdate ? <span className="dim" style={{ fontSize: 'var(--fs-xs)' }}>{installHint(data)}</span> : null}
          </div>
        </>
      ) : null}
    </Card>
  );
}

function canInstall(data: UpdateStatus): boolean {
  return data.check.status === 'behind' && data.updater.installed && data.updater.enabled;
}

function installHint(data: UpdateStatus): string {
  if (!data.updater.enabled) return 'Updates are disabled on this host (DOCKYARD_UPDATE_ENABLED=false).';
  if (!data.updater.installed) {
    // Name the situation, not just the fix: an operator who sees commits waiting above a disabled
    // button needs to know the reason is the host, not the panel.
    return data.check.status === 'behind'
      ? 'An update is ready, but no updater is installed on this host. Run deploy/install-updater.sh there, or deploy/update.sh to update by hand.'
      : 'No updater is installed on this host. Run deploy/install-updater.sh there, or deploy/update.sh to update by hand.';
  }
  if (data.check.status === 'behind') return `Pulls ${data.check.branch} and rebuilds the panel.`;
  return 'Nothing to install.';
}

function UpdateState({ data }: { data: UpdateStatus }) {
  const { check } = data;

  if (check.status === 'current') {
    return (
      <p className="muted" style={{ fontSize: 'var(--fs-xs)', marginTop: 'var(--space-4)' }}>
        This build is the tip of {check.branch}.
      </p>
    );
  }

  if (check.status === 'ahead') {
    return (
      <p className="muted" style={{ fontSize: 'var(--fs-xs)', marginTop: 'var(--space-4)' }}>
        This build is {pluralize(check.aheadBy, 'commit')} ahead of {check.branch}, so there is
        nothing to pull.
      </p>
    );
  }

  if (check.status === 'diverged') {
    return (
      <p className="muted" style={{ fontSize: 'var(--fs-xs)', marginTop: 'var(--space-4)' }}>
        This build has diverged from {check.branch}: {pluralize(check.aheadBy, 'commit')} of its own
        and {pluralize(check.behindBy, 'commit')} upstream. Pulling the branch tip would not
        fast-forward, so update the checkout by hand.
      </p>
    );
  }

  if (check.status === 'unknown') {
    return (
      <p className="muted" style={{ fontSize: 'var(--fs-xs)', marginTop: 'var(--space-4)' }}>
        {data.build.pinned
          ? `The running commit could not be compared with ${check.branch}.`
          : 'This build carries no commit stamp, so it cannot be compared with the branch. Rebuild the image with the GIT_COMMIT build argument to enable update checks.'}
      </p>
    );
  }

  return (
    <>
      <div className="row" style={{ marginTop: 'var(--space-4)', gap: 'var(--space-2)' }}>
        <Pill tone="info">{pluralize(check.behindBy, 'commit')} behind</Pill>
        <span className="dim" style={{ fontSize: 'var(--fs-xs)' }}>
          Pulling {check.branch} brings the commits below.
        </span>
      </div>
      {check.commits.length > 0 ? (
        <div className="table-wrap" style={{ marginTop: 'var(--space-3)' }}>
          <table className="data">
            <thead>
              <tr>
                <th>Commit</th>
                <th>Subject</th>
                <th>Author</th>
                <th>Date</th>
              </tr>
            </thead>
            <tbody>
              {check.commits.slice(0, 20).map((c) => (
                <tr key={c.sha}>
                  <td className="mono-cell" data-label="Commit">
                    <a className="link" href={c.url} target="_blank" rel="noreferrer">
                      {c.commitShort}
                    </a>
                  </td>
                  <td data-label="Subject">{c.subject}</td>
                  <td className="dim" data-label="Author">
                    {c.author || '-'}
                  </td>
                  <td className="dim nowrap" data-label="Date">
                    {formatDateTime(c.date)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : null}
      {check.commits.length > 20 ? (
        <p className="dim" style={{ fontSize: 'var(--fs-xs)', marginTop: 'var(--space-2)' }}>
          and {pluralize(check.commits.length - 20, 'more commit')}.
        </p>
      ) : null}
    </>
  );
}

function JobBanner({ job }: { job: UpdateJob }) {
  const tone = job.state === 'failed' || job.state === 'stale' ? 'error' : job.state === 'rolled-back' ? 'warn' : 'info';
  const detail: string[] = [];
  if (job.state === 'queued') detail.push('Waiting for the host updater to pick the request up.');
  if (job.state === 'running') detail.push(job.step ? `Step: ${job.step}.` : 'Running.');
  if (job.message) detail.push(job.message);
  if (job.to.commit) {
    detail.push(
      `Target ${job.to.version ? `v${job.to.version} ` : ''}${job.to.commit.slice(0, 7)}.`,
    );
  }
  if (job.requestedBy) detail.push(`Requested by ${job.requestedBy}.`);
  if (job.finishedAt) detail.push(`Finished ${relativeTime(job.finishedAt)}.`);

  return (
    <div style={{ marginTop: 'var(--space-4)' }}>
      <Banner tone={tone} title={JOB_TITLE[job.state]}>
        <div className="row" style={{ gap: 'var(--space-2)', alignItems: 'center' }}>
          <Pill state={JOB_PILL[job.state]}>{job.state}</Pill>
          <span>{detail.join(' ')}</span>
        </div>
        {job.log ? (
          <details style={{ marginTop: 'var(--space-2)' }}>
            <summary style={{ cursor: 'pointer', fontSize: 'var(--fs-xs)' }}>Updater log</summary>
            <pre className="update-log">{job.log}</pre>
          </details>
        ) : null}
      </Banner>
    </div>
  );
}
