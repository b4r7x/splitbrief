import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Config } from '../../types.js';

vi.mock('./spawn.js', () => ({
  spawnAndCollect: vi.fn(),
}));

vi.mock('../output-parsers.js', () => ({
  getLineParser: vi.fn().mockImplementation((format: string) => {
    if (format === 'text') return (line: string) => ({ text: line + '\n' });
    if (format === 'stream-json') return (line: string) => ({ text: line });
    return (line: string) => ({ text: line + '\n' });
  }),
}));

vi.mock('./base.js', async (importOriginal) => {
  const orig = await importOriginal<typeof import('./base.js')>();
  return {
    ...orig,
    createPlannerBase: vi.fn().mockImplementation((config) => ({
      name: config.name,
      conversational: config.conversational ?? false,
      plan: vi.fn(),
      regenerate: vi.fn(),
      escalateHint: vi.fn(),
      escalateFull: vi.fn(),
      isAvailable: config.isAvailable,
      getVersion: config.getVersion,
      getPricing: vi.fn(),
      _config: config,
    })),
    createIsAvailable: vi.fn().mockReturnValue(vi.fn().mockResolvedValue(false)),
  };
});

import { createShellPlanner } from './shell.js';
import { spawnAndCollect } from './spawn.js';
import { createPlannerBase } from './base.js';

const mockSpawnAndCollect = vi.mocked(spawnAndCollect);

function makeShellConfig(overrides?: Partial<Config['planner']>): Config {
  return {
    planner: { tool: 'shell', command: 'my-tool', args: ['--flag'], outputFormat: 'text', ...overrides },
    implementer: { provider: 'ollama', model: 'x', apiBase: '', contextLength: 8192, temperature: 0.2 },
    validation: { typecheck: true, lint: true, test: true, testCommand: 'npm test' },
    workflow: { autoApproveSpec: false, autoApprovePlan: false, maxRetries: 3, commitPerTask: true },
  };
}

describe('shell planner', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('creates a planner with correct interface', () => {
    const planner = createShellPlanner(makeShellConfig());
    expect(planner).toHaveProperty('plan');
    expect(planner).toHaveProperty('escalateHint');
    expect(planner).toHaveProperty('escalateFull');
    expect(planner).toHaveProperty('getVersion');
    expect(planner).toHaveProperty('isAvailable');
  });

  it('has name shell:<command>', () => {
    const planner = createShellPlanner(makeShellConfig());
    expect(planner.name).toBe('shell:my-tool');
  });

  it('is not conversational', () => {
    const planner = createShellPlanner(makeShellConfig());
    expect(planner.conversational).toBe(false);
  });

  it('invokePlan uses configured command and args', async () => {
    mockSpawnAndCollect.mockResolvedValue({ text: 'output', usage: null });

    createShellPlanner(makeShellConfig());
    const baseConfig = vi.mocked(createPlannerBase).mock.calls[0][0];
    await baseConfig.invokePlan('prompt', '/project', () => {});

    expect(mockSpawnAndCollect).toHaveBeenCalledOnce();
    const callArgs = mockSpawnAndCollect.mock.calls[0][0];
    expect(callArgs.command).toBe('my-tool');
    expect(callArgs.args).toEqual(['--flag']);
    expect(callArgs.stdin).toBe('prompt');
  });

  it('invokeEscalate uses the same command', async () => {
    mockSpawnAndCollect.mockResolvedValue({ text: 'output', usage: null });

    createShellPlanner(makeShellConfig());
    const baseConfig = vi.mocked(createPlannerBase).mock.calls[0][0];
    await baseConfig.invokeEscalate('escalate prompt', '/project', () => {});

    const callArgs = mockSpawnAndCollect.mock.calls[0][0];
    expect(callArgs.command).toBe('my-tool');
    expect(callArgs.stdin).toBe('escalate prompt');
  });

  it('uses text format by default', async () => {
    mockSpawnAndCollect.mockResolvedValue({ text: 'output', usage: null });

    createShellPlanner(makeShellConfig({ outputFormat: undefined }));
    const baseConfig = vi.mocked(createPlannerBase).mock.calls[0][0];
    await baseConfig.invokePlan('prompt', '/project', () => {});

    const callArgs = mockSpawnAndCollect.mock.calls[0][0];
    expect(typeof callArgs.parseLine).toBe('function');
  });

  it('getVersion returns null', async () => {
    const planner = createShellPlanner(makeShellConfig());
    const version = await planner.getVersion();
    expect(version).toBeNull();
  });

  it('notFoundMessage includes command name', async () => {
    mockSpawnAndCollect.mockResolvedValue({ text: 'output', usage: null });

    createShellPlanner(makeShellConfig({ command: 'custom-cmd' }));
    const baseConfig = vi.mocked(createPlannerBase).mock.calls[0][0];
    await baseConfig.invokePlan('prompt', '/project', () => {});

    const callArgs = mockSpawnAndCollect.mock.calls[0][0];
    expect(callArgs.notFoundMessage).toContain('custom-cmd');
  });
});
