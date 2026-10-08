// Dockyard — the "How it works" tab on the Tunnels page.
//
// Explains what a tunnel does, compares the three exposure modes and says which one to
// reach for. The comparison lives in one array so the table, the guidance below it and
// the tests all read from the same source instead of drifting apart.

import { Card, Pill } from './ui';
import type { TunnelMode } from '../api/types';

/** The exposure modes, in the order the create dialog lists them. */
export const GUIDE_MODES = ['quick', 'named', 'localtunnel'] as const satisfies readonly TunnelMode[];

/**
 * One row of the comparison table.
 *
 * `values` is keyed by `TunnelMode` rather than by the modes the guide happens to render,
 * which is the drift guard: adding an exposure mode to the API makes every row here fail to
 * compile until the guide answers for it. A guide that silently omits a mode is worse than
 * no guide. Keyed rather than positional, so a row cannot line up with the wrong column.
 */
export type ComparisonRow = {
  label: string;
  values: Record<TunnelMode, string>;
};

export const COMPARISON: ComparisonRow[] = [
  {
    label: 'Account needed',
    values: { quick: 'none', named: 'Cloudflare', localtunnel: 'none' },
  },
  {
    label: 'Public URL',
    values: {
      quick: 'random, on trycloudflare.com',
      named: 'your own hostname on your zone',
      localtunnel: 'random, on loca.lt',
    },
  },
  {
    label: 'Same URL after a restart',
    values: {
      quick: 'no',
      named: 'yes',
      localtunnel: 'not guaranteed. The tunnel name is requested as the subdomain.',
    },
  },
  {
    label: 'Credentials on disk',
    values: {
      quick: 'none',
      named: 'an API token and the tunnel credentials',
      localtunnel: 'none',
    },
  },
  {
    label: 'A browser visitor',
    values: {
      quick: 'reaches the target',
      named: 'reaches the target',
      localtunnel: 'is shown a reminder page first and has to enter this host\u2019s public IP',
    },
  },
  {
    label: 'Runs as',
    values: {
      quick: 'a cloudflared child process',
      named: 'a cloudflared child process',
      localtunnel: 'a library inside the panel, so it has no pid',
    },
  },
];

/** When to reach for which mode. */
export const WHEN_TO_USE: Array<{ situation: string; choice: string }> = [
  {
    situation: 'You are sending the link to a person',
    choice: 'quick or named. LocalTunnel shows the visitor a reminder page before the target loads.',
  },
  {
    situation: 'You need one address that does not change, or your own domain',
    choice: 'named. It keeps a stable hostname and its own DNS record.',
  },
  {
    situation: 'Machine to machine, with nothing to sign up for',
    choice: 'localtunnel. No account, no DNS, and the least to configure.',
  },
  {
    situation: 'Something that should stay up',
    choice: 'named, with auto-start on, so it comes back with the panel on the same URL.',
  },
];

const STATUSES: Array<{ state: string; meaning: string }> = [
  { state: 'stopped', meaning: 'Not running. Nothing answers on the URL.' },
  { state: 'starting', meaning: 'The provider has been asked for a URL and has not answered yet.' },
  { state: 'running', meaning: 'The URL is live and forwards to the target.' },
  { state: 'error', meaning: 'The provider exited. The last error under the status says why.' },
];

const NOTES: Array<{ point: string; detail: string }> = [
  {
    point: 'Public by default',
    detail:
      'Whoever has the URL reaches the target. The tunnel adds no authentication of its own, so protect the target if it needs protecting.',
  },
  {
    point: 'Addresses move',
    detail:
      'A quick or localtunnel address changes when the tunnel restarts. Auto-start brings the tunnel back, not the old address.',
  },
  {
    point: 'LocalTunnel shows your IP',
    detail:
      'Its reminder page shows the visitor this host\u2019s public IP, and it returns every 7 days per visitor IP. That is why a loca.lt link is a poor fit for a person.',
  },
  {
    point: 'Third parties',
    detail:
      'Quick and LocalTunnel depend on a third party being reachable. Named depends on Cloudflare and on your zone.',
  },
  {
    point: 'Panel lifetime',
    detail: 'Stopping the panel stops the tunnels it runs.',
  },
  {
    point: 'Visibility',
    detail:
      'A tunnel is visible to whoever can see the container it exposes, so scoping a user\u2019s containers scopes their tunnels too.',
  },
];

export function TunnelModesGuide() {
  return (
    <div className="stack">
      <Card title="How a tunnel works">
        <p style={{ margin: 0, color: 'var(--text-secondary)', fontSize: 'var(--fs-xs)' }}>
          The panel dials out to a provider, which hands back a public URL and forwards what it
          receives on that URL down the connection already open to your target. Nothing inbound is
          opened on this host and no port is published, which is why a tunnel reaches a target
          behind NAT or a firewall.
        </p>
        <dl className="kv" style={{ marginTop: 'var(--space-3)' }}>
          <dt>Direction</dt>
          <dd>Outbound from the panel. No inbound port is opened.</dd>
          <dt>Target</dt>
          <dd>
            One container port, or a raw URL the panel can reach. Requests arrive at the
            provider&rsquo;s URL and leave at the target.
          </dd>
          <dt>Mode</dt>
          <dd>Chosen per tunnel, so two tunnels on the same host can use different providers.</dd>
        </dl>
      </Card>

      <Card title="The three modes" flush>
        <div className="table-wrap">
          <table className="data">
            <thead>
              <tr>
                <th>Attribute</th>
                {GUIDE_MODES.map((mode) => (
                  <th key={mode}>{mode}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {COMPARISON.map((row) => (
                <tr key={row.label}>
                  <td className="primary">{row.label}</td>
                  {GUIDE_MODES.map((mode) => (
                    <td key={mode}>{row.values[mode]}</td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Card>

      <Card title="Which one to use">
        <dl className="kv">
          {WHEN_TO_USE.map((row) => (
            <div key={row.situation} style={{ display: 'contents' }}>
              <dt>{row.situation}</dt>
              <dd>{row.choice}</dd>
            </div>
          ))}
        </dl>
      </Card>

      <Card title="What the status means">
        <dl className="kv">
          {STATUSES.map((row) => (
            <div key={row.state} style={{ display: 'contents' }}>
              <dt>
                <Pill state={row.state} />
              </dt>
              <dd>{row.meaning}</dd>
            </div>
          ))}
        </dl>
      </Card>

      <Card title="Things to know">
        <dl className="kv">
          {NOTES.map((row) => (
            <div key={row.point} style={{ display: 'contents' }}>
              <dt>{row.point}</dt>
              <dd>{row.detail}</dd>
            </div>
          ))}
        </dl>
      </Card>
    </div>
  );
}
