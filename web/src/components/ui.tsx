import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useId,
  useRef,
  useState,
} from 'react';
import type { ButtonHTMLAttributes, ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { Icon, type IconName } from './Icons';

/* ------------------------------------------------------------------ Button */

type ButtonProps = ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: 'default' | 'primary' | 'danger' | 'subtle';
  size?: 'sm' | 'md' | 'lg';
  icon?: IconName;
  busy?: boolean;
  block?: boolean;
};

export function Button({
  variant = 'default',
  size = 'md',
  icon,
  busy = false,
  block = false,
  children,
  className,
  disabled,
  ...rest
}: ButtonProps) {
  const classes = ['btn'];
  if (variant !== 'default') classes.push(`btn-${variant}`);
  if (size !== 'md') classes.push(`btn-${size}`);
  if (block) classes.push('btn-block');
  if (className) classes.push(className);
  return (
    <button
      type="button"
      className={classes.join(' ')}
      aria-busy={busy || undefined}
      disabled={disabled || busy}
      {...rest}
    >
      {icon ? <Icon name={icon} className="btn-icon" /> : null}
      {children}
    </button>
  );
}

/** A button that owns the busy state for an async action. */
export function AsyncButton({
  onRun,
  onError,
  children,
  ...rest
}: Omit<ButtonProps, 'onClick' | 'busy'> & {
  onRun: () => Promise<unknown>;
  onError?: (err: unknown) => void;
}) {
  const [busy, setBusy] = useState(false);
  return (
    <Button
      {...rest}
      busy={busy}
      onClick={async () => {
        setBusy(true);
        try {
          await onRun();
        } catch (err) {
          onError?.(err);
        } finally {
          setBusy(false);
        }
      }}
    >
      {children}
    </Button>
  );
}

/* -------------------------------------------------------------------- Pill */

export function Pill({
  state,
  children,
  tone,
}: {
  state?: string;
  children?: ReactNode;
  tone?: string;
}) {
  const key = (tone ?? state ?? 'neutral').toLowerCase();
  const known = new Set([
    'running',
    'exited',
    'created',
    'paused',
    'restarting',
    'dead',
    'removing',
    'stopped',
    'starting',
    'error',
    'partial',
    'active',
    'info',
  ]);
  const cls = known.has(key) ? `pill-${key}` : 'pill-neutral';
  return (
    <span className={`pill ${cls}`}>
      <span className="dot" />
      {children ?? state}
    </span>
  );
}

/* ------------------------------------------------------------------ Banner */

export function Banner({
  tone = 'info',
  title,
  children,
  onDismiss,
}: {
  tone?: 'error' | 'warn' | 'info';
  title?: string;
  children?: ReactNode;
  onDismiss?: () => void;
}) {
  const icon: IconName = tone === 'error' ? 'warning' : tone === 'warn' ? 'warning' : 'info';
  return (
    <div className={`banner banner-${tone}`} role={tone === 'error' ? 'alert' : 'status'}>
      <Icon name={icon} className="banner-icon" />
      <div className="banner-body">
        {title ? <div className="banner-title">{title}</div> : null}
        {children}
      </div>
      {onDismiss ? (
        <Button variant="subtle" size="sm" icon="close" aria-label="Dismiss" onClick={onDismiss} />
      ) : null}
    </div>
  );
}

/* -------------------------------------------------------------- EmptyState */

export function EmptyState({
  icon = 'info',
  title,
  children,
  action,
}: {
  icon?: IconName;
  title: string;
  children?: ReactNode;
  action?: ReactNode;
}) {
  return (
    <div className="empty">
      <Icon name={icon} className="empty-icon" size={28} />
      <h2 className="empty-title">{title}</h2>
      {children ? <div className="empty-desc">{children}</div> : null}
      {action ? <div className="btn-row">{action}</div> : null}
    </div>
  );
}

/* ---------------------------------------------------------------- Skeletons */

export function Skeleton({ width, height }: { width?: string | number; height?: string | number }) {
  return <span className="skeleton" style={{ display: 'block', width, height }} />;
}

export function SkeletonRows({ rows = 5, cols = 4 }: { rows?: number; cols?: number }) {
  return (
    <div aria-hidden="true">
      {Array.from({ length: rows }).map((_, r) => (
        <div className="skeleton-row" key={r}>
          {Array.from({ length: cols }).map((__, c) => (
            <Skeleton key={c} height={12} />
          ))}
        </div>
      ))}
    </div>
  );
}

