// Dockyard — password hashing (owner: agent 2).
//
// scrypt via node:crypto only. The stored format is
//
//   scrypt$<N>$<r>$<p>$<saltB64>$<hashB64>
//
// so the cost parameters travel with the hash and can be raised later without
// invalidating existing rows. Verification uses timingSafeEqual.

import crypto from 'node:crypto';

/**
 * Minimum length for a new password. The sign-in and reset forms state the same
 * rule, but this is the one that is enforced: a client-side check is a courtesy,
 * not a control, and the API is reachable directly.
 */
export const MIN_PASSWORD_LENGTH = 8;

const N = 16384; // CPU/memory cost (2^14)
const R = 8; // block size
const P = 1; // parallelisation
const KEYLEN = 64;
const SALT_BYTES = 16;

function scrypt(password: string, salt: Buffer, keylen: number, opts: { N: number; r: number; p: number }): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    crypto.scrypt(password, salt, keylen, { ...opts, maxmem: 256 * 1024 * 1024 }, (err, derived) => {
      if (err) reject(err);
      else resolve(derived);
    });
  });
}

/** Hash a plaintext password into the storable `scrypt$…` string. */
export async function hashPassword(password: string): Promise<string> {
  const salt = crypto.randomBytes(SALT_BYTES);
  const derived = await scrypt(password, salt, KEYLEN, { N, r: R, p: P });
  return ['scrypt', N, R, P, salt.toString('base64'), derived.toString('base64')].join('$');
}

/** Verify a plaintext password against a stored hash. Never throws on malformed input. */
export async function verifyPassword(password: string, stored: string | null | undefined): Promise<boolean> {
  if (typeof stored !== 'string') return false;
  const parts = stored.split('$');
  if (parts.length !== 6 || parts[0] !== 'scrypt') return false;

  const n = Number(parts[1]);
  const r = Number(parts[2]);
  const p = Number(parts[3]);
  if (!Number.isFinite(n) || !Number.isFinite(r) || !Number.isFinite(p)) return false;

  let salt: Buffer;
  let expected: Buffer;
  try {
    salt = Buffer.from(parts[4], 'base64');
    expected = Buffer.from(parts[5], 'base64');
  } catch {
    return false;
  }
  if (salt.length === 0 || expected.length === 0) return false;

  let derived: Buffer;
  try {
    derived = await scrypt(password, salt, expected.length, { N: n, r, p });
  } catch {
    return false;
  }
  if (derived.length !== expected.length) return false;
  return crypto.timingSafeEqual(derived, expected);
}

// A fixed, valid hash used to burn the same scrypt work when the submitted email
// does not exist, so login response timing does not reveal whether an account exists.
const DUMMY_HASH = await hashPassword(crypto.randomBytes(24).toString('hex'));

/** Run a throwaway verify to keep unknown-email logins as slow as known ones. */
export async function dummyVerify(password: string): Promise<void> {
  try {
    await verifyPassword(password, DUMMY_HASH);
  } catch {
    /* ignore */
  }
}
