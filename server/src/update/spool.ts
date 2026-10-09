// Dockyard — the file handshake between the panel and the host updater (owner: agent 1).
//
// The panel runs in a container and cannot replace itself, so it does not try. It writes
// `request.json` into a spool directory that is bind-mounted from the host, a systemd path unit
// on the host runs `deploy/update.sh`, and that script publishes `status.json` back. The
// installer writes `updater.json` so the panel can tell an operator the button is wired up
// instead of accepting a request nothing will ever pick up.
//
// Nothing here trusts the request file: `deploy/update.sh` re-validates the branch and never
// reads a path out of it.

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { config } from '../config.ts';

export type UpdateRequest = {
  id: string;
  requestedAt: string;
  requestedBy: string;
  branch: string;
  from: { version: string; commit: string };
};

export type UpdateJobState = 'queued' | 'running' | 'success' | 'failed' | 'rolled-back' | 'stale';

export type UpdateJob = {
  id: string;
  state: UpdateJobState;
  step: string | null;
  message: string | null;
  requestedAt: string | null;
  requestedBy: string | null;
  startedAt: string | null;
  finishedAt: string | null;
  from: { version: string | null; commit: string | null };
  to: { version: string | null; commit: string | null };
  log: string | null;
};

export type UpdaterInfo = {
  /** False means the host has no updater installed, so the button cannot work. */
  installed: boolean;
  installedAt: string | null;
  spoolDir: string;
  enabled: boolean;
};

/**
 * A run that reported itself running and then went quiet. The updater rebuilds the panel, which
 * kills the very process that would have noticed, so a wedged run has to expire rather than spin
 * the UI forever.
 */
const RUNNING_TIMEOUT_MS = 30 * 60 * 1000;

function readJson<T>(file: string): T | null {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8')) as T;
  } catch {
    return null;
  }
}

function writeJsonAtomic(file: string, value: unknown): void {
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o644 });
  fs.renameSync(tmp, file);
}

function spoolFile(name: string): string {
  return path.join(config.updateSpoolDir, name);
}

export function updaterInfo(): UpdaterInfo {
  const marker = readJson<{ installedAt?: string }>(spoolFile('updater.json'));
  return {
    installed: marker !== null,
    installedAt: marker?.installedAt ?? null,
    spoolDir: config.updateSpoolDir,
    enabled: config.updateEnabled,
  };
}

function normaliseState(raw: unknown): UpdateJobState {
  const value = String(raw ?? '');
  const known: UpdateJobState[] = ['queued', 'running', 'success', 'failed', 'rolled-back', 'stale'];
  // An unrecognised state means the panel and deploy/update.sh are not the same version. Reporting
  // that as 'queued' would claim work is pending when nothing is running.
  return (known as string[]).includes(value) ? (value as UpdateJobState) : 'stale';
}

function queuedJob(request: UpdateRequest): UpdateJob {
  return {
    id: request.id,
    state: 'queued',
    step: null,
    message: null,
    requestedAt: request.requestedAt,
    requestedBy: request.requestedBy,
    startedAt: null,
    finishedAt: null,
    from: { version: request.from.version, commit: request.from.commit },
    to: { version: null, commit: null },
    log: null,
  };
}

/**
 * The current job: the updater's status file when there is one, else the pending request.
 *
 * The request file outlives the run that consumed it, so a terminal status from the last update
 * would mask a request the operator just made and the button would look inert. Whichever file
 * carries the later timestamp wins.
 */
export function readJob(): UpdateJob | null {
  const status = readJson<Partial<UpdateJob> & { state?: string }>(spoolFile('status.json'));
  const request = readJson<UpdateRequest>(spoolFile('request.json'));

  if (!status && !request) return null;
  if (!status) return queuedJob(request as UpdateRequest);

  const statusAt = Date.parse(
    String(status.finishedAt ?? status.startedAt ?? status.requestedAt ?? ''),
  );
  const requestAt = request ? Date.parse(request.requestedAt) : Number.NaN;
  if (request && Number.isFinite(requestAt) && (!Number.isFinite(statusAt) || requestAt > statusAt)) {
    return queuedJob(request);
  }

  const job: UpdateJob = {
    id: String(status.id ?? request?.id ?? ''),
    state: normaliseState(status.state),
    step: status.step ?? null,
    message: status.message ?? null,
    requestedAt: status.requestedAt ?? request?.requestedAt ?? null,
    requestedBy: status.requestedBy ?? request?.requestedBy ?? null,
    startedAt: status.startedAt ?? null,
    finishedAt: status.finishedAt ?? null,
    from: status.from ?? { version: null, commit: null },
    to: status.to ?? { version: null, commit: null },
    log: status.log ?? null,
  };

  if (job.state === 'stale' && !job.message) {
    job.message =
      'The updater reported a state this panel does not recognise, so the two are probably ' +
      'different versions. Update the checkout on the host.';
  }

  if (job.state === 'running' && job.startedAt) {
    const started = Date.parse(job.startedAt);
    if (Number.isFinite(started) && Date.now() - started > RUNNING_TIMEOUT_MS) {
      return {
        ...job,
        state: 'stale',
        message:
          job.message ??
          'The updater stopped reporting. Check it on the host: systemctl status dockyard-updater',
      };
    }
  }

  return job;
}

export function writeRequest(input: {
  branch: string;
  by: string;
  version: string;
  commit: string;
}): UpdateRequest {
  fs.mkdirSync(config.updateSpoolDir, { recursive: true });
  const request: UpdateRequest = {
    id: crypto.randomUUID(),
    requestedAt: new Date().toISOString(),
    requestedBy: input.by,
    branch: input.branch,
    from: { version: input.version, commit: input.commit },
  };
  writeJsonAtomic(spoolFile('request.json'), request);
  return request;
}