export function Spinner({ label }: { label?: string }) {
  return (
    <span className="row" role="status" aria-live="polite">
      <span className="spinner" />
      {label ? <span className="muted">{label}</span> : null}
    </span>
  );
}

/* ------------------------------------------------------------------- Cards */

export function Card({
  title,
  actions,
  children,
  flush,
  className,
}: {
  title?: ReactNode;
  actions?: ReactNode;
  children: ReactNode;
  flush?: boolean;
  className?: string;
}) {
  return (
    <section className={['card', className].filter(Boolean).join(' ')}>
      {title || actions ? (
        <header className="card-head">
          {typeof title === 'string' ? <h2>{title}</h2> : title}
          {actions ? <div className="card-actions">{actions}</div> : null}
        </header>
      ) : null}
      <div className={flush ? 'card-body flush' : 'card-body'}>{children}</div>
    </section>
  );
}

export function StatTile({
  label,
  value,
  meta,
  children,
}: {
  label: string;
  value: ReactNode;
  meta?: ReactNode;
  children?: ReactNode;
}) {
  return (
    <div className="stat">
      <span className="stat-label">{label}</span>
      <span className="stat-value">{value}</span>
      {meta ? <span className="stat-meta">{meta}</span> : null}
      {children}
    </div>
  );
}

export function PageHead({
  title,
  desc,
  actions,
}: {
  title: ReactNode;
  desc?: ReactNode;
  actions?: ReactNode;
}) {
  return (
    <div className="page-head">
      <div className="page-head-main">
        <h1>{title}</h1>
        {desc ? <div className="page-desc">{desc}</div> : null}
      </div>
      {actions ? <div className="page-actions">{actions}</div> : null}
    </div>
  );
}

/* ------------------------------------------------------------------ Fields */

export function Field({
  label,
  hint,
  error,
  required,
  children,
  htmlFor,
}: {
  label?: ReactNode;
  hint?: ReactNode;
  error?: ReactNode;
  required?: boolean;
  children: ReactNode;
  htmlFor?: string;
}) {
  return (
    <div className="field">
      {label ? (
        <label className="field-label" htmlFor={htmlFor}>
          {label}
          {required ? <span className="field-req" aria-hidden="true">required</span> : null}
        </label>
      ) : null}
      {children}
      {hint && !error ? <span className="field-hint">{hint}</span> : null}
      {error ? <span className="field-error">{error}</span> : null}
    </div>
  );
}

export function TextField({
  label,
  hint,
  error,
  required,
  ...rest
}: React.InputHTMLAttributes<HTMLInputElement> & {
  label?: ReactNode;
  hint?: ReactNode;
  error?: ReactNode;
  required?: boolean;
}) {
  const id = useId();
  return (
    <Field label={label} hint={hint} error={error} required={required} htmlFor={id}>
      <input
        id={id}
        aria-invalid={error ? true : undefined}
        aria-required={required || undefined}
        {...rest}
      />
    </Field>
  );
}

export function SelectField({
  label,
  hint,
  error,
  required,
  children,
  ...rest
}: React.SelectHTMLAttributes<HTMLSelectElement> & {
  label?: ReactNode;
  hint?: ReactNode;
  error?: ReactNode;
  required?: boolean;
}) {
  const id = useId();
  return (
    <Field label={label} hint={hint} error={error} required={required} htmlFor={id}>
      <select id={id} aria-invalid={error ? true : undefined} aria-required={required || undefined} {...rest}>
        {children}
      </select>
    </Field>
  );
}

/* -------------------------------------------------------------- CopyButton */

export function CopyButton({ value, label = 'Copy' }: { value: string; label?: string }) {
  const [done, setDone] = useState(false);
  return (
    <Button
      size="sm"
      icon={done ? 'check' : 'copy'}
      aria-label={label}
      title={label}
      onClick={async () => {
        try {
          await navigator.clipboard.writeText(value);
          setDone(true);
          window.setTimeout(() => setDone(false), 1400);
        } catch {
          setDone(false);
        }
      }}
    >
      {done ? 'Copied' : ''}
    </Button>
  );
}

export function CopyField({ value }: { value: string }) {
  return (
    <div className="copy-field">
      <code title={value}>{value}</code>
      <CopyButton value={value} />
    </div>
  );
}

/* -------------------------------------------------------------------- Tabs */

