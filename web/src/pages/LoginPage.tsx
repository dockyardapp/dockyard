import { useState } from 'react';
import { Navigate, useLocation, useNavigate } from 'react-router-dom';
import { errorMessage } from '../api/client';
import { useAuth } from '../hooks/useAuth';
import { BrandMark } from '../components/Icons';
import { Banner, Button, TextField } from '../components/ui';
import { MIN_PASSWORD_LENGTH, PASSWORD_HINT, PASSWORD_TOO_SHORT } from '../lib/password';

type Mode = 'login' | 'bootstrap';

export function LoginPage() {
  const { user, loading, login, bootstrap } = useAuth();
  const navigate = useNavigate();
  const location = useLocation();
  const [mode, setMode] = useState<Mode>('login');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  if (!loading && user) {
    const from = (location.state as { from?: string } | null)?.from;
    return <Navigate to={from && from !== '/login' ? from : '/'} replace />;
  }

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    if (mode === 'bootstrap' && password.length < MIN_PASSWORD_LENGTH) {
      setError(PASSWORD_TOO_SHORT);
      return;
    }
    setBusy(true);
    try {
      if (mode === 'bootstrap') await bootstrap(email.trim(), password);
      else await login(email.trim(), password);
      navigate('/', { replace: true });
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="login-wrap">
      <div className="login-panel">
        <div className="login-card">
          <div className="login-brand">
            <BrandMark className="brand-mark" />
            <span className="brand-name">Dockyard</span>
          </div>

          <h1 style={{ fontSize: 'var(--fs-h3)', marginBottom: 'var(--space-1)' }}>
            {mode === 'bootstrap' ? 'Create the first administrator' : 'Sign in'}
          </h1>
          <p className="muted" style={{ fontSize: 'var(--fs-xs)', marginBottom: 'var(--space-5)' }}>
            {mode === 'bootstrap'
              ? 'No users exist yet. The account you create here becomes the administrator.'
              : 'Use your Dockyard account to reach the console.'}
          </p>

          {error ? (
            <Banner tone="error" title={mode === 'bootstrap' ? 'Could not create the account' : 'Sign in failed'}>
              {error}
            </Banner>
          ) : null}

          <form onSubmit={submit} noValidate>
            <TextField
              label="Email"
              type="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              autoComplete="username"
              required
              disabled={busy}
            />
            <TextField
              label="Password"
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              autoComplete={mode === 'bootstrap' ? 'new-password' : 'current-password'}
              required
              disabled={busy}
              hint={mode === 'bootstrap' ? PASSWORD_HINT : undefined}
            />
            <Button type="submit" variant="primary" size="lg" block busy={busy}>
              {mode === 'bootstrap' ? 'Create account' : 'Sign in'}
            </Button>
          </form>

          <div className="row" style={{ marginTop: 'var(--space-5)', justifyContent: 'space-between' }}>
            <span className="dim" style={{ fontSize: 'var(--fs-micro)' }}>
              {mode === 'login' ? 'First run?' : 'Already have an account?'}
            </span>
            <Button
              variant="subtle"
              size="sm"
              onClick={() => {
                setMode(mode === 'login' ? 'bootstrap' : 'login');
                setError(null);
              }}
              disabled={busy}
            >
              {mode === 'login' ? 'Create admin account' : 'Back to sign in'}
            </Button>
          </div>
        </div>
      </div>

      {/*
        The decorative half of the screen. It is the one surface in the product with no control
        on it, which is why it is the only place colour is allowed to be the point rather than a
        signal. It carries no text, so there is nothing here to announce: `aria-hidden` keeps a
        landmark with no content out of the accessibility tree.
      */}
      <div className="login-side" aria-hidden="true" />
    </div>
  );
}
