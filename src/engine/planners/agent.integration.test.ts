import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { createAgentPlanner } from './agent.js';
import { createTempDir, cleanupTempDir } from '#testing/helpers/temp-dir.js';
import { createTestGitRepo } from '#testing/helpers/git.js';
import { makeConfig } from '#testing/helpers/factories/config.js';
import { makeTask } from '#testing/helpers/factories/task.js';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { RunnerCallEvent } from '../calls/types.js';

let projectDir: string;

beforeEach(() => {
  projectDir = createTempDir('agent-planner-test');
  createTestGitRepo(projectDir);
});

afterEach(() => {
  cleanupTempDir(projectDir);
});

const defaultAgentConfig = () =>
  makeConfig({
    planner: { kind: 'agent', command: 'sh', args: ['-c', 'cat >/dev/null; echo test output'] },
  });

describe('createAgentPlanner', () => {
  it('throws for wrong config kind', () => {
    const config = makeConfig({ planner: { kind: 'shell', command: 'echo' } });
    expect(() => createAgentPlanner(config)).toThrow('Expected agent planner config');
  });

  it('supports review', async () => {
    const config = defaultAgentConfig();
    const planner = createAgentPlanner(config);
    const callbacks = { onOutput: vi.fn() };

    const result = await planner.review('review prompt', projectDir, callbacks);
    expect(result.text).toContain('test output');
    expect(result.usage).toBe(null);
  });

  it('handles command not found error', async () => {
    const config = makeConfig({ planner: { kind: 'agent', command: 'nonexistent-command-12345' } });
    const planner = createAgentPlanner(config);
    const callbacks = { onOutput: vi.fn() };

    await expect(planner.review('test', projectDir, callbacks)).rejects.toThrow(
      'Agent planner command not found: nonexistent-command-12345',
    );
  });

  it('escalateFull ignores pre-existing dirty files and succeeds only on new writes', async () => {
    const preExistingFile = join(projectDir, 'pre-existing.ts');
    writeFileSync(preExistingFile, '// pre-existing');
    const task = makeTask();
    const callbacks = { onOutput: vi.fn() };

    const noChangePlanner = createAgentPlanner(
      makeConfig({
        planner: { kind: 'agent', command: 'sh', args: ['-c', 'cat >/dev/null; echo no changes'] },
      }),
    );

    const noChange = await noChangePlanner.escalateFull({
      task,
      error: 'error message',
      projectDir,
      callbacks,
    });
    expect(noChange.success).toBe(false);

    const newFile = join(projectDir, 'new-from-escalation.ts');
    const config = makeConfig({
      planner: {
        kind: 'agent',
        command: 'bash',
        args: ['-c', `cat >/dev/null; echo "// escalated" > ${newFile}`],
      },
    });
    const planner = createAgentPlanner(config);

    const result = await planner.escalateFull({
      task,
      error: 'error message',
      projectDir,
      callbacks,
    });
    expect(result.success).toBe(true);
    expect(result.code).toBe(null);
    expect(readFileSync(preExistingFile, 'utf-8')).toBe('// pre-existing');
    expect(readFileSync(newFile, 'utf-8')).toBe('// escalated\n');
  });

  it('threads a configured idleWarnMs override into the spawn', async () => {
    const config = makeConfig({
      planner: {
        kind: 'agent',
        command: 'bash',
        args: ['-c', 'cat >/dev/null; sleep 0.15'],
        idleWarnMs: 30,
      },
    });
    const planner = createAgentPlanner(config);
    const events: RunnerCallEvent[] = [];

    await planner.review('prompt', projectDir, {
      onOutput: vi.fn(),
      onCallEvent: (event) => events.push(event),
    });

    expect(events.some((event) => event.type === 'call_stalled')).toBe(true);
  });
});
