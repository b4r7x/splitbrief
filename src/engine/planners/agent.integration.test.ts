import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { createAgentPlanner } from './agent.js';
import { createTempDir, cleanupTempDir } from '#testing/helpers/temp-dir.js';
import { createTestGitRepo } from '#testing/helpers/git.js';
import { makeConfig } from '#testing/helpers/factories/config.js';
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
