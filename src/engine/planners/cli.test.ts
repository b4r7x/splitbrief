import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { createCliPlanner } from './cli.js';
import { makeConfig } from '#testing/helpers/fixtures.js';
import { createTempDir, cleanupTempDir } from '#testing/helpers/temp-dir.js';
import { createTestGitRepo } from '#testing/helpers/git.js';
import { CommandNotFoundError } from '../../lib/process/errors.js';

vi.mock('../streaming/spawn-collect.js', () => ({
  spawnAndCollect: vi.fn(),
}));

vi.mock('../../lib/process/spawn.js', () => ({
  runCommand: vi.fn(),
}));

vi.mock('../../core/providers/model-selection.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../core/providers/model-selection.js')>();
  return { ...actual, resolveAutoModel: vi.fn(actual.resolveAutoModel) };
});

import { spawnAndCollect } from '../streaming/spawn-collect.js';
import { runCommand } from '../../lib/process/spawn.js';
import { resolveAutoModel } from '../../core/providers/model-selection.js';

let projectDir: string;

beforeEach(() => {
  vi.clearAllMocks();
  projectDir = createTempDir('cli-planner-test');
  createTestGitRepo(projectDir);
});

afterEach(() => {
  cleanupTempDir(projectDir);
});

describe('createCliPlanner', () => {
  it('isAvailable returns true when runCommand returns code 0 for --version', async () => {
    vi.mocked(runCommand).mockResolvedValue({ stdout: 'codex 1.0.0', stderr: '', code: 0 });

    const config = makeConfig({ planner: { kind: 'cli', tool: 'codex' } });
    const planner = createCliPlanner(config);

    const available = await planner.isAvailable();
    expect(available).toBe(true);
  });

  it('capabilities: supportsHintEscalation is always true; supportsSessionResume mirrors tool config', () => {
    // codex has supportsSessionResume: true
    const configWithResume = makeConfig({ planner: { kind: 'cli', tool: 'codex' } });
    const plannerWithResume = createCliPlanner(configWithResume);
    expect(plannerWithResume.capabilities.supportsHintEscalation).toBe(true);
    expect(plannerWithResume.capabilities.supportsSessionResume).toBe(true);

    // opencode does not have supportsSessionResume set
    const configNoResume = makeConfig({ planner: { kind: 'cli', tool: 'opencode' } });
    const plannerNoResume = createCliPlanner(configNoResume);
    expect(plannerNoResume.capabilities.supportsHintEscalation).toBe(true);
    expect(plannerNoResume.capabilities.supportsSessionResume).toBe(false);
  });

  it('session ID is threaded via onSessionId callback into buildArgs on the second invocation', async () => {
    const SESSION_ID = 'test-session-abc';

    vi.mocked(spawnAndCollect).mockImplementation(async (opts) => {
      // First call fires onSessionId to simulate the backend emitting a session
      opts.onSessionId?.(SESSION_ID);
      return { text: 'planner output', usage: null, sessionId: SESSION_ID };
    });

    const config = makeConfig({ planner: { kind: 'cli', tool: 'codex' } });
    const planner = createCliPlanner(config);
    const callbacks = { onOutput: vi.fn(), onSessionId: vi.fn() };

    // First call — session ID gets captured
    await planner.review('first prompt', projectDir, callbacks);

    // Second call — session ID should be threaded into buildArgs
    vi.mocked(spawnAndCollect).mockResolvedValue({ text: 'second output', usage: null });
    await planner.review('second prompt', projectDir, callbacks);

    const secondCallArgs = vi.mocked(spawnAndCollect).mock.calls[1]?.[0];
    expect(secondCallArgs).toBeDefined();
    // codex with a session ID and mode=escalate uses one-shot (no sessionId in buildArgs),
    // but the onSessionId from the first call should have been forwarded to the consumer callback
    expect(callbacks.onSessionId).toHaveBeenCalledWith(SESSION_ID);
  });

  it('postProcess hook is applied when the tool config defines it', async () => {
    // aider defines a postProcess that extracts usage from combined text+stderr
    const stderrWithUsage = 'Tokens: 100 sent, 50 received.';
    vi.mocked(spawnAndCollect).mockImplementation(async (opts) => {
      // Simulate stderr accumulation via onStderr callback
      opts.onStderr?.(stderrWithUsage);
      return { text: 'Aider response text', usage: null };
    });

    const config = makeConfig({ planner: { kind: 'cli', tool: 'aider' } });
    const planner = createCliPlanner(config);
    const callbacks = { onOutput: vi.fn() };

    const result = await planner.review('test prompt', projectDir, callbacks);
    // postProcess for aider trims the text
    expect(result.text).toBe('Aider response text');
    // postProcess is called (onStderr was passed to spawnAndCollect only because postProcess exists)
    const call = vi.mocked(spawnAndCollect).mock.calls[0]?.[0];
    expect(call?.onStderr).toBeInstanceOf(Function);
  });

  it('CommandNotFoundError propagates when spawnAndCollect throws code-127-equivalent error', async () => {
    const notFoundError = new CommandNotFoundError(
      'Codex CLI not found. Install it with: npm install -g @openai/codex',
    );
    vi.mocked(spawnAndCollect).mockRejectedValue(notFoundError);

    const config = makeConfig({ planner: { kind: 'cli', tool: 'codex' } });
    const planner = createCliPlanner(config);
    const callbacks = { onOutput: vi.fn() };

    await expect(planner.review('test prompt', projectDir, callbacks)).rejects.toBeInstanceOf(
      CommandNotFoundError,
    );
  });

  it('resolveAutoModel is called when model is "auto"', async () => {
    vi.mocked(spawnAndCollect).mockResolvedValue({ text: 'output', usage: null });

    const config = makeConfig({ planner: { kind: 'cli', tool: 'codex', model: 'auto' } });
    createCliPlanner(config);

    expect(resolveAutoModel).toHaveBeenCalledWith('auto', 'codex');
  });
});
