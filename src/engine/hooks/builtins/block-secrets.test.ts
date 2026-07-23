import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { blockSecrets } from './block-secrets.js';
import type { EngineEvent } from '../../events/types.js';
import { taskId } from '../../../core/schemas/task.js';

function makeEvent(file: string): EngineEvent {
  return {
    type: 'task_started',
    ts: 1,
    phase: 'implementing',
    taskId: taskId('T001'),
    title: 't',
    index: 0,
    total: 1,
    file,
    action: 'create',
  };
}

describe('blockSecrets', () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'block-secrets-'));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('denies when AWS access key is present and names the offending file', async () => {
    const f = join(dir, 'a.ts');
    writeFileSync(f, '// AKIAIOSFODNN7EXAMPLE');
    const outcome = await blockSecrets(makeEvent('a.ts'), { projectDir: dir, sessionId: 's' });
    expect(outcome.kind).toBe('deny');
    if (outcome.kind === 'deny') {
      expect(outcome.message).toContain('secret detected');
      expect(outcome.message).toContain('a.ts');
    }
  });

  it('allows when no secret pattern is present', async () => {
    const f = join(dir, 'a.ts');
    writeFileSync(f, 'export const x = 1;');
    const outcome = await blockSecrets(makeEvent('a.ts'), { projectDir: dir, sessionId: 's' });
    expect(outcome.kind).toBe('allow');
  });

  it('warns (does not fail open) when a listed file cannot be scanned', async () => {
    const outcome = await blockSecrets(makeEvent('missing.ts'), {
      projectDir: dir,
      sessionId: 's',
    });
    expect(outcome.kind).toBe('warn');
    if (outcome.kind === 'warn') {
      expect(outcome.message).toContain('could not scan');
      expect(outcome.message).toContain('missing.ts');
    }
  });

  it('denies a secret in a readable file even when another listed file is unscannable', async () => {
    const secret = join(dir, 'secret.env');
    writeFileSync(secret, 'API_KEY=sk-abcdefghijklmnopqrstuvwxyz0123456789ABCD');
    const outcome = await blockSecrets(makeEvent('task.ts'), {
      projectDir: dir,
      sessionId: 's',
      files: ['missing.ts', 'secret.env'],
    });
    expect(outcome.kind).toBe('deny');
  });

  it('allows when event has no file field', async () => {
    const event: EngineEvent = { type: 'workflow_complete', ts: 1, phase: 'idle' };
    const outcome = await blockSecrets(event, { projectDir: dir, sessionId: 's' });
    expect(outcome.kind).toBe('allow');
  });

  it('denies when a secret is present in ctx.files but not event.file', async () => {
    const clean = join(dir, 'task.ts');
    const secret = join(dir, 'secret.env');
    writeFileSync(clean, 'export const ok = true;');
    writeFileSync(secret, 'API_KEY=sk-abcdefghijklmnopqrstuvwxyz0123456789ABCD');
    const outcome = await blockSecrets(makeEvent('task.ts'), {
      projectDir: dir,
      sessionId: 's',
      files: ['task.ts', 'secret.env'],
    });
    expect(outcome.kind).toBe('deny');
  });
});
