// Dockyard — container stats math (owner: agent 1).
//
// Pure transformation of one Docker `stats` frame into the ContainerStats shape. Re-exported
// from docker/index.ts. The raw stream plumbing lives in containers.ts.

export type ContainerStats = {
  cpuPercent: number;
  memUsed: number;
  memLimit: number;
  memPercent: number;
  netRx: number;
  netTx: number;
  blkRead: number;
  blkWrite: number;
  pids: number;
  readAt: string;
};

type AnyFrame = Record<string, any>;

function num(v: unknown): number {
  const n = typeof v === 'number' ? v : Number(v);
  return Number.isFinite(n) ? n : 0;
}

/** CPU% = (cpuDelta / systemDelta) * onlineCPUs * 100, guarding systemDelta <= 0 and cpuDelta < 0. */
export function computeCpuPercent(frame: AnyFrame): number {
  const cpu = frame?.cpu_stats ?? {};
  const precpu = frame?.precpu_stats ?? {};
  const cpuDelta = num(cpu?.cpu_usage?.total_usage) - num(precpu?.cpu_usage?.total_usage);
  const systemDelta = num(cpu?.system_cpu_usage) - num(precpu?.system_cpu_usage);
  const onlineCpus =
    num(cpu?.online_cpus) ||
    (Array.isArray(cpu?.cpu_usage?.percpu_usage) ? cpu.cpu_usage.percpu_usage.length : 0) ||
    1;

  if (systemDelta <= 0 || cpuDelta < 0) return 0;
  const pct = (cpuDelta / systemDelta) * onlineCpus * 100;
  return Number.isFinite(pct) && pct > 0 ? pct : 0;
}

export function computeMemory(frame: AnyFrame): { used: number; limit: number; percent: number } {
  const mem = frame?.memory_stats ?? {};
  const usage = num(mem.usage);
  const cache = num(mem?.stats?.cache);
  const limit = num(mem.limit);
  const used = Math.max(0, usage - cache);
  const percent = limit > 0 ? (used / limit) * 100 : 0;
  return { used, limit, percent };
}

export function computeNetwork(frame: AnyFrame): { rx: number; tx: number } {
  let rx = 0;
  let tx = 0;
  const nets = frame?.networks;
  if (nets && typeof nets === 'object') {
    for (const iface of Object.values(nets) as AnyFrame[]) {
      rx += num(iface?.rx_bytes);
      tx += num(iface?.tx_bytes);
    }
  }
  return { rx, tx };
}

export function computeBlkio(frame: AnyFrame): { read: number; write: number } {
  let read = 0;
  let write = 0;
  const entries = frame?.blkio_stats?.io_service_bytes_recursive;
  if (Array.isArray(entries)) {
    for (const e of entries as AnyFrame[]) {
      const op = String(e?.op ?? '').toLowerCase();
      if (op === 'read') read += num(e?.value);
      else if (op === 'write') write += num(e?.value);
    }
  }
  return { read, write };
}

export function computeContainerStats(frame: AnyFrame): ContainerStats {
  const mem = computeMemory(frame);
  const net = computeNetwork(frame);
  const blk = computeBlkio(frame);
  return {
    cpuPercent: computeCpuPercent(frame),
    memUsed: mem.used,
    memLimit: mem.limit,
    memPercent: mem.percent,
    netRx: net.rx,
    netTx: net.tx,
    blkRead: blk.read,
    blkWrite: blk.write,
    pids: num(frame?.pids_stats?.current),
    readAt: new Date().toISOString(),
  };
}
