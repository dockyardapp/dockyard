import { Navigate, Route, Routes, useLocation } from 'react-router-dom';
import type { ReactNode } from 'react';
import { AppShell } from './components/AppShell';
import { EmptyState, Spinner } from './components/ui';
import { useAuth } from './hooks/useAuth';
import { EventsProvider } from './hooks/useEvents';
import { can } from './lib/rbac';
import { DashboardPage } from './pages/DashboardPage';
import { ContainersPage } from './pages/ContainersPage';
import { ContainerDetailPage } from './pages/ContainerDetailPage';
import { TemplatesPage } from './pages/TemplatesPage';
import { StacksPage } from './pages/StacksPage';
import { ImagesPage } from './pages/ImagesPage';
import { VolumesPage } from './pages/VolumesPage';
import { NetworksPage } from './pages/NetworksPage';
import { AuditPage } from './pages/AuditPage';
import { SettingsPage } from './pages/SettingsPage';
import { LoginPage } from './pages/LoginPage';
import { NotFoundPage } from './pages/NotFoundPage';

function BootScreen() {
  return (
    <div style={{ minHeight: '100vh', display: 'grid', placeItems: 'center' }}>
      <Spinner label="Loading Dockyard" />
    </div>
  );
}

/** Authenticated layout. Mounts the events socket only once signed in. */
function RequireAuth() {
  const { user, loading } = useAuth();
  const location = useLocation();
  if (loading) return <BootScreen />;
  if (!user) return <Navigate to="/login" replace state={{ from: location.pathname }} />;
  return (
    <EventsProvider>
      <AppShell />
    </EventsProvider>
  );
}

/** Admin-only guard for /audit and /settings. */
function RequireAdmin({ children }: { children: ReactNode }) {
  const { user } = useAuth();
  if (!can.manageUsers(user?.role)) {
    return (
      <EmptyState icon="shield" title="Administrators only">
        Your role does not have access to this section. Ask an administrator to raise your role.
      </EmptyState>
    );
  }
  return <>{children}</>;
}

export function App() {
  return (
    <Routes>
      <Route path="/login" element={<LoginPage />} />
      <Route element={<RequireAuth />}>
        <Route path="/" element={<DashboardPage />} />
        <Route path="/containers" element={<ContainersPage />} />
        <Route path="/containers/:id" element={<ContainerDetailPage />} />
        <Route path="/templates" element={<TemplatesPage />} />
        <Route path="/stacks" element={<StacksPage />} />
        <Route path="/images" element={<ImagesPage />} />
        <Route path="/volumes" element={<VolumesPage />} />
        <Route path="/networks" element={<NetworksPage />} />
        <Route
          path="/audit"
          element={
            <RequireAdmin>
              <AuditPage />
            </RequireAdmin>
          }
        />
        <Route
          path="/settings"
          element={
            <RequireAdmin>
              <SettingsPage />
            </RequireAdmin>
          }
        />
        <Route path="*" element={<NotFoundPage />} />
      </Route>
    </Routes>
  );
}
