import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { PlannerTool } from '../../types.js';

vi.mock('../../utils/process.js', () => ({
  runCommand: vi.fn(),
}));

import { runCommand } from '../../utils/process.js';
import { supportsConversational, createGetVersion, createIsAvailable } from './base.js';

describe('supportsConversational', () => {
  it('returns true for claude-code', () => {
    expect(supportsConversational('claude-code')).toBe(true);
  });

  it('returns true for agent-sdk', () => {
    expect(supportsConversational('agent-sdk')).toBe(true);
  });

  it('returns false for codex', () => {
    expect(supportsConversational('codex' as PlannerTool)).toBe(false);
  });

  it('returns false for aider', () => {
    expect(supportsConversational('aider' as PlannerTool)).toBe(false);
  });

  it('returns false for shell', () => {
    expect(supportsConversational('shell' as PlannerTool)).toBe(false);
  });
});

describe('createGetVersion', () => {
  beforeEach(() => vi.clearAllMocks());

  it('parses a semver version from stdout', async () => {
    vi.mocked(runCommand).mockResolvedValue({ stdout: 'claude-code v1.2.3', stderr: '', code: 0 });

    const getVersion = createGetVersion('claude');
    const version = await getVersion();

    expect(version).toBe('1.2.3');
    expect(runCommand).toHaveBeenCalledWith('claude', ['--version']);
  });

  it('uses custom version args when provided', async () => {
    vi.mocked(runCommand).mockResolvedValue({ stdout: 'v3.0.1', stderr: '', code: 0 });

    const getVersion = createGetVersion('mytool', ['-v']);
    await getVersion();

    expect(runCommand).toHaveBeenCalledWith('mytool', ['-v']);
  });

  it('returns null when command exits non-zero', async () => {
    vi.mocked(runCommand).mockResolvedValue({ stdout: '', stderr: 'not found', code: 1 });

    const getVersion = createGetVersion('missing-tool');
    expect(await getVersion()).toBeNull();
  });

  it('returns null when stdout has no version', async () => {
    vi.mocked(runCommand).mockResolvedValue({ stdout: 'no version here', stderr: '', code: 0 });

    const getVersion = createGetVersion('tool');
    expect(await getVersion()).toBeNull();
  });

  it('returns null when command throws', async () => {
    vi.mocked(runCommand).mockRejectedValue(new Error('ENOENT'));

    const getVersion = createGetVersion('nonexistent');
    expect(await getVersion()).toBeNull();
  });
});

describe('createIsAvailable', () => {
  beforeEach(() => vi.clearAllMocks());

  it('returns true when command exits with code 0', async () => {
    vi.mocked(runCommand).mockResolvedValue({ stdout: 'v1.0.0', stderr: '', code: 0 });

    const isAvailable = createIsAvailable('claude');
    expect(await isAvailable()).toBe(true);
  });

  it('returns false when command exits non-zero', async () => {
    vi.mocked(runCommand).mockResolvedValue({ stdout: '', stderr: '', code: 127 });

    const isAvailable = createIsAvailable('missing');
    expect(await isAvailable()).toBe(false);
  });

  it('returns false when command throws', async () => {
    vi.mocked(runCommand).mockRejectedValue(new Error('ENOENT'));

    const isAvailable = createIsAvailable('nonexistent');
    expect(await isAvailable()).toBe(false);
  });

  it('passes timeout option to runCommand', async () => {
    vi.mocked(runCommand).mockResolvedValue({ stdout: '', stderr: '', code: 0 });

    const isAvailable = createIsAvailable('tool', { timeout: 5000 });
    await isAvailable();

    expect(runCommand).toHaveBeenCalledWith('tool', ['--version'], { timeout: 5000 });
  });
});
