import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { runPreHooks } from '../../../src/engine/hooks/run-pre-hook.js';
import { makeTaskStart } from '#testing/helpers/events.js';
import { taskId } from '../../../src/core/schemas/task.js';
import type { EngineEvent } from '../../../src/engine/events/types.js';
import type { HooksConfig } from '../../../src/core/schemas/hooks.js';

const ctx = (dir: string) => ({ projectDir: dir, sessionId: 'test-session' });

describe('hooks-builtins integration', () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'hooks-builtins-int-'));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  describe('block-secrets via runPreHooks — production path (git_commit event)', () => {
    it('denies when git_commit event has file field containing AWS key (production path via task/commit.ts)', async () => {
      const f = join(dir, 'infra.ts');
      writeFileSync(f, 'const key = "AKIAIOSFODNN7EXAMPLE"; // planted secret');

      const hooks: HooksConfig = { builtin: { 'block-secrets': true } };
      const commitMsg = 'feat(diptych): T1 - add infra';
      const event: EngineEvent = {
        type: 'git_commit',
        ts: Date.now(),
        phase: 'implementing',
        taskId: taskId('T1'),
        message: commitMsg,
        file: 'infra.ts',
      };

      const result = await runPreHooks(hooks, 'pre_commit', event, ctx(dir));
      expect(result.allow).toBe(false);
      expect(result.reason).toContain('secret detected');
      expect(result.reason).toContain('infra.ts');
    });

    it('allows when git_commit event has file field with clean file (production path)', async () => {
      const f = join(dir, 'clean.ts');
      writeFileSync(f, 'export const x = 42;');

      const hooks: HooksConfig = { builtin: { 'block-secrets': true } };
      const event: EngineEvent = {
        type: 'git_commit',
        ts: Date.now(),
        phase: 'implementing',
        taskId: taskId('T1'),
        message: 'feat(diptych): T1 - clean task',
        file: 'clean.ts',
      };

      const result = await runPreHooks(hooks, 'pre_commit', event, ctx(dir));
      expect(result.allow).toBe(true);
    });

    it('allows when git_commit event has no file field', async () => {
      const f = join(dir, 'secret-no-file.ts');
      writeFileSync(f, 'const key = "AKIAIOSFODNN7EXAMPLE";');

      const hooks: HooksConfig = { builtin: { 'block-secrets': true } };
      const event: EngineEvent = {
        type: 'git_commit',
        ts: Date.now(),
        phase: 'implementing',
        taskId: taskId('T1'),
        message: 'feat(diptych): T1 - oops',
      };

      const result = await runPreHooks(hooks, 'pre_commit', event, ctx(dir));
      expect(result.allow).toBe(true);
    });
  });

  describe('block-secrets via runPreHooks', () => {
    it('block-secrets deny runs before user-declared hook entries', async () => {
      const f = join(dir, 'oops.ts');
      writeFileSync(f, 'const k = "AKIAIOSFODNN7EXAMPLE";');

      const hooks: HooksConfig = {
        builtin: { 'block-secrets': true },
        pre_commit: [
          {
            kind: 'command',
            command: 'echo',
            args: ['user-hook'],
            timeout_ms: 5000,
            on_failure: 'warn',
          },
        ],
      };
      const event = makeTaskStart({
        taskId: taskId('T1'),
        title: 'plant file',
        index: 0,
        total: 1,
        file: 'oops.ts',
        action: 'create',
      });
      const result = await runPreHooks(hooks, 'pre_commit', event, ctx(dir));
      expect(result.allow).toBe(false);
      expect(result.reason).toContain('secret detected');
      expect(result.reason).toContain('oops.ts');
    });
  });
});
