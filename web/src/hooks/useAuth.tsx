import { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react';
import type { ReactNode } from 'react';
import { ApiError, endpoints, setUnauthorizedHandler } from '../api/client';
import type { PublicUser } from '../api/types';

type AuthState = {
  user: PublicUser | null;
  /** true until the initial /api/auth/me resolves */
  loading: boolean;
  login: (email: string, password: string) => Promise<PublicUser>;
  bootstrap: (email: string, password: string) => Promise<PublicUser>;
  logout: () => Promise<void>;
  refresh: () => Promise<void>;
};

const AuthContext = createContext<AuthState | null>(null);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<PublicUser | null>(null);
  const [loading, setLoading] = useState(true);

  const refresh = useCallback(async () => {
    try {
      const res = await endpoints.auth.me();
      setUser(res.user);
    } catch (err) {
      // 401 just means "not signed in"; anything else is also treated as signed out.
      if (!(err instanceof ApiError) || err.status !== 401) {
        // keep the user null; the login screen surfaces API problems itself
      }
      setUser(null);
    }
  }, []);

  useEffect(() => {
    let alive = true;
    void (async () => {
      await refresh();
      if (alive) setLoading(false);
    })();
    return () => {
      alive = false;
    };
  }, [refresh]);

  // A 401 on any later request means the session expired or was revoked. Drop
  // the user so RequireAuth sends them back to the login screen, rather than
  // leaving the page polling a 401 forever.
  useEffect(() => {
    setUnauthorizedHandler(() => setUser(null));
    return () => setUnauthorizedHandler(null);
  }, []);

  const login = useCallback(async (email: string, password: string) => {
    const res = await endpoints.auth.login(email, password);
    setUser(res.user);
    return res.user;
  }, []);

  const bootstrap = useCallback(async (email: string, password: string) => {
    const res = await endpoints.auth.bootstrap(email, password);
    setUser(res.user);
    return res.user;
  }, []);

  const logout = useCallback(async () => {
    try {
      await endpoints.auth.logout();
    } finally {
      setUser(null);
    }
  }, []);

  const value = useMemo<AuthState>(
    () => ({ user, loading, login, bootstrap, logout, refresh }),
    [user, loading, login, bootstrap, logout, refresh],
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthState {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error('useAuth must be used inside <AuthProvider>');
  return ctx;
}
