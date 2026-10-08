/**
 * Hand-rolled inline SVG charts. No chart library (CONTRACT.md §0.7).
 * Values are drawn in a fixed viewBox and stretched with preserveAspectRatio
 * "none"; `vector-effect: non-scaling-stroke` keeps the line crisp.
 */

const VIEW_W = 600;
const VIEW_H = 56;
const PAD = 3;

export function Sparkline({
  values,
  max,
  className = 'spark-cpu',
  fill = false,
}: {
  values: number[];
  max: number;
  className?: string;
  fill?: boolean;
}) {
  const safeMax = max > 0 ? max : 1;
  const n = values.length;
  const pts = values.map((v, i) => {
    const x = n <= 1 ? 0 : (i / (n - 1)) * VIEW_W;
    const clamped = Math.max(0, Math.min(v, safeMax));
    const y = VIEW_H - PAD - (clamped / safeMax) * (VIEW_H - PAD * 2);
    return `${x.toFixed(2)} ${y.toFixed(2)}`;
  });
  const line = pts.length ? `M ${pts.join(' L ')}` : '';
  const area = line ? `${line} L ${VIEW_W} ${VIEW_H} L 0 ${VIEW_H} Z` : '';

  return (
    <svg
      className="spark"
      viewBox={`0 0 ${VIEW_W} ${VIEW_H}`}
      preserveAspectRatio="none"
      role="img"
      aria-hidden="true"
    >
      <line className="spark-grid" x1="0" y1={VIEW_H - PAD} x2={VIEW_W} y2={VIEW_H - PAD} />
      <line className="spark-grid" x1="0" y1={PAD} x2={VIEW_W} y2={PAD} />
      {fill && area ? <path className="spark-area" d={area} /> : null}
      {line ? <path className={`spark-line ${className}`} d={line} vectorEffect="non-scaling-stroke" /> : null}
    </svg>
  );
}

/** CPU and memory history over a shared 0-100% axis. */
export function StatsChart({
  cpu,
  mem,
}: {
  cpu: number[];
  mem: number[];
}) {
  return (
    <div className="stack" style={{ gap: 'var(--space-2)' }}>
      <div>
        <div className="row" style={{ justifyContent: 'space-between' }}>
          <span className="stat-label">CPU %</span>
          <span className="stat-label" style={{ color: 'var(--accent-hover)' }}>cpu</span>
        </div>
        <Sparkline values={cpu} max={100} className="spark-cpu" fill />
      </div>
      <div>
        <div className="row" style={{ justifyContent: 'space-between' }}>
          <span className="stat-label">Memory %</span>
          <span className="stat-label" style={{ color: 'var(--state-running-fg)' }}>mem</span>
        </div>
        <Sparkline values={mem} max={100} className="spark-mem" fill />
      </div>
    </div>
  );
}
