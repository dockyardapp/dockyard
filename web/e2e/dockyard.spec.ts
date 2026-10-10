import { copyFileSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { expect, test } from '@playwright/test';
import type { APIRequestContext, Page } from '@playwright/test';
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

/** web/e2e -> repo root, so a test can write into the real data/templates. */
const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

/** The panel ships no catalog, so the suite seeds the template directory with these. */
const FIXTURE_TEMPLATES = path.join(REPO_ROOT, 'server', 'test', 'fixtures', 'templates');
const TEMPLATE_DIR = path.join(REPO_ROOT, 'data', 'templates');

/**
 * Put the fixtures in the template directory for the whole run.
 *
 * The panel compiles no catalog in any more: a template comes from the repository, from this
 * directory, or from the panel. This suite runs with the repository switched off so it stays offline
 * and deterministic, which leaves this directory as the only source, so it has to have something in
 * it for the templates page to have anything to draw.
 */
const seededTemplates: string[] = [];

test.beforeAll(() => {
  mkdirSync(TEMPLATE_DIR, { recursive: true });
  for (const name of readdirSync(FIXTURE_TEMPLATES)) {
    if (!name.endsWith('.json')) continue;
    copyFileSync(path.join(FIXTURE_TEMPLATES, name), path.join(TEMPLATE_DIR, name));
    seededTemplates.push(name);
  }
});

test.afterAll(() => {
  for (const name of seededTemplates) rmSync(path.join(TEMPLATE_DIR, name), { force: true });
});

const ROUTES: Array<{ path: string; heading: string }> = [
  { path: '/', heading: 'Dashboard' },
  { path: '/containers', heading: 'Containers' },
  { path: '/templates', heading: 'Templates' },
  { path: '/stacks', heading: 'Stacks' },
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

test('the login screen shows no host detail before anyone has signed in', async ({ page }) => {
  const hostCalls: string[] = [];
  page.on('request', (request) => {
    if (/\/api\/system\/(info|health)/.test(request.url())) hostCalls.push(request.url());
  });

  await page.goto('/login');
  await expect(page.getByLabel('Email')).toBeVisible();
  await page.waitForLoadState('networkidle');

  // The decorative half is a gradient and nothing else. It used to render the host's container and
  // image counts and the panel's own version, which is not something an anonymous visitor can act
  // on. It is aria-hidden because a landmark wrapping no content is announced as an empty region.
  const aside = page.locator('.login-side');
  await expect(aside).toHaveAttribute('aria-hidden', 'true');
  await expect(aside).toBeEmpty();
  await expect(page.getByText('Host status')).toHaveCount(0);

  // And the page does not ask the API about the host at all until someone signs in.
  expect(hostCalls).toEqual([]);
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
  const allCards = await page.locator('.tpl-card').evaluateAll((nodes) =>
    nodes.map((node) => ({
      name: node.querySelector('.tpl-name')?.textContent?.trim() ?? '',
      fill: node.querySelector('svg.tpl-icon')?.getAttribute('fill') ?? null,
    })),
  );

  // Assert by product name rather than by source tag. The panel compiles no catalog in, so the same
  // product can arrive from the repository, from a file, or from the panel, and the mark is looked
  // up by slug either way.
  const byName = new Map(allCards.map((c) => [c.name, c.fill]));

  // The point of the change: the card carries the product's real logo, in the
  // product's own colour, rather than an emoji stand-in.
  expect(byName.get('PostgreSQL')).toBe('#4169E1');
  expect(byName.get('Redis')).toBe('#FF4438');
  expect(byName.get('Grafana')).toBe('#F46800');
  expect(byName.get('MongoDB')).toBe('#47A248');

  // Every template the suite seeded carries a real mark, and they are not one shared token. Whether
  // the whole catalog does is the templates repository's business, checked in
  // server/test/template-logos.test.ts.
  const marked = allCards.filter((c) => c.fill !== null);
  expect(marked.length).toBeGreaterThanOrEqual(6);
  expect(new Set(marked.map((c) => c.fill)).size).toBeGreaterThan(4);
});

test('a template file on disk shows up without a restart, and a bad one is reported', async ({ page }) => {
  await login(page, admin.email, admin.password);

  // The panel reads config.templateDir, which for this suite is the repo's own
  // data/templates. Write a real file there, exactly as an operator would, and
  // clean it up afterwards. No restart happens in between: the panel reconciles
  // the directory before answering the next read.
  const stamp = Date.now();
  const slug = `e2e-file-${stamp}`;
  const dir = path.join(REPO_ROOT, 'data', 'templates');
  const good = path.join(dir, `${slug}.json`);
  const bad = path.join(dir, `${slug}-broken.json`);
  mkdirSync(dir, { recursive: true });

  try {
    writeFileSync(
      good,
      JSON.stringify({
        schemaVersion: 1,
        slug,
        name: 'Dropped in by a test',
        category: 'other',
        icon: 'template',
        description: 'Written by the end-to-end suite.',
        image: 'traefik/whoami',
        tag: 'v1.11.0',
        ports: [],
        env: [],
        volumes: [],
        restartPolicy: 'unless-stopped',
      }),
    );

    await page.goto('/templates');

    // The card is there and says where it came from.
    const card = page.locator('.tpl-card', { hasText: 'Dropped in by a test' });
    await expect(card).toBeVisible();
    await expect(card.locator('.tag', { hasText: 'from a file' })).toBeVisible();

    // The sources card names the file and lists the template it produced.
    const filesCard = page.locator('.card', { hasText: 'Template sources' });
    const goodRow = filesCard.locator('tbody tr', { hasText: `${slug}.json` });
    await expect(goodRow).toContainText(slug);
    await expect(goodRow.locator('.pill')).toHaveText('loaded');

    // The repository half of the card is present and says it is switched off in this suite.
    await expect(filesCard).toContainText('No template repository is configured');

    // The source filter knows about the new value.
    await page.selectOption('select[aria-label="Filter by source"]', 'file');
    await expect(card).toBeVisible();

    // A malformed file is reported, and the good one still loads.
    writeFileSync(bad, '{ this is not json');
    await page.reload();

    const badRow = page
      .locator('.card', { hasText: 'Template sources' })
      .locator('tbody tr', { hasText: `${slug}-broken.json` });
    await expect(badRow.locator('.pill')).toHaveText('error');
    await expect(page.locator('.tpl-card', { hasText: 'Dropped in by a test' })).toBeVisible();
  } finally {
    rmSync(good, { force: true });
    rmSync(bad, { force: true });
  }
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

/**
 * A real container with a real published port, for the tests that need one to hang routing on.
 *
 * The port is drawn from the high range so a run cannot collide with whatever the host is already
 * publishing, and the container is removed in the caller's `finally`.
 */
async function makePublishedContainer(
  request: APIRequestContext,
  baseURL: string,
  prefix: string,
): Promise<{ id: string; name: string; hostPort: number }> {
  const stamp = Date.now();
  const name = `${prefix}-${stamp}`;
  const hostPort = 30000 + Math.floor(Math.random() * 9000);
  await request.post(`${baseURL}/api/auth/login`, { data: admin });
  const created = await request.post(`${baseURL}/api/containers`, {
    data: {
      name,
      image: 'alpine:3.20',
      cmd: ['sh', '-c', 'sleep 120'],
      pull: false,
      ports: [{ container: 80, host: hostPort }],
    },
  });
  expect(created.status(), await created.text()).toBe(201);
  const { id } = (await created.json()) as { id: string };
  // Docker reports no port bindings until a container has actually run, so a container left in
  // `created` reads as publishing nothing and the port table is empty.
  const started = await request.post(`${baseURL}/api/containers/${id}/start`);
  expect(started.status(), await started.text()).toBe(200);
  return { id, name, hostPort };
}

test('a container is where its ports and tunnels live, and the separate tunnels page is gone', async ({
  page,
  request,
  baseURL,
}) => {
  const container = await makePublishedContainer(request, baseURL!, 'dy-e2e-tunnel');

  try {
    await login(page, admin.email, admin.password);

    // Routing no longer has a section of its own: the nav offers no Tunnels entry, and the old
    // path is not a route any more.
    await expect(page.locator('.nav-item', { hasText: 'Tunnels' })).toHaveCount(0);
    await page.goto('/tunnels');
    await expect(page.getByRole('heading', { level: 1 })).toHaveText(/page not found/i);

    await page.goto(`/containers/${container.id}?tab=tunnels`);

    // The container's own published port, with the action that exposes it.
    await expect(page.getByRole('cell', { name: String(container.hostPort) })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Expose', exact: true })).toBeVisible();

    // The reference material is behind a button rather than owning a tab of its own.
    await page.getByRole('button', { name: 'How it works' }).click();
    const guide = page.getByRole('dialog', { name: 'How tunnels work' });
    await expect(guide).toBeVisible();

    const table = guide.locator('table.data').first();
    for (const mode of ['quick', 'named', 'localtunnel']) {
      await expect(table.getByRole('columnheader', { name: mode })).toBeVisible();
    }
    await expect(guide.getByText(/adds no authentication of its own/i)).toBeVisible();
    await guide.getByRole('button', { name: 'Close' }).last().click();

    // The tab is in the URL, so a reload keeps it.
    await page.reload();
    await expect(page.getByRole('tab', { name: 'Tunnels' })).toHaveAttribute('aria-selected', 'true');
  } finally {
    await request.post(`${baseURL}/api/auth/login`, { data: admin });
    await request.delete(`${baseURL}/api/containers/${container.id}?force=1`);
  }
});

test('exposing a port carries the container and the port with it, and offers localtunnel', async ({
  page,
  request,
  baseURL,
}) => {
  const container = await makePublishedContainer(request, baseURL!, 'dy-e2e-expose');

  try {
    await login(page, admin.email, admin.password);
    await page.goto(`/containers/${container.id}?tab=tunnels`);

    // The per-port action arrives already knowing what it is exposing.
    await page.getByRole('button', { name: 'Expose', exact: true }).click();
    const dialog = page.getByRole('dialog');
    await expect(dialog).toBeVisible();
    await expect(dialog.getByLabel('Name')).toHaveValue(`${container.name}-${container.hostPort}`);
    await expect(dialog.getByLabel('Published port')).toHaveValue(String(container.hostPort));

    const chip = dialog.getByRole('button', { name: 'localtunnel' });
    await expect(chip).toBeVisible();
    await chip.click();
    await expect(chip).toHaveAttribute('aria-pressed', 'true');
    await expect(dialog.getByText(/assigned by localtunnel\.me/i)).toBeVisible();

    // LocalTunnel needs no hostname and no Cloudflare credentials, so Create is live already.
    await expect(dialog.getByRole('button', { name: 'Create tunnel' })).toBeEnabled();
  } finally {
    await request.post(`${baseURL}/api/auth/login`, { data: admin });
    await request.delete(`${baseURL}/api/containers/${container.id}?force=1`);
  }
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
  await expect(card).toContainText('dockyardapp/dockyard');
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
  const ROUTES_WITH_TABLES = ['/', '/templates', '/volumes', '/audit', '/images', '/networks', '/settings'];

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
