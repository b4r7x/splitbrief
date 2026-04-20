import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { blockSecrets } from './block-secrets.js';
import type { EngineEvent } from '../../events/types.js';

function makeEvent(file: string): EngineEvent {
  return {
    type: 'task_started',
    ts: 1,
    phase: 'implementing',
    taskId: 'T1' as never,
    title: 't',
    index: 0,
    total: 1,
    file,
    action: 'create',
  };
}

describe('blockSecrets', () => {
  let dir: string;
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'block-secrets-')); });
  afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

  it('denies when AWS access key is present', async () => {
    const f = join(dir, 'a.ts');
    writeFileSync(f, '// AKIAIOSFODNN7EXAMPLE');
    const outcome = await blockSecrets(makeEvent('a.ts'), { projectDir: dir, sessionId: 's' });
    expect(outcome.kind).toBe('deny');
  });

  it('allows when no secret pattern is present', async () => {
    const f = join(dir, 'a.ts');
    writeFileSync(f, 'export const x = 1;');
    const outcome = await blockSecrets(makeEvent('a.ts'), { projectDir: dir, sessionId: 's' });
    expect(outcome.kind).toBe('allow');
  });

  it('allows when file does not exist', async () => {
    const outcome = await blockSecrets(makeEvent('missing.ts'), { projectDir: dir, sessionId: 's' });
    expect(outcome.kind).toBe('allow');
  });

  it('allows when event has no file field', async () => {
    const event: EngineEvent = { type: 'workflow_complete', ts: 1, phase: 'idle' };
    const outcome = await blockSecrets(event, { projectDir: dir, sessionId: 's' });
    expect(outcome.kind).toBe('allow');
  });

  it('denies when GitHub PAT is present', async () => {
    const f = join(dir, 'b.ts');
    writeFileSync(f, 'const token = "ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghij";');
    const outcome = await blockSecrets(makeEvent('b.ts'), { projectDir: dir, sessionId: 's' });
    expect(outcome.kind).toBe('deny');
  });

  it('deny message includes pattern name and file path', async () => {
    const f = join(dir, 'c.ts');
    writeFileSync(f, '// AKIAIOSFODNN7EXAMPLE');
    const outcome = await blockSecrets(makeEvent('c.ts'), { projectDir: dir, sessionId: 's' });
    expect(outcome.kind).toBe('deny');
    if (outcome.kind === 'deny') {
      expect(outcome.message).toContain('AWS access key');
      expect(outcome.message).toContain('c.ts');
    }
  });
});
