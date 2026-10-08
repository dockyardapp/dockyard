// Dockyard — volume operations (owner: agent 1).

import { getDocker } from './index.ts';
import { normalizeDockerError } from './errors.ts';

export type VolumeSummary = {
  name: string;
  driver: string;
  mountpoint: string;
  created: string;
  labels: Record<string, string>;
  inUseBy: string[];
};

function mapVolume(v: any, inUseBy: string[]): VolumeSummary {
  const labels: Record<string, string> = {};
  if (v?.Labels && typeof v.Labels === 'object') {
    for (const [k, val] of Object.entries(v.Labels as Record<string, unknown>)) labels[k] = String(val);
  }
  return {
    name: String(v?.Name ?? ''),
    driver: String(v?.Driver ?? ''),
    mountpoint: String(v?.Mountpoint ?? ''),
    created: String(v?.CreatedAt ?? v?.Created ?? ''),
    labels,
    inUseBy,
  };
}

async function usageIndex(): Promise<Map<string, string[]>> {
  const index = new Map<string, string[]>();
  try {
    const containers = (await getDocker().listContainers({ all: true })) as any[];
    for (const c of containers) {
      const mounts = Array.isArray(c?.Mounts) ? c.Mounts : [];
      for (const m of mounts) {
        if (m?.Type === 'volume' && m?.Name) {
          const key = String(m.Name);
          const list = index.get(key) ?? [];
          list.push(String(c.Id));
          index.set(key, list);
        }
      }
    }
  } catch {
    /* usage is best-effort */
  }
  return index;
}

export async function listVolumes(): Promise<VolumeSummary[]> {
  try {
    const res = (await getDocker().listVolumes()) as any;
    const volumes: any[] = Array.isArray(res?.Volumes) ? res.Volumes : [];
    const usage = await usageIndex();
    return volumes.map((v) => mapVolume(v, usage.get(String(v?.Name ?? '')) ?? []));
  } catch (err) {
    throw normalizeDockerError(err);
  }
}

export async function createVolume(
  name: string,
  labels?: Record<string, string>,
): Promise<VolumeSummary> {
  try {
    // dockerode resolves createVolume() to a Volume handle, not the raw payload.
    const res = (await getDocker().createVolume({ Name: name, Labels: labels ?? {} } as any)) as any;
    const info = res && typeof res.inspect === 'function' ? await res.inspect() : res;
    return mapVolume(info, []);
  } catch (err) {
    throw normalizeDockerError(err);
  }
}

export async function removeVolume(name: string, opts?: { force?: boolean }): Promise<void> {
  try {
    await getDocker().getVolume(name).remove({ force: opts?.force ?? false } as any);
  } catch (err) {
    throw normalizeDockerError(err);
  }
}

export async function pruneVolumes(): Promise<{ deleted: string[]; spaceReclaimed: number }> {
  try {
    const res = (await getDocker().pruneVolumes()) as any;
    return {
      deleted: Array.isArray(res?.VolumesDeleted) ? res.VolumesDeleted.map(String) : [],
      spaceReclaimed: Number(res?.SpaceReclaimed ?? 0),
    };
  } catch (err) {
    throw normalizeDockerError(err);
  }
}
