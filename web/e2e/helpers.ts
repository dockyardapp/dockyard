import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { APIRequestContext } from '@playwright/test';

const here = path.dirname(fileURLToPath(import.meta.url));
export const repoRoot = path.resolve(here, '..', '..');

/**
 * Read the admin credentials the running API was bootstrapped with.
 *
 * The values are used only to drive the login form and to mint throwaway
 * role-test users. They are never printed, logged, or written to a file.
 */
export function adminCredentials(): { email: string; password: string } {
  const text = readFileSync(path.join(repoRoot, '.env'), 'utf8');
  const env: Record<string, string> = {};
  for (const raw of text.split('\n')) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq === -1) continue;
    env[line.slice(0, eq).trim()] = line.slice(eq + 1).trim();
  }
  const email = env.DOCKYARD_ADMIN_EMAIL;
  const password = env.DOCKYARD_ADMIN_PASSWORD;
  if (!email || !password) {
    throw new Error('DOCKYARD_ADMIN_EMAIL / DOCKYARD_ADMIN_PASSWORD are not set in .env');
  }
  return { email, password };
}

/** A throwaway credential for a role-test account, unique per run. */
export function tempPassword(): string {
  return `e2e-${Math.random().toString(36).slice(2)}-${Date.now().toString(36)}`;
}

/** Sign in through the real form and wait for the shell to render. */
export async function login(
  page: import('@playwright/test').Page,
  email: string,
  password: string,
): Promise<void> {
  await page.goto('/login');
  await page.getByLabel(/email/i).fill(email);
  await page.getByLabel(/password/i).fill(password);
  await page.getByRole('button', { name: /sign in|log in/i }).click();
  await page.waitForURL((url) => !url.pathname.startsWith('/login'), { timeout: 20_000 });
}

/** Create a user via the admin API, or return the existing one. */
export async function ensureUser(
  request: APIRequestContext,
  baseURL: string,
  admin: { email: string; password: string },
  user: { email: string; password: string; role: 'admin' | 'operator' | 'viewer' },
): Promise<void> {
  const loginRes = await request.post(`${baseURL}/api/auth/login`, {
    data: { email: admin.email, password: admin.password },
  });
  if (!loginRes.ok()) throw new Error(`admin login failed: ${loginRes.status()}`);

  const res = await request.post(`${baseURL}/api/users`, { data: user });
  if (res.ok() || res.status() === 409) return;
  throw new Error(`could not create ${user.role} user: ${res.status()} ${await res.text()}`);
}

/** Delete a user via the admin API; tolerates it already being gone. */
export async function deleteUser(
  request: APIRequestContext,
  baseURL: string,
  admin: { email: string; password: string },
  email: string,
): Promise<void> {
  await request.post(`${baseURL}/api/auth/login`, {
    data: { email: admin.email, password: admin.password },
  });
  const list = await request.get(`${baseURL}/api/users`);
  if (!list.ok()) return;
  const users = (await list.json()) as Array<{ id: string; email: string }>;
  const found = users.find((u) => u.email === email);
  if (found) await request.delete(`${baseURL}/api/users/${found.id}`);
}

/** Look up a user's id as the admin, so a test can address them directly. */
export async function userIdFor(
  request: APIRequestContext,
  baseURL: string,
  admin: { email: string; password: string },
  email: string,
): Promise<string> {
  await request.post(`${baseURL}/api/auth/login`, {
    data: { email: admin.email, password: admin.password },
  });
  const list = await request.get(`${baseURL}/api/users`);
  if (!list.ok()) throw new Error(`could not list users: ${list.status()}`);
  const users = (await list.json()) as Array<{ id: string; email: string }>;
  const found = users.find((u) => u.email === email);
  if (!found) throw new Error(`no user with email ${email}`);
  return found.id;
}
