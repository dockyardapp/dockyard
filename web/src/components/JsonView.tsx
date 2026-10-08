import type { ReactNode } from 'react';
import { CopyButton } from './ui';

/** Minimal JSON syntax highlighter. Keys, strings, numbers, booleans, null. */
function highlight(json: string): ReactNode[] {
  const out: ReactNode[] = [];
  const re = /("(?:\\.|[^"\\])*")(\s*:)?|\b(-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?)\b|\b(true|false)\b|\b(null)\b/g;
  let last = 0;
  let m: RegExpExecArray | null;
  let k = 0;
  while ((m = re.exec(json)) !== null) {
    if (m.index > last) out.push(json.slice(last, m.index));
    if (m[1] !== undefined) {
      const isKey = m[2] !== undefined;
      out.push(
        <span key={k++} className={isKey ? 'json-key' : 'json-str'}>
          {m[1]}
        </span>,
      );
      if (isKey) out.push(m[2]);
    } else if (m[3] !== undefined) {
      out.push(
        <span key={k++} className="json-num">
          {m[3]}
        </span>,
      );
    } else if (m[4] !== undefined) {
      out.push(
        <span key={k++} className="json-bool">
          {m[4]}
        </span>,
      );
    } else if (m[5] !== undefined) {
      out.push(
        <span key={k++} className="json-null">
          {m[5]}
        </span>,
      );
    }
    last = re.lastIndex;
  }
  if (last < json.length) out.push(json.slice(last));
  return out;
}

export function JsonView({ value }: { value: unknown }) {
  const text = JSON.stringify(value, null, 2) ?? 'null';
  return (
    <div>
      <div className="row" style={{ justifyContent: 'flex-end', marginBottom: 'var(--space-2)' }}>
        <CopyButton value={text} label="Copy JSON" />
      </div>
      <pre className="json-view">{highlight(text)}</pre>
    </div>
  );
}
