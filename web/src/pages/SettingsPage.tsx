import { useState } from 'react';
import { endpoints, errorMessage } from '../api/client';
import type { CloudflareStatus, PublicUser, SettingsView, UserRole } from '../api/types';
import { usePolling } from '../hooks/usePolling';
import { useAuth } from '../hooks/useAuth';
import { CloudflarePanel } from './TunnelsPage';
import {
  Banner,
  Button,
  Card,
  Dialog,
  EmptyState,
  Field,
  PageHead,
  Pill,
  SkeletonRows,
  TextField,
  useConfirm,
} from '../components/ui';
import { formatDateTime } from '../lib/format';

const ROLES: UserRole[] = ['admin', 'operator', 'viewer'];

export function SettingsPage() {
  const { user } = useAuth();
  const confirm = useConfirm();

  const cf = usePolling<CloudflareStatus>(() => endpoints.cloudflare.status(), { intervalMs: 30000 });
  const users = usePolling<PublicUser[]>(() => endpoints.users.list(), { intervalMs: 30000 });
  const settings = usePolling<SettingsView>(() => endpoints.settings.get(), {});

  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [pending, setPending] = useState<Record<string, boolean>>({});
  const [resetUser, setResetUser] = useState<PublicUser | null>(null);
  const [resetPassword, setResetPassword] = useState('');
  const [settingsText, setSettingsText] = useState<string | null>(null);
  const [settingsBusy, setSettingsBusy] = useState(false);

  const currentSettingsJson = settings.data ? JSON.stringify(settings.data, null, 2) : '';
  const editorValue = settingsText ?? currentSettingsJson;

  const createUser = async (email: string, password: string, role: UserRole) => {
    setError(null);
    setNotice(null);
    try {
      await endpoints.users.create({ email, password, role });
      setNotice(`Created user ${email}.`);
      await users.refresh();
    } catch (err) {
      setError(errorMessage(err));
    }
  };

  const changeRole = async (u: PublicUser, role: UserRole) => {
    setPending((p) => ({ ...p, [`${u.id}:role`]: true }));
    setError(null);
    try {
      await endpoints.users.update(u.id, { role });
      await users.refresh();
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setPending((p) => ({ ...p, [`${u.id}:role`]: false }));
    }
  };

  const submitReset = async () => {
    if (!resetUser) return;
    setPending((p) => ({ ...p, [`${resetUser.id}:pw`]: true }));
    setError(null);
    try {
      await endpoints.users.update(resetUser.id, { password: resetPassword });
      setNotice(`Password updated for ${resetUser.email}.`);
      setResetUser(null);
      setResetPassword('');
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setPending((p) => ({ ...p, [`${resetUser.id}:pw`]: false }));
    }
  };

  const deleteUser = async (u: PublicUser) => {
    const ok = await confirm({
      title: `Delete user ${u.email}?`,
      body: 'Their sessions are revoked and they lose access immediately.',
      confirmLabel: 'Delete user',
      danger: true,
    });
    if (!ok) return;
    setPending((p) => ({ ...p, [`${u.id}:remove`]: true }));
    setError(null);
    try {
      await endpoints.users.remove(u.id);
      await users.refresh();
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setPending((p) => ({ ...p, [`${u.id}:remove`]: false }));
    }
  };

  const saveSettings = async () => {
    setError(null);
    setNotice(null);
    let parsed: Record<string, unknown>;
    try {
      parsed = JSON.parse(editorValue) as Record<string, unknown>;
    } catch (err) {
      setError(`Settings must be valid JSON: ${errorMessage(err)}`);
      return;
    }
    setSettingsBusy(true);
    try {
      const res = await endpoints.settings.patch(parsed);
      settings.setData(res);
      setSettingsText(null);
      setNotice('Settings saved.');
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setSettingsBusy(false);
    }
  };

  return (
    <>
      <PageHead title="Settings" desc="Cloudflare credentials, users and server settings" />

      {error ? (
        <Banner tone="error" title="Settings action failed" onDismiss={() => setError(null)}>
          {error}
        </Banner>
      ) : null}
      {notice ? (
        <Banner tone="info" onDismiss={() => setNotice(null)}>
          {notice}
        </Banner>
      ) : null}

      <CloudflarePanel
        status={cf.data}
        loading={cf.loading}
        error={cf.error}
        onChanged={() => void cf.refresh()}
      />

      <Card title="Users">
        {users.loading && !users.data ? (
          <SkeletonRows rows={3} cols={4} />
        ) : users.error ? (
          <Banner tone="error" title="Could not load users">
            {errorMessage(users.error)}
          </Banner>
        ) : (users.data ?? []).length === 0 ? (
          <EmptyState icon="user" title="No users">
            Create the first user below.
          </EmptyState>
        ) : (
          <div className="table-wrap">
            <table className="data">
              <thead>
                <tr>
                  <th>Email</th>
                  <th>Role</th>
                  <th>Created</th>
                  <th>Last login</th>
                  <th className="num">Actions</th>
                </tr>
              </thead>
              <tbody>
                {(users.data ?? []).map((u) => (
                  <tr key={u.id}>
                    <td className="primary" data-label="Email">
                      {u.email}
                      {u.id === user?.id ? <span className="tag" style={{ marginLeft: 6 }}>you</span> : null}
                    </td>
                    <td data-label="Role">
                      <select
                        value={u.role}
                        disabled={pending[`${u.id}:role`]}
                        onChange={(e) => void changeRole(u, e.target.value as UserRole)}
                        aria-label={`Role for ${u.email}`}
                        style={{ width: 'auto', minHeight: 28 }}
                      >
                        {ROLES.map((r) => (
                          <option key={r} value={r}>
                            {r}
                          </option>
                        ))}
                      </select>
                    </td>
                    <td className="dim nowrap" data-label="Created">{formatDateTime(u.created_at)}</td>
                    <td className="dim nowrap" data-label="Last login">
                      {u.last_login_at ? formatDateTime(u.last_login_at) : 'never'}
                    </td>
                    <td className="cell-actions" data-label="Actions">
                      <Button size="sm" disabled={pending[`${u.id}:pw`]} onClick={() => { setResetUser(u); setResetPassword(''); }}>
                        Reset password
                      </Button>
                      <Button
                        size="sm"
                        variant="danger"
                        icon="trash"
                        disabled={u.id === user?.id || pending[`${u.id}:remove`]}
                        busy={pending[`${u.id}:remove`]}
                        aria-label={`Delete user ${u.email}`}
                        title={u.id === user?.id ? 'You cannot delete your own account' : 'Delete user'}
                        onClick={() => void deleteUser(u)}
                      />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>

      <NewUserCard onCreate={createUser} />

      <Card
        title="Server settings"
        actions={
          <>
            {settingsText !== null ? (
              <Button size="sm" onClick={() => setSettingsText(null)} disabled={settingsBusy}>
                Discard
              </Button>
            ) : null}
            <Button size="sm" variant="primary" busy={settingsBusy} disabled={settingsText === null} onClick={() => void saveSettings()}>
              Save settings
            </Button>
          </>
        }
      >
        {settings.loading && !settings.data ? (
          <SkeletonRows rows={4} cols={2} />
        ) : settings.error ? (
          <Banner tone="error" title="Could not load settings">
            {errorMessage(settings.error)}
          </Banner>
        ) : (
          <>
            <p className="dim" style={{ fontSize: 'var(--fs-xs)' }}>
              Secret values are masked by the API. Leave a masked value unchanged to keep it, or replace it
              with a new value. The editor sends a merge patch.
            </p>
            <Field label="Settings (JSON)">
              <textarea
                value={editorValue}
                onChange={(e) => setSettingsText(e.target.value)}
                rows={14}
                spellCheck={false}
                style={{ minHeight: 240 }}
              />
            </Field>
          </>
        )}
      </Card>

      <Dialog
        open={resetUser !== null}
        onClose={() => setResetUser(null)}
        title={resetUser ? `Reset password for ${resetUser.email}` : ''}
        footer={
          <>
            <Button onClick={() => setResetUser(null)}>Cancel</Button>
            <Button variant="primary" busy={resetUser ? pending[`${resetUser.id}:pw`] : false} disabled={resetPassword.length < 8} onClick={() => void submitReset()}>
              Set password
            </Button>
          </>
        }
      >
        <TextField
          label="New password"
          type="password"
          value={resetPassword}
          onChange={(e) => setResetPassword(e.target.value)}
          hint="At least 8 characters."
          autoComplete="new-password"
        />
      </Dialog>
    </>
  );
}

function NewUserCard({
  onCreate,
}: {
  onCreate: (email: string, password: string, role: UserRole) => Promise<void>;
}) {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [role, setRole] = useState<UserRole>('operator');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const valid = email.includes('@') && password.length >= 8;

  return (
    <Card title="Add a user">
      {error ? <Banner tone="error" title="Could not create user">{error}</Banner> : null}
      <div className="grid grid-3">
        <TextField label="Email" type="email" value={email} onChange={(e) => setEmail(e.target.value)} disabled={busy} />
        <TextField
          label="Password"
          type="password"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          disabled={busy}
          hint="At least 8 characters."
          autoComplete="new-password"
        />
        <Field label="Role">
          <select value={role} onChange={(e) => setRole(e.target.value as UserRole)} disabled={busy}>
            {ROLES.map((r) => (
              <option key={r} value={r}>
                {r}
              </option>
            ))}
          </select>
        </Field>
      </div>
      <div className="row">
        <Pill state={role === 'admin' ? 'paused' : role === 'operator' ? 'starting' : 'stopped'}>{role}</Pill>
        <Button
          variant="primary"
          icon="plus"
          busy={busy}
          disabled={!valid}
          onClick={async () => {
            setError(null);
            setBusy(true);
            try {
              await onCreate(email.trim(), password, role);
              setEmail('');
              setPassword('');
            } catch (err) {
              setError(errorMessage(err));
            } finally {
              setBusy(false);
            }
          }}
        >
          Create user
        </Button>
      </div>
    </Card>
  );
}
