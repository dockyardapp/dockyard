// Minimal type surface for the localtunnel client.
//
// The package ships no types of its own. Only what this app uses is declared, so a
// version bump that changes something we do not touch cannot break the build, and
// nothing here pretends to describe the whole API.
//
// The module is CommonJS: at runtime `import localtunnel from 'localtunnel'` and
// `(await import('localtunnel')).default` both resolve to the same function.

declare module 'localtunnel' {
  export type Tunnel = {
    /** The public URL localtunnel.me assigned, e.g. https://calm-dogs-run.loca.lt */
    url: string;
    on(event: 'close', cb: () => void): void;
    on(event: 'error', cb: (err: Error) => void): void;
    on(event: 'request', cb: (info: { method: string; path: string }) => void): void;
    close(): void;
  };

  export type OpenOptions = {
    /** Local port to expose. */
    port: number;
    /** Local host to expose. Defaults to localhost upstream. */
    local_host?: string;
    /** Requested subdomain. localtunnel.me may ignore or refuse it. */
    subdomain?: string;
    /** localtunnel.me itself; overridable for a self-hosted server. */
    host?: string;
  };

  export default function localtunnel(options: OpenOptions): Promise<Tunnel>;
}
