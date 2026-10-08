// Dockyard — image operations (owner: agent 1).

import { getDocker } from './index.ts';
import { normalizeDockerError } from './errors.ts';

export type ImageSummary = {
  id: string;
  repoTags: string[];
  repoDigests: string[];
  size: number;
  created: number;
  containers: number;
  dangling: boolean;
};

export async function listImages(): Promise<ImageSummary[]> {
  try {
    const raw = (await getDocker().listImages({ all: true })) as any[];
    return raw.map((img) => {
      const tags: string[] = Array.isArray(img?.RepoTags) ? img.RepoTags.map(String) : [];
      const realTags = tags.filter((t) => t !== '<none>:<none>');
      return {
        id: String(img?.Id ?? ''),
        repoTags: tags,
        repoDigests: Array.isArray(img?.RepoDigests) ? img.RepoDigests.map(String) : [],
        size: Number(img?.Size ?? 0),
        created: Number(img?.Created ?? 0),
        containers: Number(img?.Containers ?? 0),
        dangling: realTags.length === 0,
      };
    });
  } catch (err) {
    throw normalizeDockerError(err);
  }
}

export async function pullImage(
  ref: string,
  onProgress?: (ev: { status: string; id?: string; progress?: string }) => void,
): Promise<{ ref: string }> {
  try {
    const docker = getDocker();
    const stream = (await docker.pull(ref)) as NodeJS.ReadableStream;
    await new Promise<void>((resolve, reject) => {
      (docker as any).modem.followProgress(
        stream,
        (err: Error | null) => (err ? reject(err) : resolve()),
        (ev: any) => {
          if (onProgress && ev) {
            onProgress({
              status: String(ev.status ?? ''),
              id: ev.id != null ? String(ev.id) : undefined,
              progress: ev.progress != null ? String(ev.progress) : undefined,
            });
          }
        },
      );
    });
    return { ref };
  } catch (err) {
    throw normalizeDockerError(err);
  }
}

export async function removeImage(id: string, opts?: { force?: boolean }): Promise<void> {
  try {
    await getDocker().getImage(id).remove({ force: opts?.force ?? false } as any);
  } catch (err) {
    throw normalizeDockerError(err);
  }
}

function deletedNames(raw: unknown): string[] {
  if (!Array.isArray(raw)) return [];
  const out: string[] = [];
  for (const item of raw as any[]) {
    if (!item) continue;
    if (typeof item === 'string') out.push(item);
    else if (item.Deleted) out.push(String(item.Deleted));
    else if (item.Untagged) out.push(String(item.Untagged));
  }
  return out;
}

export async function pruneImages(): Promise<{ deleted: string[]; spaceReclaimed: number }> {
  try {
    const res = (await getDocker().pruneImages()) as any;
    return {
      deleted: deletedNames(res?.ImagesDeleted),
      spaceReclaimed: Number(res?.SpaceReclaimed ?? 0),
    };
  } catch (err) {
    throw normalizeDockerError(err);
  }
}

export async function inspectImage(id: string): Promise<Record<string, unknown>> {
  try {
    return (await getDocker().getImage(id).inspect()) as Record<string, unknown>;
  } catch (err) {
    throw normalizeDockerError(err);
  }
}
