// Dockyard — which build is running (owner: agent 1).
//
// One module answers "what version is this?", because the answer has to agree between the API,
// the sidebar badge and the updater's status file. A build baked by the Dockerfile carries
// DOCKYARD_COMMIT / DOCKYARD_BUILD_TIME as environment variables; a working checkout has no such
// variables but does have git. Neither is available everywhere, so every field except `version`
// can be empty and callers must read empty as "unknown" rather than "current".

import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { repoRoot } from './config.ts';

export type BuildInfo = {
  version: string;
  commit: string;
  commitShort: string;
  builtAt: string | null;
  /**
   * False when the running commit is unknown (an image built without the build args, or a
   * tarball with no git). An update check cannot say "you are current" in that case, so the
   * caller has to offer the branch tip as a fact rather than a verdict.
   */
  pinned: boolean;
};

function readPackageVersion(): string {
  for (const rel of ['package.json', path.join('server', 'package.json')]) {
    try {
      const pkg = JSON.parse(fs.readFileSync(path.join(repoRoot, rel), 'utf8')) as { version?: string };
      if (pkg.version) return String(pkg.version);
    } catch {
      /* try the next candidate */
    }
  }
  return '0.0.0';
}

/**
 * Run a git command in the repo root.
 *
 * Returns null rather than throwing when git is absent (the runtime image does not install it)
 * or when repoRoot is not a checkout.
 */
function git(args: string[]): string | null {
  try {
    const out = execFileSync('git', args, {
      cwd: repoRoot,
      encoding: 'utf8',
      timeout: 4000,
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
    return out || null;
  } catch {
    return null;
  }
}

function resolve(): BuildInfo {
  const version = readPackageVersion();
  const bakedCommit = (process.env.DOCKYARD_COMMIT ?? '').trim();
  const commit = bakedCommit || git(['rev-parse', 'HEAD']) || '';
  const bakedAt = (process.env.DOCKYARD_BUILD_TIME ?? '').trim();
  const builtAt = bakedAt || git(['show', '-s', '--format=%cI', 'HEAD']) || null;

  return {
    version,
    commit,
    commitShort: commit.slice(0, 7),
    builtAt,
    pinned: commit.length > 0,
  };
}

export const buildInfo: BuildInfo = resolve();
