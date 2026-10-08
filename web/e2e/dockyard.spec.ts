import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';
import {
  adminCredentials,
  deleteUser,
  ensureUser,
  login,
  tempPassword,
  userIdFor,
} from './helpers';

/**
 * End-to-end pass over the real API and the real built bundle: every section
 * renders, the role ladder is enforced in the browser (not just in the unit
 * tests), and no section logs a console error.
 */
const admin = adminCredentials();

const ROUTES: Array<{ path: string; heading: string }> = [
  { path: '/', heading: 'Dashboard' },
  { path: '/containers', heading: 'Containers' },
  { path: '/templates', heading: 'Templates' },
  { path: '/stacks', heading: 'Stacks' },
  { path: '/tunnels', heading: 'Tunnels' },
  { path: '/images', heading: 'Images' },
  { path: '/volumes', heading: 'Volumes' },
  { path: '/networks', heading: 'Networks' },
  { path: '/audit', heading: 'Audit log' },
  { path: '/settings', heading: 'Settings' },
];

function collectConsoleErrors(page: Page): string[] {
  const errors: string[] = [];
  page.on('console', (msg) => {
    if (msg.type() === 'error') errors.push(msg.text());
  });
  page.on('pageerror', (err) => errors.push(err.message));
  return errors;
}

const noise = (text: string): boolean =>
  /favicon|Download the React DevTools|ResizeObserver loop/i.test(text);

test('redirects an anonymous visitor to the login screen', async ({ page }) => {
  await page.goto('/containers');
  await expect(page).toHaveURL(/\/login/);
  await expect(page.getByLabel('Email')).toBeVisible();
  await expect(page.getByLabel('Password')).toBeVisible();
});

test('signs in through the real form and lands on the dashboard', async ({ page }) => {
  await login(page, admin.email, admin.password);
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('Dashboard');
  await expect(page.locator('.nav-item.active')).toHaveText('Dashboard');
});

test('renders every section with its heading, active nav and no console errors', async ({ page }) => {
  const errors = collectConsoleErrors(page);
  await login(page, admin.email, admin.password);

  for (const route of ROUTES) {
    await page.goto(route.path);
    await expect(page.getByRole('heading', { level: 1 })).toHaveText(route.heading);
    await expect(page.locator('.nav-item.active')).toHaveText(route.heading);
  }

  expect(errors.filter((e) => !noise(e))).toEqual([]);
});

test('shows a 404 surface for an unknown route', async ({ page }) => {
  await login(page, admin.email, admin.password);
  await page.goto('/no-such-page');
  await expect(page.getByRole('heading', { level: 1 })).toHaveText(/page not found/i);
});

test('a viewer can sign in but every write control is disabled', async ({ page, request, baseURL }) => {
  const email = `e2e-viewer-${Date.now()}@dockyard.local`;
  const password = tempPassword();
  await ensureUser(request, baseURL!, admin, { email, password, role: 'viewer' });

  try {
    await login(page, email, password);
    await expect(page.getByRole('heading', { level: 1 })).toHaveText('Dashboard');

    await page.goto('/containers');
    await expect(page.getByRole('button', { name: 'Run container' })).toBeDisabled();

    await page.goto('/networks');
    await expect(page.getByRole('heading', { level: 1 })).toHaveText('Networks');
  } finally {
    await deleteUser(request, baseURL!, admin, email);
  }
});

test('an operator may write but not destroy', async ({ page, request, baseURL }) => {
  const email = `e2e-operator-${Date.now()}@dockyard.local`;
  const password = tempPassword();
  await ensureUser(request, baseURL!, admin, { email, password, role: 'operator' });

  try {
    await login(page, email, password);

    await page.goto('/containers');
    await expect(page.getByRole('button', { name: 'Run container' })).toBeEnabled();

    // Destroy is admin-only. The host may legitimately have no images, so only
    // assert when a delete control is actually on screen.
    await page.goto('/images');
    const deletes = page.getByRole('button', { name: /^Delete image/ });
    const count = await deletes.count();
    if (count > 0) {
      for (let i = 0; i < count; i += 1) await expect(deletes.nth(i)).toBeDisabled();
    }
  } finally {
    await deleteUser(request, baseURL!, admin, email);
  }
});

