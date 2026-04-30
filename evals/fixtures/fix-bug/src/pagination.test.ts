import assert from 'node:assert/strict';
import test from 'node:test';
import { calculatePagination } from './pagination.js';

test('calculates pages for exact page boundaries', () => {
  const result = calculatePagination(100, 10, 10);

  assert.equal(result.totalPages, 10);
  assert.equal(result.currentPage, 10);
  assert.equal(result.hasNextPage, false);
  assert.equal(result.hasPreviousPage, true);
});
