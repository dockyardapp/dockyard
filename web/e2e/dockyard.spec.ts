import { readFileSync } from 'node:fs';

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

test('the first-run form reports its own failures, not sign-in ones', async ({ page }) => {
  await page.goto('/login');
  await page.getByRole('button', { name: /admin account/i }).click();
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('Create the first administrator');
  await expect(page.getByText(/at least 8 characters/i)).toBeVisible();

  // A short password is refused before a request is made.
  await page.getByLabel('Email').fill('someone@dockyard.test');
  await page.getByLabel('Password').fill('abc');
  await page.getByRole('button', { name: /create account/i }).click();
  await expect(page.getByText('Could not create the account')).toBeVisible();
  await expect(page.getByText('Sign in failed')).toHaveCount(0);
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

test('the templates page draws each product its own mark', async ({ page }) => {
  await login(page, admin.email, admin.password);
  await page.goto('/templates');
  await expect(page.locator('.tpl-card').first()).toBeVisible();

  // Read the card's own name element rather than filtering on page text: one
  // product's description can mention another's name.
  const cards = await page.locator('.tpl-card').evaluateAll((nodes) =>
    nodes.map((node) => ({
      name: node.querySelector('.tpl-name')?.textContent?.trim() ?? '',
      fill: node.querySelector('svg.tpl-icon')?.getAttribute('fill') ?? null,
    })),
  );

  const byName = new Map(cards.map((c) => [c.name, c.fill]));

  // The point of the change: the card carries the product's real logo, in the
  // product's own colour, rather than an emoji stand-in.
  expect(byName.get('PostgreSQL')).toBe('#4169E1');
  expect(byName.get('Redis')).toBe('#FF4438');
  expect(byName.get('Grafana')).toBe('#F46800');
  expect(byName.get('MongoDB')).toBe('#47A248');

  // Every built-in template has one, and they are not a single shared token.
  expect(cards.length).toBeGreaterThanOrEqual(15);
  expect(cards.filter((c) => c.fill === null)).toEqual([]);
  expect(new Set(cards.map((c) => c.fill)).size).toBeGreaterThan(10);
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

test('an admin ticks a resource for a user and that user sees only it', async ({
  page,
  request,
  baseURL,
}) => {
  const stamp = Date.now();
  const email = `e2e-scoped-${stamp}@dockyard.local`;
  const password = tempPassword();
  const containerName = `dy-e2e-scope-${stamp}`;
  let containerId: string | null = null;

  await ensureUser(request, baseURL!, admin, { email, password, role: 'operator' });
  try {
    // A real container. The second, unlabelled one the admin creates belongs to
    // the admin only, so a leak would be visible.
    await request.post(`${baseURL}/api/auth/login`, { data: admin });
    const created = await request.post(`${baseURL}/api/containers`, {
      data: {
        name: containerName,
        image: 'alpine:3.20',
        cmd: ['sh', '-c', 'sleep 120'],
        pull: false,
      },
    });
    expect(created.status()).toBe(201);
    containerId = ((await created.json()) as { id: string }).id;

    // Grant it through the real admin UI: pick the user, tick the box.
    await login(page, admin.email, admin.password);
    await page.goto('/settings');
    await page.getByRole('button', { name: `Resource access for ${email}` }).click();

    const dialog = page.getByRole('dialog', { name: 'Resource access' });
    await expect(dialog).toBeVisible();

    // The picker names the resource, so the admin ticks it without knowing an id.
    const box = dialog.getByRole('checkbox', { name: `${containerName} for ${email}` });
    await expect(box).not.toBeChecked();
    await box.check();
    await expect(box).toBeChecked();

    // It lands in the granted table, named.
    await expect(dialog.getByRole('table').getByText(containerName)).toBeVisible();

    // Ticking the first resource switches the account to scoped, and the dialog
    // has to say so: it used to keep the stale badge and keep warning that the
    // user still saw the whole host.
    await expect(dialog.getByText('scoped', { exact: true })).toBeVisible();
    await expect(dialog.getByText('unscoped')).toHaveCount(0);
    await expect(dialog.getByText(/still sees the whole host/)).toHaveCount(0);

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

test('the tunnels page explains the modes on its own tab', async ({ page }) => {
  await login(page, admin.email, admin.password);
  await page.goto('/tunnels');

  // The list is the default surface.
  await expect(page.getByRole('tab', { name: 'Tunnels' })).toHaveAttribute('aria-selected', 'true');

  await page.getByRole('tab', { name: 'How it works' }).click();
  await expect(page).toHaveURL(/tab=how/);

  // Every mode gets a column, and the guidance covers when to use each one.
  const guide = page.locator('table.data').first();
  for (const mode of ['quick', 'named', 'localtunnel']) {
    await expect(guide.getByRole('columnheader', { name: mode })).toBeVisible();
  }
  await expect(page.getByText(/adds no authentication of its own/i)).toBeVisible();

  // The tab is in the URL, so a reload keeps it.
  await page.reload();
  await expect(page.getByRole('tab', { name: 'How it works' })).toHaveAttribute(
    'aria-selected',
    'true',
  );

  // And back to the list, which drops the parameter.
  await page.getByRole('tab', { name: 'Tunnels' }).click();
  await expect(page).not.toHaveURL(/tab=how/);
  await expect(page.getByRole('button', { name: 'Create tunnel' })).toBeVisible();
});

test('the create-tunnel dialog offers localtunnel, which needs no Cloudflare account', async ({
  page,
}) => {
  await login(page, admin.email, admin.password);
  await page.goto('/tunnels');
  await page.getByRole('button', { name: 'Create tunnel' }).click();

  const dialog = page.getByRole('dialog');
  const chip = dialog.getByRole('button', { name: 'localtunnel' });
  await expect(chip).toBeVisible();

  await chip.click();
  await expect(chip).toHaveAttribute('aria-pressed', 'true');
  await expect(dialog.getByText(/assigned by localtunnel\.me/i)).toBeVisible();

  // LocalTunnel needs a name and a target and nothing else: no hostname, no zone and
  // no Cloudflare credentials, so the submit button goes live as soon as both are set.
  await dialog.getByLabel('Name').fill('e2e-localtunnel');
  await dialog.getByRole('button', { name: 'raw URL' }).click();
  await dialog.getByLabel('Target URL').fill('http://127.0.0.1:8080');

  await expect(dialog.getByRole('button', { name: 'Create tunnel' })).toBeEnabled();
});

test('the running version is visible in the chrome and detailed on settings', async ({ page }) => {
  await login(page, admin.email, admin.password);

  // Which build is deployed is the first question anyone asks, so it lives in the top bar rather
  // than behind a settings screen.
  const badge = page.getByRole('link', { name: /^Version \d/ });
  await expect(badge).toBeVisible();
  await expect(badge).toContainText(/^v\d+\.\d+\.\d+/);

  await page.goto('/settings');
  await expect(page.getByRole('heading', { name: 'Version' })).toBeVisible();

  // The card names the build, its commit and where it came from. The upstream check may fail on a
  // host with no route to GitHub, so the assertions stop at what the panel knows locally.
  const card = page.locator('.card', { has: page.getByRole('heading', { name: 'Version' }) });
  // Read the version from package.json rather than hardcoding it: a release bump should not break
  // the suite, and a stale hardcoded value would pass while the panel reported the wrong build.
  const pkg = JSON.parse(readFileSync(new URL('../../package.json', import.meta.url), 'utf8'));
  await expect(card).toContainText(`v${pkg.version}`);
  await expect(card).toContainText('EliasL-git/dockyard');
  await expect(card.getByRole('button', { name: 'Check for updates' })).toBeEnabled();
});

test('the update card refuses to promise an update it cannot deliver', async ({ page }) => {
  await login(page, admin.email, admin.password);
  await page.goto('/settings');

  const card = page.locator('.card', { has: page.getByRole('heading', { name: 'Version' }) });
  const install = card.getByRole('button', { name: /Install update/ });

  // No updater is installed on the test host and the branch tip is not known here, so the button
  // must be present but disabled, and the reason has to be on screen. A button that silently does
  // nothing is the failure this guards.
  await expect(install).toBeDisabled();
  await expect(card).toContainText(/install-updater\.sh|Nothing to install|already the tip|tip of main/);
});

test('no table hides its columns behind a sideways scroll', async ({ page }) => {
  await login(page, admin.email, admin.password);

  // A long unbreakable value in a cell (a 64-char volume id, a UUID, an email) used to set
  // the column's min-content width and push the table past its container, so the last
  // columns were clipped and the operator had to scroll sideways to read them.
  const ROUTES_WITH_TABLES = ['/', '/volumes', '/audit', '/images', '/networks', '/settings'];

  for (const route of ROUTES_WITH_TABLES) {
    await page.goto(route);

    const overflow = await page.evaluate(() =>
      [...document.querySelectorAll('.table-wrap')].map((w) => w.scrollWidth - w.clientWidth).filter((d) => d > 1),
    );
    expect(overflow, `${route} hides table columns behind a scroll`).toEqual([]);

    // And no cell's content is wider than the table itself.
    const cellsPastTable = await page.evaluate(() =>
      [...document.querySelectorAll('table.data')].flatMap((t) => {
        const right = t.getBoundingClientRect().right;
        return [...t.querySelectorAll('td')]
          .filter((td) => td.getBoundingClientRect().right > right + 1)
          .map((td) => (td.textContent ?? '').trim().slice(0, 30));
      }),
    );
    expect(cellsPastTable, `${route} has cells past the table edge`).toEqual([]);
  }
});

test('the sidebar keeps every entry and the account block on a short window', async ({ page }) => {
  // 600px is a laptop with browser chrome, or a resized window. The whole sidebar used to
  // scroll, which pushed the account block off the bottom and sliced the last nav entries.
  await page.setViewportSize({ width: 1280, height: 600 });
  await login(page, admin.email, admin.password);
  await page.goto('/containers');
  // Fail with a clear message if the shell is not up (a login failure would otherwise show
  // up as a null-property TypeError from the measurement below).
  await expect(page.locator('.sidebar')).toBeVisible();

  const fit = await page.evaluate(() => {
    const nav = document.querySelector('.nav')!;
    const items = [...document.querySelectorAll('.nav-item')];
    const last = items[items.length - 1].getBoundingClientRect();
    const navBox = nav.getBoundingClientRect();
    const foot = document.querySelector('.sidebar-foot')!.getBoundingClientRect();
    return {
      navScrolls: nav.scrollHeight > nav.clientHeight + 1,
      lastItemBottom: Math.round(last.bottom),
      navBottom: Math.round(navBox.bottom),
      footVisible: foot.bottom <= window.innerHeight + 1 && foot.top >= 0,
      entries: items.map((i) => (i.textContent ?? '').trim()),
    };
  });

  expect(fit.entries).toContain('Settings');
  expect(fit.navScrolls, 'the nav list needs scrolling at 600px').toBe(false);
  expect(fit.lastItemBottom, 'the last nav entry is clipped').toBeLessThanOrEqual(fit.navBottom + 1);
  expect(fit.footVisible, 'the account block is off screen').toBe(true);

  await expect(page.getByRole('link', { name: 'Settings' })).toBeVisible();
  await expect(page.getByText(admin.email)).toBeVisible();
});
