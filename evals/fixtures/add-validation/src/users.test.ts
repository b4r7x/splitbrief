import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { createUser, resetUsersForTest } from './users.js';

describe('createUser', () => {
  it('creates a user from valid input', () => {
    resetUsersForTest();

    const response = createUser({
      email: 'ada@example.com',
      name: 'Ada Lovelace',
      phone: '+15551234567',
    });

    assert.equal(response.status, 201);
    assert.deepEqual(response.body, {
      id: 'user_1',
      email: 'ada@example.com',
      name: 'Ada Lovelace',
      phone: '+15551234567',
    });
  });
});
