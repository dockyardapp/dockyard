// Dockyard — persistent (named) Cloudflare tunnel files (owner: agent 3).
//
// Produces the cloudflared config.yml (via the `yaml` package, never hand-concatenated) and
// writes data/tunnels/<slug>/credentials.json (mode 0600) + config.yml.

import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import YAML from 'yaml';
import { config } from '../config.ts';

export type NamedTunnelConfigInput = {
  tunnelId: string;
  credentialsFile: string;
  hostname: string;
  service: string;
};

/** Lowercase, replace non [a-z0-9] runs with '-', trim dashes; fall back to 'tunnel'. */
export function slugify(name: string): string {
  const slug = String(name ?? '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return slug || 'tunnel';
}

/** Build a cloudflared config.yml mapping `hostname` -> `service`, with a 404 catch-all. */
export function buildNamedTunnelConfig(input: NamedTunnelConfigInput): string {
  const doc = {
    tunnel: input.tunnelId,
    'credentials-file': input.credentialsFile,
    ingress: [
      { hostname: input.hostname, service: input.service },
      { service: 'http_status:404' },
    ],
  };
  return YAML.stringify(doc, { indent: 2, lineWidth: 0 });
}

/**
 * Write credentials.json (mode 0600) and config.yml under data/tunnels/<slug>/.
 * Returns the absolute paths of both files.
 */
export async function writeTunnelFiles(
  slug: string,
  credentials: unknown,
  configYaml: string,
): Promise<{ credentialsPath: string; configPath: string }> {
  const dir = path.join(config.tunnelDataDir, slug);
  await fsp.mkdir(dir, { recursive: true });

  const credentialsPath = path.join(dir, 'credentials.json');
  const configPath = path.join(dir, 'config.yml');

  await fsp.writeFile(credentialsPath, `${JSON.stringify(credentials, null, 2)}\n`, { mode: 0o600 });
  // chmod explicitly: the mode option is ignored when the file already existed.
  await fsp.chmod(credentialsPath, 0o600);
  await fsp.writeFile(configPath, configYaml, { mode: 0o644 });

  return { credentialsPath, configPath };
}

/** Absolute directory for a slug's tunnel files. */
export function tunnelDir(slug: string): string {
  return path.join(config.tunnelDataDir, slug);
}

/** Remove a slug's tunnel directory (used when a named tunnel is deleted). */
export async function removeTunnelFiles(slug: string): Promise<void> {
  await fsp.rm(tunnelDir(slug), { recursive: true, force: true });
}

/** Synchronous existence check used by callers that need a quick yes/no. */
export function tunnelFilesExist(slug: string): boolean {
  return fs.existsSync(tunnelDir(slug));
}
