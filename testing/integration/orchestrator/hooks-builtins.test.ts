import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { activeBuiltinsFor, BUILTIN_HOOKS } from '../../../src/engine/hooks/builtins/registry.js';
import { runPreHooks } from '../../../src/engine/hooks/run-pre-hook.js';
import type { EngineEvent } from '../../../src/engine/events/types.js';
import type { HooksConfig } from '../../../src/core/schemas/hooks.js';

const ctx = (dir: string) => ({ projectDir: dir, sessionId: 'test-session' });

function makeTaskStartedEvent(file: string): EngineEvent {
  return {
    type: 'task_started',
    ts: Date.now(),
    phase: 'implementing',
    taskId: 'T1' as never,
    title: 'plant file',
    index: 0,
    total: 1,
    file,
    action: 'create',
  };
}

describe('hooks-builtins integration', () => {
  let dir: string;
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'hooks-builtins-int-')); });
  afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

  describe('registry', () => {
    it('BUILTIN_HOOKS has exactly two entries', () => {
      expect(BUILTIN_HOOKS).toHaveLength(2);
      expect(BUILTIN_HOOKS.map((b) => b.name)).toEqual(['prettier-on-change', 'block-secrets']);
    });

    it('prettier-on-change targets post_task', () => {
      const b = BUILTIN_HOOKS.find((b) => b.name === 'prettier-on-change');
      expect(b?.event).toBe('post_task');
      expect(b?.enabledByDefault).toBe(false);
    });

    it('block-secrets targets pre_commit', () => {
      const b = BUILTIN_HOOKS.find((b) => b.name === 'block-secrets');
      expect(b?.event).toBe('pre_commit');
      expect(b?.enabledByDefault).toBe(false);
    });
  });

  describe('activeBuiltinsFor resolution', () => {
    it('returns empty when hooks config is undefined and both are off-by-default', () => {
      expect(activeBuiltinsFor('post_task', undefined)).toHaveLength(0);
      expect(activeBuiltinsFor('pre_commit', undefined)).toHaveLength(0);
    });

    it('returns empty when builtin is not explicitly enabled', () => {
      const hooks: HooksConfig = {};
      expect(activeBuiltinsFor('pre_commit', hooks)).toHaveLength(0);
    });

    it('returns the builtin when explicitly enabled via builtin config', () => {
      const hooks: HooksConfig = { builtin: { 'block-secrets': true } };
      const active = activeBuiltinsFor('pre_commit', hooks);
      expect(active).toHaveLength(1);
      expect(active[0]?.name).toBe('block-secrets');
    });

    it('suppresses a builtin when explicitly disabled', () => {
      const hooks: HooksConfig = { builtin: { 'block-secrets': false } };
      expect(activeBuiltinsFor('pre_commit', hooks)).toHaveLength(0);
    });

    it('does not cross-contaminate events', () => {
      const hooks: HooksConfig = { builtin: { 'block-secrets': true, 'prettier-on-change': true } };
      expect(activeBuiltinsFor('pre_commit', hooks).map((b) => b.name)).toEqual(['block-secrets']);
      expect(activeBuiltinsFor('post_task', hooks).map((b) => b.name)).toEqual(['prettier-on-change']);
    });
  });

  describe('block-secrets via runPreHooks — production path (git_commit event)', () => {
    it('denies when git_commit event has file field containing AWS key (production path via task-commit.ts)', async () => {
      const f = join(dir, 'infra.ts');
      writeFileSync(f, 'const key = "AKIAIOSFODNN7EXAMPLE"; // planted secret');

      const hooks: HooksConfig = { builtin: { 'block-secrets': true } };
      const commitMsg = 'feat(diptych): T1 - add infra';
      // This is the exact shape task-commit.ts constructs for the pre_commit hook payload
      const event: EngineEvent = {
        type: 'git_commit',
        ts: Date.now(),
        phase: 'implementing',
        taskId: 'T1' as never,
        message: commitMsg,
        file: 'infra.ts',
      };

      const result = await runPreHooks(hooks, 'pre_commit', event, ctx(dir));
      expect(result.allow).toBe(false);
      expect(result.reason).toContain('AWS access key');
    });

    it('allows when git_commit event has file field with clean file (production path)', async () => {
      const f = join(dir, 'clean.ts');
      writeFileSync(f, 'export const x = 42;');

      const hooks: HooksConfig = { builtin: { 'block-secrets': true } };
      const event: EngineEvent = {
        type: 'git_commit',
        ts: Date.now(),
        phase: 'implementing',
        taskId: 'T1' as never,
        message: 'feat(diptych): T1 - clean task',
        file: 'clean.ts',
      };

      const result = await runPreHooks(hooks, 'pre_commit', event, ctx(dir));
      expect(result.allow).toBe(true);
    });

    it('allows silently (bug path) when git_commit event has NO file field — demonstrates pre-fix behaviour', async () => {
      const f = join(dir, 'secret-no-file.ts');
      writeFileSync(f, 'const key = "AKIAIOSFODNN7EXAMPLE";');

      const hooks: HooksConfig = { builtin: { 'block-secrets': true } };
      // Deliberately omit `file` — this was the pre-fix shape
      const event: EngineEvent = {
        type: 'git_commit',
        ts: Date.now(),
        phase: 'implementing',
        taskId: 'T1' as never,
        message: 'feat(diptych): T1 - oops',
        // no file field
      };

      // blockSecrets returns allow when file is absent — intentional design (no path = no scan)
      // This test documents that behaviour so regressions are caught explicitly
      const result = await runPreHooks(hooks, 'pre_commit', event, ctx(dir));
      expect(result.allow).toBe(true); // allow because file is absent — hook cannot scan unknown path
    });
  });

  describe('block-secrets via runPreHooks', () => {
    it('denies when file contains AWS access key and block-secrets is enabled', async () => {
      const f = join(dir, 'secrets.ts');
      writeFileSync(f, 'const key = "AKIAIOSFODNN7EXAMPLE"; // oops');

      const hooks: HooksConfig = { builtin: { 'block-secrets': true } };
      const event = makeTaskStartedEvent('secrets.ts');

      const result = await runPreHooks(hooks, 'pre_commit', event, ctx(dir));
      expect(result.allow).toBe(false);
      expect(result.reason).toContain('AWS access key');
    });

    it('allows when file has no secrets and block-secrets is enabled', async () => {
      const f = join(dir, 'clean.ts');
      writeFileSync(f, 'export const greeting = "hello world";');

      const hooks: HooksConfig = { builtin: { 'block-secrets': true } };
      const event = makeTaskStartedEvent('clean.ts');

      const result = await runPreHooks(hooks, 'pre_commit', event, ctx(dir));
      expect(result.allow).toBe(true);
    });

    it('allows when block-secrets is disabled (default)', async () => {
      const f = join(dir, 'secrets.ts');
      writeFileSync(f, 'const key = "AKIAIOSFODNN7EXAMPLE";');

      const hooks: HooksConfig = {};
      const event = makeTaskStartedEvent('secrets.ts');

      const result = await runPreHooks(hooks, 'pre_commit', event, ctx(dir));
      expect(result.allow).toBe(true);
    });

    it('block-secrets deny runs before user-declared hook entries', async () => {
      const f = join(dir, 'oops.ts');
      writeFileSync(f, 'const k = "AKIAIOSFODNN7EXAMPLE";');

      const hooks: HooksConfig = {
        builtin: { 'block-secrets': true },
        pre_commit: [{
          kind: 'command',
          command: 'echo',
          args: ['user-hook'],
          timeout_ms: 5000,
          on_failure: 'warn',
        }],
      };
      const event = makeTaskStartedEvent('oops.ts');
      const result = await runPreHooks(hooks, 'pre_commit', event, ctx(dir));
      expect(result.allow).toBe(false);
      expect(result.reason).toContain('AWS access key');
    });
  });
});
