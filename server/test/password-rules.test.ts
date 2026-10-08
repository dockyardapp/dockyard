// Dockyard — password rule parity test.
//
// The minimum password length is stated in two places: server/src/auth/password.ts
// enforces it, and web/src/lib/password.ts mirrors it so the forms can word the
// hint and gate their buttons. Neither file can import the other (different
// tsconfigs, different runtimes), so this reads the web module as text and
// compares. If the two drift, the form either blocks a password the API would
// accept or, worse, offers one the API rejects.
//
//   export PATH=/root/.hermes/node/bin:$PATH
//   node --test server/test/password-rules.test.ts

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { MIN_PASSWORD_LENGTH } from '../src/auth/password.ts';

const WEB_RULES = fileURLToPath(new URL('../../web/src/lib/password.ts', import.meta.url));

describe('password rules', () => {
  it('the web mirror states the same minimum the server enforces', () => {
    const source = readFileSync(WEB_RULES, 'utf8');
    const match = source.match(/export const MIN_PASSWORD_LENGTH\s*=\s*(\d+)/);

    assert.ok(match, 'expected to find MIN_PASSWORD_LENGTH in web/src/lib/password.ts');
    assert.equal(Number(match[1]), MIN_PASSWORD_LENGTH);
  });

  it('the minimum is not so low that it stops being a control', () => {
    assert.ok(MIN_PASSWORD_LENGTH >= 8, 'a shorter minimum than 8 is not worth stating');
  });
});
