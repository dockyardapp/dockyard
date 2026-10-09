import { Link } from 'react-router-dom';
import { endpoints } from '../api/client';
import type { UpdateStatus } from '../api/types';
import { usePolling } from '../hooks/usePolling';
import { formatDateTime } from '../lib/format';

/**
 * The running build, in the top bar of every page.
 *
 * Which commit is deployed is the first question anyone asks when something looks wrong, so it
 * sits in the chrome rather than behind a settings screen. It reads the same payload the update
 * card uses, and that payload always carries `build` even when the upstream check fails, so the
 * version stays visible on a host with no route to GitHub.
 *
 * Polls slowly: the server memoises the upstream check for a minute, and a version does not change
 * under the operator's feet except during an update they started themselves.
 */
export function VersionBadge() {
  const { data } = usePolling<UpdateStatus>(() => endpoints.system.update(), { intervalMs: 300_000 });
  if (!data) return null;

  const { build, check } = data;
  const behind = check.status === 'behind';
  const text = `v${build.version}${build.commitShort ? ` · ${build.commitShort}` : ''}`;
  const title = [
    `Dockyard ${build.version}`,
    build.commit ? `commit ${build.commitShort}` : 'running commit unknown',
    build.builtAt ? `built ${formatDateTime(build.builtAt)}` : null,
    behind
      ? `${plural(check.behindBy, 'commit')} behind ${check.branch}`
      : check.status === 'current'
        ? `up to date with ${check.branch}`
        : null,
  ]
    .filter(Boolean)
    .join('\n');

  return (
    <Link
      to="/settings"
      className={`version-badge${behind ? ' has-update' : ''}`}
      title={title}
      aria-label={
        behind
          ? `Version ${build.version}, ${plural(check.behindBy, 'update')} available`
          : `Version ${build.version}`
      }
    >
      <span className="version-badge-text">{text}</span>
      {behind ? <span className="version-badge-dot" aria-hidden="true" /> : null}
    </Link>
  );
}

function plural(n: number, word: string): string {
  return `${n} ${word}${n === 1 ? '' : 's'}`;
}
