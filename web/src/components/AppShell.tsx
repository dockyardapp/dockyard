import { useEffect, useState } from 'react';
import { NavLink, Outlet, useLocation, useNavigate } from 'react-router-dom';
import { useAuth } from '../hooks/useAuth';
import { useEvents } from '../hooks/useEvents';
import { can } from '../lib/rbac';
import { BrandMark, Icon, type IconName } from './Icons';
import { ErrorBoundary } from './ErrorBoundary';
import { VersionBadge } from './VersionBadge';
import { Banner, Button, Pill } from './ui';

type NavEntry = { to: string; label: string; icon: IconName; adminOnly?: boolean };

const GROUPS: Array<{ label: string; items: NavEntry[] }> = [
  {
    label: 'Operate',
    items: [
      { to: '/', label: 'Dashboard', icon: 'dashboard' },
      { to: '/containers', label: 'Containers', icon: 'container' },
      { to: '/templates', label: 'Templates', icon: 'template' },
      { to: '/stacks', label: 'Stacks', icon: 'stack' },
      { to: '/tunnels', label: 'Tunnels', icon: 'tunnel' },
    ],
  },
  {
    label: 'Resources',
    items: [
      { to: '/images', label: 'Images', icon: 'image' },
      { to: '/volumes', label: 'Volumes', icon: 'volume' },
      { to: '/networks', label: 'Networks', icon: 'network' },
    ],
  },
  {
    label: 'Admin',
    items: [
      { to: '/audit', label: 'Audit log', icon: 'audit', adminOnly: true },
      { to: '/settings', label: 'Settings', icon: 'settings', adminOnly: true },
    ],
  },
];

const TITLES: Array<[RegExp, string]> = [
  [/^\/$/, 'Dashboard'],
  [/^\/containers\/[^/]+$/, 'Container'],
  [/^\/containers$/, 'Containers'],
  [/^\/templates$/, 'Templates'],
  [/^\/stacks$/, 'Stacks'],
  [/^\/tunnels$/, 'Tunnels'],
  [/^\/images$/, 'Images'],
  [/^\/volumes$/, 'Volumes'],
  [/^\/networks$/, 'Networks'],
  [/^\/audit$/, 'Audit log'],
  [/^\/settings$/, 'Settings'],
];

function titleFor(pathname: string): string {
  for (const [re, label] of TITLES) if (re.test(pathname)) return label;
  return 'Dockyard';
}

export function AppShell() {
  const { user, logout } = useAuth();
  const { status } = useEvents();
  const location = useLocation();
  const navigate = useNavigate();
  const [navOpen, setNavOpen] = useState(false);

  useEffect(() => {
    setNavOpen(false);
  }, [location.pathname]);

  const role = user?.role ?? null;
  const title = titleFor(location.pathname);
  const eventTone = status === 'open' ? 'running' : status === 'connecting' ? 'starting' : 'error';

  return (
    <div className={`app-shell${navOpen ? ' nav-open' : ''}`}>
      <div className="sidebar-backdrop" onClick={() => setNavOpen(false)} aria-hidden="true" />
      <aside className="sidebar" aria-label="Primary">
        <div className="brand">
          <BrandMark className="brand-mark" />
          <span className="brand-name">Dockyard</span>
          <span className="brand-env">console</span>
        </div>
        <nav className="nav">
          {GROUPS.map((group) => {
            const items = group.items.filter((it) => !it.adminOnly || can.manageUsers(role));
            if (items.length === 0) return null;
            return (
              <div key={group.label}>
                <div className="nav-group-label">{group.label}</div>
                {items.map((it) => (
                  <NavLink
                    key={it.to}
                    to={it.to}
                    end={it.to === '/'}
                    className={({ isActive }) => `nav-item${isActive ? ' active' : ''}`}
                  >
                    <Icon name={it.icon} className="nav-icon" />
                    {it.label}
                  </NavLink>
                ))}
              </div>
            );
          })}
        </nav>
        <div className="sidebar-foot">
          <div className="row" style={{ justifyContent: 'space-between', marginBottom: 'var(--space-2)' }}>
            <span className="dim" style={{ fontSize: 'var(--fs-micro)' }}>events</span>
            <Pill state={eventTone}>{status}</Pill>
          </div>
          <div className="row" style={{ justifyContent: 'space-between', gap: 'var(--space-2)' }}>
            <div style={{ minWidth: 0 }}>
              <div className="truncate" style={{ color: 'var(--text-primary)', fontSize: 'var(--fs-xs)' }} title={user?.email}>
                {user?.email ?? 'signed out'}
              </div>
              <div className="dim" style={{ fontSize: 'var(--fs-micro)' }}>
                {user?.role ?? '-'}
                {user?.scope_mode === 'granted' ? ' / scoped' : ''}
              </div>
            </div>
            <Button
              variant="subtle"
              size="sm"
              icon="logout"
              aria-label="Sign out"
              title="Sign out"
              onClick={async () => {
                await logout();
                navigate('/login', { replace: true });
              }}
            />
          </div>
        </div>
      </aside>

      <div className="main">
        <header className="topbar">
          <Button
            className="hamburger"
            variant="subtle"
            size="sm"
            icon="menu"
            aria-label="Toggle navigation"
            aria-expanded={navOpen}
            onClick={() => setNavOpen((v) => !v)}
          />
          <span className="topbar-title">{title}</span>
          <div className="topbar-actions">
            <VersionBadge />
            <Pill state={eventTone}>{status === 'open' ? 'live' : status}</Pill>
          </div>
        </header>
        <main className="content">
          {/* Without this an allocated user just sees short lists and assumes the
              panel is broken. */}
          {user?.scope_mode === 'granted' ? (
            <Banner tone="info" title="Scoped account">
              You are seeing only the resources allocated to you. Ask an administrator to widen your
              allocation if something is missing.
            </Banner>
          ) : null}
          <ErrorBoundary title="This view stopped responding">
            <Outlet />
          </ErrorBoundary>
        </main>
      </div>
    </div>
  );
}
