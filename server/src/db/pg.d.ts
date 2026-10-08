// Ambient types for `pg` (owner: agent 1).
//
// The project ships no @types/pg and must not add dependencies, so the foundation declares the
// minimal node-postgres surface the server uses. Runtime resolution is unaffected — this file is
// types only.

declare module 'pg' {
  export interface QueryResult<R = any> {
    rows: R[];
    rowCount: number | null;
    command: string;
    fields: Array<{ name: string; dataTypeID: number }>;
  }

  export interface PoolClient {
    query<R = any>(text: string, params?: unknown[]): Promise<QueryResult<R>>;
    release(err?: Error | boolean): void;
  }

  export class Pool {
    constructor(config?: {
      connectionString?: string;
      host?: string;
      port?: number;
      user?: string;
      password?: string;
      database?: string;
      max?: number;
      idleTimeoutMillis?: number;
      connectionTimeoutMillis?: number;
      ssl?: unknown;
    });
    query<R = any>(text: string, params?: unknown[]): Promise<QueryResult<R>>;
    connect(): Promise<PoolClient>;
    end(): Promise<void>;
    on(event: string, listener: (...args: any[]) => void): this;
    readonly totalCount: number;
    readonly idleCount: number;
    readonly waitingCount: number;
  }

  export class Client {
    constructor(config?: Record<string, unknown>);
    connect(): Promise<void>;
    query<R = any>(text: string, params?: unknown[]): Promise<QueryResult<R>>;
    end(): Promise<void>;
  }

  const pg: {
    Pool: typeof Pool;
    Client: typeof Client;
  };
  export default pg;
}
