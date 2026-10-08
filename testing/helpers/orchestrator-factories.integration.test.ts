import { describe, it, expect } from 'vitest';
import { makeWctx } from './orchestrator-factories.js';
import { defaultContext } from './factories/config.js';

describe('makeWctx', () => {
  it('derives default context.dir from projectDir', () => {
    const wctx = makeWctx({ projectDir: '/tmp/proj-xyz', sessionId: 's1' });
    expect(wctx.context.dir).toBe('/tmp/proj-xyz');
    expect(wctx.projectDir).toBe('/tmp/proj-xyz');
  });

  it('lets an explicit context override win over the projectDir-derived default', () => {
    const explicit = { ...defaultContext, dir: '/tmp/explicit-dir', name: 'explicit' };
    const wctx = makeWctx({ projectDir: '/tmp/proj-xyz', sessionId: 's1', context: explicit });
    expect(wctx.context).toEqual(explicit);
  });
});
