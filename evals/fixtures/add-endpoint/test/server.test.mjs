import assert from 'node:assert/strict';
import test from 'node:test';
import { handleRequest } from '../src/server.ts';

test('GET /api/version returns the fixture version payload', () => {
  const response = handleRequest('GET', '/api/version');
  assert.equal(response.statusCode, 200);
  assert.deepEqual(response.body, { version: '1.0.0' });
});

test('unknown paths return 404', () => {
  const response = handleRequest('GET', '/api/unknown');
  assert.equal(response.statusCode, 404);
  assert.deepEqual(response.body, { error: 'Not found' });
});