export function Tabs<T extends string>({
  tabs,
  value,
  onChange,
}: {
  tabs: Array<{ id: T; label: string }>;
  value: T;
  onChange: (id: T) => void;
}) {
  return (
    <div className="tabs" role="tablist">
      {tabs.map((t) => (
        <button
          key={t.id}
          role="tab"
          className="tab"
          aria-selected={value === t.id}
          onClick={() => onChange(t.id)}
        >
          {t.label}
        </button>
      ))}
    </div>
  );
}

/* ------------------------------------------------------------ Modal/Drawer */

function useEscape(active: boolean, onEscape: () => void) {
  useEffect(() => {
    if (!active) return;
    const handler = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onEscape();
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [active, onEscape]);
}

type DialogProps = {
  open: boolean;
  onClose: () => void;
  title: ReactNode;
  children: ReactNode;
  footer?: ReactNode;
  width?: number;
  variant?: 'modal' | 'drawer';
};

export function Dialog({ open, onClose, title, children, footer, width, variant = 'modal' }: DialogProps) {
  const ref = useRef<HTMLDivElement>(null);
  useEscape(open, onClose);

  useEffect(() => {
    if (!open) return;
    const el = ref.current?.querySelector<HTMLElement>(
      'input, select, textarea, button, [tabindex]:not([tabindex="-1"])',
    );
    el?.focus();
  }, [open]);

  if (!open) return null;
  const isDrawer = variant === 'drawer';
  return createPortal(
    <div
      className={`overlay ${isDrawer ? 'right' : 'center'}`}
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div
        ref={ref}
        className={isDrawer ? 'drawer' : 'modal'}
        style={!isDrawer && width ? { maxWidth: width } : undefined}
        role="dialog"
        aria-modal="true"
        aria-label={typeof title === 'string' ? title : undefined}
      >
        <header className="dialog-head">
          <h2>{title}</h2>
          <Button className="dialog-close" variant="subtle" size="sm" icon="close" aria-label="Close" onClick={onClose} />
        </header>
        <div className="dialog-body">{children}</div>
        {footer ? <footer className="dialog-foot">{footer}</footer> : null}
      </div>
    </div>,
    document.body,
  );
}

/* ---------------------------------------------------------------- Confirm */

type ConfirmOptions = {
  title: string;
  body?: ReactNode;
  confirmLabel?: string;
  cancelLabel?: string;
  danger?: boolean;
  /** If set, the user must type this exact string to enable the confirm button. */
  phrase?: string;
};

type ConfirmFn = (opts: ConfirmOptions) => Promise<boolean>;

const ConfirmContext = createContext<ConfirmFn | null>(null);

export function ConfirmProvider({ children }: { children: ReactNode }) {
  const [state, setState] = useState<ConfirmOptions | null>(null);
  const [typed, setTyped] = useState('');
  const resolver = useRef<((ok: boolean) => void) | null>(null);

  const confirm = useCallback<ConfirmFn>((opts) => {
    setTyped('');
    setState(opts);
    return new Promise<boolean>((resolve) => {
      resolver.current = resolve;
    });
  }, []);

  const settle = useCallback((ok: boolean) => {
    resolver.current?.(ok);
    resolver.current = null;
    setState(null);
  }, []);

  const phraseOk = !state?.phrase || typed.trim() === state.phrase;

  return (
    <ConfirmContext.Provider value={confirm}>
      {children}
      <Dialog
        open={state !== null}
        onClose={() => settle(false)}
        title={state?.title ?? ''}
        width={420}
        footer={
          <>
            <Button onClick={() => settle(false)}>{state?.cancelLabel ?? 'Cancel'}</Button>
            <Button
              variant={state?.danger ? 'danger' : 'primary'}
              disabled={!phraseOk}
              onClick={() => settle(true)}
            >
              {state?.confirmLabel ?? 'Confirm'}
            </Button>
          </>
        }
      >
        {state?.body ? <div className="muted" style={{ fontSize: 'var(--fs-sm)' }}>{state.body}</div> : null}
        {state?.phrase ? (
          <div style={{ marginTop: 'var(--space-4)' }}>
            <TextField
              label={`Type "${state.phrase}" to confirm`}
              value={typed}
              onChange={(e) => setTyped(e.target.value)}
              autoComplete="off"
            />
          </div>
        ) : null}
      </Dialog>
    </ConfirmContext.Provider>
  );
}

export function useConfirm(): ConfirmFn {
  const ctx = useContext(ConfirmContext);
  if (!ctx) throw new Error('useConfirm must be used inside <ConfirmProvider>');
  return ctx;
}
