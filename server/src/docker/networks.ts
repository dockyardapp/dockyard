// Dockyard — network operations (owner: agent 1).

import { getDocker } from './index.ts';
import { normalizeDockerError } from './errors.ts';

export type NetworkSummary = {
  id: string;
  name: string;
  driver: string;
  scope: string;
  internal: boolean;
  containers: Array<{ id: string; name: string }>;
  labels: Record<string, string>;
};

function mapNetwork(n: any): NetworkSummary {
  const labels: Record<string, string> = {};
  if (n?.Labels && typeof n.Labels === 'object') {
    for (const [k, val] of Object.entries(n.Labels as Record<string, unknown>)) labels[k] = String(val);
  }
  const containers: Array<{ id: string; name: string }> = [];
  if (n?.Containers && typeof n.Containers === 'object') {
    for (const [id, c] of Object.entries(n.Containers as Record<string, any>)) {
      containers.push({ id, name: String(c?.Name ?? '') });
    }
  }
  return {
    id: String(n?.Id ?? ''),
    name: String(n?.Name ?? ''),
    driver: String(n?.Driver ?? ''),
    scope: String(n?.Scope ?? ''),
    internal: Boolean(n?.Internal),
    containers,
    labels,
  };
}

export async function listNetworks(): Promise<NetworkSummary[]> {
  try {
    const raw = (await getDocker().listNetworks()) as any[];
    return raw.map(mapNetwork);
  } catch (err) {
    throw normalizeDockerError(err);
  }
}

export async function createNetwork(
  name: string,
  opts?: { driver?: string; labels?: Record<string, string> },
): Promise<NetworkSummary> {
  try {
    // dockerode resolves createNetwork() to a Network handle, not the raw payload.
    const res = (await getDocker().createNetwork({
      Name: name,
      Driver: opts?.driver ?? 'bridge',
      Labels: opts?.labels ?? {},
    } as any)) as any;
    const id = String(res?.id ?? res?.Id ?? '');
    if (res && typeof res.inspect === 'function') {
      try {
        return mapNetwork(await res.inspect());
      } catch {
        /* fall back to a constructed summary */
      }
    }
    return {
      id,
      name,
      driver: opts?.driver ?? 'bridge',
      scope: 'local',
      internal: false,
      containers: [],
      labels: opts?.labels ?? {},
    };
  } catch (err) {
    throw normalizeDockerError(err);
  }
}

export async function removeNetwork(id: string): Promise<void> {
  try {
    await getDocker().getNetwork(id).remove();
  } catch (err) {
    throw normalizeDockerError(err);
  }
}
