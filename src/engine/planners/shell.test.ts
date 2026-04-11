import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { createShellPlanner } from './shell.js';
import { createTempDir, cleanupTempDir } from '#testing/helpers/temp-dir.js';
import { createTestGitRepo } from '#testing/helpers/git.js';
import { makeConfig, makeTask } from '#testing/helpers/fixtures.js';
import { join } from 'node:path';

let projectDir: string;

beforeEach(() => {
  projectDir = createTempDir('shell-planner-test');
  createTestGitRepo(projectDir);
});

afterEach(() => {
  cleanupTempDir(projectDir);
});

describe('createShellPlanner', () => {
  it('throws for wrong config kind', () => {
    const config = makeConfig({ planner: { kind: 'agent', command: 'echo' } });
    expect(() => createShellPlanner(config)).toThrow("createShellPlanner requires planner.kind = 'shell'");
  });

  it('creates planner with availability methods', () => {
    const config = makeConfig({ planner: { kind: 'shell', command: 'echo', args: ['test output'] } });
    const planner = createShellPlanner(config);
    expect(planner.isAvailable).toBeInstanceOf(Function);
    expect(planner.getVersion).toBeInstanceOf(Function);
  });

  it('escalateHint — success when shell command writes files', async () => {
    const outFile = join(projectDir, 'hint-out.ts');
    const config = makeConfig({ planner: { kind: 'shell', command: 'bash', args: ['-c', `echo "// hint" > ${outFile}`] } });
    const planner = createShellPlanner(config);
    const task = makeTask();
    const callbacks = { onOutput: vi.fn() };

    const result = await planner.escalateHint(task, 'error message', projectDir, callbacks);
    expect(result.success).toBe(true);
    expect(result.code).toBe(null);
  });

  it('escalateHint — failure when shell command only echoes (no files written)', async () => {
    const config = makeConfig({ planner: { kind: 'shell', command: 'echo', args: ['some output'] } });
    const planner = createShellPlanner(config);
    const task = makeTask();
    const callbacks = { onOutput: vi.fn() };

    const result = await planner.escalateHint(task, 'error message', projectDir, callbacks);
    expect(result.success).toBe(false);
    expect(result.code).toBe(null);
  });
});
