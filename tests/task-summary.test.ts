import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

describe('TaskSummary', () => {
  it('module exports a default function', async () => {
    const mod = await import('../src/ui/task-summary.js');
    assert.equal(typeof mod.default, 'function');
  });

  it('local completion without retries', async () => {
    const { renderToString } = await import('./helpers/render.js');
    const output = await renderToString({ index: 1, title: 'auth middleware', method: 'local', retries: 0, duration: 12 });
    assert.ok(output.includes('\u2713 T1 auth middleware \u2014 local, 12s'), `expected local summary, got: ${output}`);
  });

  it('local completion with retries', async () => {
    const { renderToString } = await import('./helpers/render.js');
    const output = await renderToString({ index: 3, title: 'login endpoint', method: 'local', retries: 2, duration: 29 });
    assert.ok(output.includes('\u2713 T3 login endpoint \u2014 local, 2 retries, 29s'), `expected retries summary, got: ${output}`);
  });

  it('escalated completion', async () => {
    const { renderToString } = await import('./helpers/render.js');
    const output = await renderToString({ index: 2, title: 'JWT utils', method: 'escalated', retries: 0, duration: 8 });
    assert.ok(output.includes('\u2713 T2 JWT utils \u2014 escalated, 8s'), `expected escalated summary, got: ${output}`);
  });

  it('failed task', async () => {
    const { renderToString } = await import('./helpers/render.js');
    const output = await renderToString({ index: 4, title: 'register', method: 'failed' });
    assert.ok(output.includes('\u2717 T4 register \u2014 failed'), `expected failed summary, got: ${output}`);
  });

  it('skipped task with reason', async () => {
    const { renderToString } = await import('./helpers/render.js');
    const output = await renderToString({ index: 5, title: 'migration', method: 'skipped', reason: 'dependency failed' });
    assert.ok(output.includes('\u2298 T5 migration \u2014 skipped: dependency failed'), `expected skipped summary, got: ${output}`);
  });
});
