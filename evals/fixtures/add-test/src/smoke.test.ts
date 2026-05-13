import assert from 'node:assert/strict';
import { test } from 'node:test';
import { validateEmail } from './email.js';

test('validateEmail accepts a valid address and rejects malformed input', () => {
  assert.equal(validateEmail('user@example.com'), true);
  assert.equal(validateEmail('not-an-email'), false);
});
