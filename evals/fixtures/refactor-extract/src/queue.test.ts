import assert from 'node:assert/strict';
import test from 'node:test';
import { processQueue, type QueueItem } from './queue.js';

test('processQueue retries transient failures and preserves successful results', async () => {
  const attempts = new Map<string, number>();
  const items: Array<QueueItem<string>> = [
    { id: 'first', payload: 'alpha' },
    { id: 'second', payload: 'beta' },
  ];

  const result = await processQueue(
    items,
    async (item) => {
      const attempt = (attempts.get(item.id) ?? 0) + 1;
      attempts.set(item.id, attempt);

      if (item.id === 'first' && attempt < 3) {
        throw new Error('temporary failure');
      }

      return `${item.payload}:${attempt}`;
    },
    { maxRetries: 2, initialDelayMs: 0 },
  );

  assert.deepEqual(result.processed, ['alpha:3', 'beta:1']);
  assert.equal(result.failed.length, 0);
  assert.equal(attempts.get('first'), 3);
  assert.equal(attempts.get('second'), 1);
});

test('processQueue reports an item after all retry attempts fail', async () => {
  const item = { id: 'always-fails', payload: 'gamma' };
  let attempts = 0;

  const result = await processQueue(
    [item],
    async () => {
      attempts += 1;
      throw new Error('permanent failure');
    },
    { maxRetries: 1, initialDelayMs: 0 },
  );

  assert.deepEqual(result.processed, []);
  assert.equal(result.failed.length, 1);
  assert.equal(result.failed[0]?.item, item);
  assert.equal(result.failed[0]?.error.message, 'permanent failure');
  assert.equal(attempts, 2);
});
