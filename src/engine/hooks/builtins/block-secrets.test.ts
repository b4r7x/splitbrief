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
    taskId: taskId('T1'),
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
    const outcome = await blockSecrets(makeEvent('missing.ts'), {
      projectDir: dir,
      sessionId: 's',
    });
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

  it('deny message names the offending file', async () => {
    const f = join(dir, 'c.ts');
    writeFileSync(f, '// AKIAIOSFODNN7EXAMPLE');
    const outcome = await blockSecrets(makeEvent('c.ts'), { projectDir: dir, sessionId: 's' });
    expect(outcome.kind).toBe('deny');
    if (outcome.kind === 'deny') {
      expect(outcome.message).toContain('secret detected');
      expect(outcome.message).toContain('c.ts');
    }
  });

  it('denies OpenAI sk- key (covered by shared detector)', async () => {
    const f = join(dir, 'd.ts');
    writeFileSync(f, 'const key = "sk-abcdefghijklmnopqrstuvwxyz0123456789ABCD";');
    const outcome = await blockSecrets(makeEvent('d.ts'), { projectDir: dir, sessionId: 's' });
    expect(outcome.kind).toBe('deny');
  });

  it('denies Anthropic sk-ant- key (covered by shared detector)', async () => {
    const f = join(dir, 'e.ts');
    writeFileSync(f, 'ANTHROPIC_API_KEY=sk-ant-api03-abcdefghijklmnopqrstuvwxyz0123');
    const outcome = await blockSecrets(makeEvent('e.ts'), { projectDir: dir, sessionId: 's' });
    expect(outcome.kind).toBe('deny');
  });

  it('denies a secret only the widened 17-rule set covers (xAI key)', async () => {
    const f = join(dir, 'f.ts');
    writeFileSync(f, 'const k = "xai-abcdefghijklmnopqrstuvwxyz0123456789";');
    const outcome = await blockSecrets(makeEvent('f.ts'), { projectDir: dir, sessionId: 's' });
    expect(outcome.kind).toBe('deny');
  });

  it('denies a Groq gsk_ key (widened coverage)', async () => {
    const f = join(dir, 'g.ts');
    writeFileSync(f, 'GROQ=gsk_abcdefghijklmnopqrstuvwxyz0123456789');
    const outcome = await blockSecrets(makeEvent('g.ts'), { projectDir: dir, sessionId: 's' });
    expect(outcome.kind).toBe('deny');
  });
});
