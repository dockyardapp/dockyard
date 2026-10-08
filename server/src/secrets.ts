// Dockyard — secret storage helpers (owner: agent 3).
//
// AES-256-GCM with a 32-byte key decoded from config.secretKey (64 hex chars).
// On-disk/blob format is exactly `v1:<ivB64>:<tagB64>:<ctB64>`.
//
// Rule: a secret value must never appear in a log line, an API response, or an
// error message. Only maskSecret()/fingerprint() outputs are safe to surface.

import crypto from 'node:crypto';
import { config } from './config.ts';
import { logger } from './logger.ts';

const BLOB_VERSION = 'v1';
const IV_BYTES = 12; // 96-bit nonce, the AES-GCM recommendation
const TAG_BYTES = 16;
const BASE64_RE = /^[A-Za-z0-9+/]+={0,2}$/;

/** Raised for a malformed blob or an authentication-tag mismatch. Never echoes the input. */
export class SecretError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SecretError';
  }
}

let cachedKey: Buffer | null = null;

/** Decode the 32-byte encryption key from config.secretKey. */
function encryptionKey(): Buffer {
  if (cachedKey) return cachedKey;
  const raw = (config.secretKey ?? '').trim();
  if (/^[0-9a-fA-F]{64}$/.test(raw)) {
    cachedKey = Buffer.from(raw, 'hex');
    return cachedKey;
  }
  if (raw.length === 0) {
    throw new SecretError(
      'secret storage is not configured: SECRET_KEY is empty (expected 64 hex characters)',
    );
  }
  // Fallback so a non-hex SECRET_KEY still yields a deterministic 32-byte key.
  logger.warn('SECRET_KEY is not 64 hex characters; deriving the AES key via sha256', {
    length: raw.length,
  });
  cachedKey = crypto.createHash('sha256').update(raw, 'utf8').digest();
  return cachedKey;
}

/** Encrypt a plaintext secret into the `v1:<iv>:<tag>:<ct>` blob format. */
export function encryptSecret(plain: string): string {
  const iv = crypto.randomBytes(IV_BYTES);
  const cipher = crypto.createCipheriv('aes-256-gcm', encryptionKey(), iv);
  const ciphertext = Buffer.concat([cipher.update(String(plain), 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return [
    BLOB_VERSION,
    iv.toString('base64'),
    tag.toString('base64'),
    ciphertext.toString('base64'),
  ].join(':');
}

/**
 * Decrypt a `v1:<iv>:<tag>:<ct>` blob. Throws SecretError with a clear message on a
 * malformed blob or an authentication-tag mismatch (wrong key / corrupted data).
 */
export function decryptSecret(blob: string): string {
  if (typeof blob !== 'string' || blob.length === 0) {
    throw new SecretError('cannot decrypt secret: value is empty');
  }
  const parts = blob.split(':');
  if (parts.length !== 4) {
    throw new SecretError('cannot decrypt secret: malformed blob (expected 4 colon-separated parts)');
  }
  const [version, ivB64, tagB64, ctB64] = parts;
  if (version !== BLOB_VERSION) {
    throw new SecretError(`cannot decrypt secret: unsupported blob version '${version}'`);
  }
  if (!BASE64_RE.test(ivB64) || !BASE64_RE.test(tagB64) || !BASE64_RE.test(ctB64)) {
    throw new SecretError('cannot decrypt secret: malformed blob (invalid base64 segment)');
  }

  const iv = Buffer.from(ivB64, 'base64');
  const tag = Buffer.from(tagB64, 'base64');
  const ciphertext = Buffer.from(ctB64, 'base64');
  if (iv.length !== IV_BYTES) {
    throw new SecretError('cannot decrypt secret: malformed blob (bad IV length)');
  }
  if (tag.length !== TAG_BYTES) {
    throw new SecretError('cannot decrypt secret: malformed blob (bad auth-tag length)');
  }

  try {
    const decipher = crypto.createDecipheriv('aes-256-gcm', encryptionKey(), iv);
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString('utf8');
  } catch {
    // Do not include the underlying message: it can contain no secret, but be explicit anyway.
    throw new SecretError('cannot decrypt secret: authentication failed (wrong key or corrupted data)');
  }
}

/**
 * Mask a secret for display: at most the first 4 and last 4 characters with an ellipsis
 * between. Values of 8 characters or fewer are fully masked (no characters revealed).
 * Returns null for null/undefined input.
 */
export function maskSecret(plain: string | null | undefined): string | null {
  if (plain === null || plain === undefined) return null;
  const value = String(plain);
  if (value.length === 0) return '';
  if (value.length <= 8) return '*'.repeat(value.length);
  return `${value.slice(0, 4)}\u2026${value.slice(-4)}`;
}

/** sha256 of the secret, hex, first 16 characters. Safe to log. */
export function fingerprint(plain: string): string {
  return crypto.createHash('sha256').update(String(plain), 'utf8').digest('hex').slice(0, 16);
}