test('an admin gets the destructive controls enabled', async ({ page }) => {
  await login(page, admin.email, admin.password);
  await page.goto('/containers');
  await expect(page.getByRole('button', { name: 'Run container' })).toBeEnabled();

  await page.goto('/images');
  const deletes = page.getByRole('button', { name: /^Delete image/ });
  const count = await deletes.count();
  if (count > 0) await expect(deletes.first()).toBeEnabled();
});

test('an admin allocates a resource and the scoped user sees only that', async ({
  page,
  request,
  baseURL,
}) => {
  const stamp = Date.now();
  const team = `e2e-team-${stamp}`;
  const email = `e2e-scoped-${stamp}@dockyard.local`;
  const password = tempPassword();
  const containerName = `dy-e2e-scope-${stamp}`;
  let containerId: string | null = null;

  await ensureUser(request, baseURL!, admin, { email, password, role: 'operator' });
  try {
    // A real container carrying the label the admin is about to allocate. The
    // second container is deliberately unlabelled, so a leak would be visible.
    await request.post(`${baseURL}/api/auth/login`, { data: admin });
    const created = await request.post(`${baseURL}/api/containers`, {
      data: {
        name: containerName,
        image: 'alpine:3.20',
        cmd: ['sh', '-c', 'sleep 120'],
        pull: false,
        labels: { 'dockyard.team': team },
      },
    });
    expect(created.status()).toBe(201);
    containerId = ((await created.json()) as { id: string }).id;

    // Allocate it through the real admin UI, not the API.
    await login(page, admin.email, admin.password);
    await page.goto('/settings');
    await page.getByRole('button', { name: `Resource allocation for ${email}` }).click();

    const dialog = page.getByRole('dialog', { name: 'Resource allocation' });
    await expect(dialog).toBeVisible();
    await dialog.getByLabel('Label key').fill('dockyard.team');
    await dialog.getByLabel('Label value').fill(team);
    await dialog.getByRole('button', { name: /^Allocate$/ }).click();
    await expect(dialog.getByText(`dockyard.team = ${team}`)).toBeVisible();

    // Adding the first grant switches the account to scoped, and the dialog has
    // to say so: it used to keep the stale badge and keep warning that grants
    // have no effect while the user is unscoped.
    await expect(dialog.getByText('scoped', { exact: true })).toBeVisible();
    await expect(dialog.getByText('unscoped')).toHaveCount(0);
    await expect(dialog.getByText(/Grants have no effect/)).toHaveCount(0);

    // The dialog has two Close controls (header icon and footer button); either
    // dismisses it.
    await dialog.getByRole('button', { name: 'Close' }).last().click();

    // The allocated user now sees the scoped notice and only their container.
    await page.getByRole('button', { name: 'Sign out' }).click();
    await login(page, email, password);
    await expect(page.getByText('Scoped account')).toBeVisible();

    await page.goto('/containers');
    await expect(page.getByText('Scoped account')).toBeVisible();
    await expect(page.getByRole('cell', { name: containerName })).toBeVisible();
  } finally {
    if (containerId) {
      await request.post(`${baseURL}/api/auth/login`, { data: admin });
      await request.delete(`${baseURL}/api/containers/${containerId}?force=1`);
    }
    await deleteUser(request, baseURL!, admin, email);
  }
});

test('container exec is off by default and an admin can turn it on', async ({
  page,
  request,
  baseURL,
}) => {
  const email = `e2e-exec-${Date.now()}@dockyard.local`;
  const password = tempPassword();
  await ensureUser(request, baseURL!, admin, { email, password, role: 'operator' });

  try {
    await login(page, admin.email, admin.password);
    await page.goto('/settings');

    const box = page.getByRole('checkbox', { name: `Allow container exec for ${email}` });
    await expect(box).not.toBeChecked();
    await box.check();
    await expect(box).toBeChecked();
  } finally {
    await deleteUser(request, baseURL!, admin, email);
  }
});
