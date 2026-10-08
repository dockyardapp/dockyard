// Dockyard — Docker error normalisation (owner: agent 1).

export class DockerError extends Error {
  statusCode: number;
  dockerStatus?: number;
  code: string;

  constructor(
    message: string,
    opts: { code: string; statusCode: number; dockerStatus?: number },
  ) {
    super(message);
    this.name = 'DockerError';
    this.code = opts.code;
    this.statusCode = opts.statusCode;
    this.dockerStatus = opts.dockerStatus;
  }
}

function pickMessage(err: any): string | undefined {
  const candidates = [
    err?.json?.message,
    err?.json?.error,
    err?.reason,
    err?.message,
  ];
  for (const c of candidates) {
    if (typeof c === 'string' && c.trim().length > 0) return c.trim();
  }
  return undefined;
}

function pickDockerStatus(err: any): number | undefined {
  const s = err?.statusCode ?? err?.status;
  return typeof s === 'number' ? s : undefined;
}

/**
 * Map a raw dockerode / Node error into a DockerError with an API-facing code and status.
 *   404 -> not_found/404, 409 -> conflict/409, 400 -> validation_error/400,
 *   ECONNREFUSED|ENOENT|EACCES -> docker_unavailable/503, otherwise docker_error/502.
 * The daemon's own message is preserved.
 */
export function normalizeDockerError(err: unknown): DockerError {
  if (err instanceof DockerError) return err;

  const e = err as any;
  const dockerStatus = pickDockerStatus(e);
  const sysCode: string | undefined = e?.code ?? e?.errno;
  const message = pickMessage(e);

  if (dockerStatus === 404) {
    return new DockerError(message ?? 'not found', { code: 'not_found', statusCode: 404, dockerStatus });
  }
  if (dockerStatus === 409) {
    return new DockerError(message ?? 'conflict', { code: 'conflict', statusCode: 409, dockerStatus });
  }
  if (dockerStatus === 400) {
    return new DockerError(message ?? 'bad request', { code: 'validation_error', statusCode: 400, dockerStatus });
  }

  if (sysCode === 'ECONNREFUSED' || sysCode === 'ENOENT' || sysCode === 'EACCES') {
    return new DockerError(message ?? 'docker engine unavailable', {
      code: 'docker_unavailable',
      statusCode: 503,
      dockerStatus,
    });
  }

  // Node socket errors that carry no explicit code.
  const rawMessage = String(e?.message ?? '');
  if (/ECONNREFUSED|ENOENT|EACCES|socket hang up|connect\b/i.test(rawMessage) && !dockerStatus) {
    return new DockerError(message ?? rawMessage, {
      code: 'docker_unavailable',
      statusCode: 503,
      dockerStatus,
    });
  }

  return new DockerError(message ?? 'docker error', { code: 'docker_error', statusCode: 502, dockerStatus });
}
