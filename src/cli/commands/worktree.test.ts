import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { join } from 'node:path';
import { Command } from 'commander';
import { createTempDir, cleanupTempDir } from '#testing/helpers/temp-dir.js';
import { isCliError } from '../errors.js';
import { registerWorktreeCommand } from './worktree.js';
import type { WorktreeDeps } from './worktree.js';
import type { WorktreeInfo } from '../../engine/worktree/status.js';

let tmp: string;
let consoleSpy: ReturnType<typeof vi.spyOn>;

const mockListWorktrees = vi.fn<() => Promise<WorktreeInfo[]>>().mockResolvedValue([]);
const mockRemoveWorktree = vi.fn<() => Promise<void>>().mockResolvedValue(undefined);

const fakeDeps: WorktreeDeps = {
  listWorktrees: mockListWorktrees as unknown as WorktreeDeps['listWorktrees'],
  removeWorktree: mockRemoveWorktree as unknown as WorktreeDeps['removeWorktree'],
};

const makeWorktree = (overrides: Partial<WorktreeInfo> = {}): WorktreeInfo => ({
  name: 'my-feature',
  path: '/project/.trees/my-feature',
  branch: 'splitbrief/my-feature',
  status: 'none',
  sessionId: null,
  phase: null,
  lastUpdated: null,
  ...overrides,
});

beforeEach(() => {
  tmp = createTempDir('worktree-command-test');
  Object.defineProperty(process.stdout, 'columns', { value: 200, configurable: true });
  consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
  mockListWorktrees.mockReset().mockResolvedValue([]);
  mockRemoveWorktree.mockReset().mockResolvedValue(undefined);
});

afterEach(() => {
  if (tmp) cleanupTempDir(tmp);
  vi.restoreAllMocks();
});

function captureOutput(): string {
  return consoleSpy.mock.calls.map((c: unknown[]) => c.join(' ')).join('\n');
}

async function runWorktree(args: string[]): Promise<void> {
  const program = new Command();
  program.exitOverride();
  program.configureOutput({ writeErr: () => {}, writeOut: () => {} });
  registerWorktreeCommand(program, fakeDeps);
  await program.parseAsync(['node', 'splitbrief', 'worktree', ...args, '--project', tmp]);
}

describe('worktree list — empty', () => {
  it('prints "no worktrees" message when listWorktrees returns []', async () => {
    mockListWorktrees.mockResolvedValue([]);
    await runWorktree(['list']);
    expect(captureOutput()).toContain('No SPLITBRIEF worktrees found.');
  });
});

describe('worktree list — with entries', () => {
  it('prints headers, rows, and session metadata for WorktreeInfo entries', async () => {
    mockListWorktrees.mockResolvedValue([
      makeWorktree({
        name: 'my-feature',
        branch: 'splitbrief/my-feature',
        status: 'none',
        sessionId: null,
      }),
      makeWorktree({
        name: 'quick-fix',
        branch: 'splitbrief/quick-fix',
        status: 'none',
        sessionId: null,
      }),
      makeWorktree({
        name: 'active-wt',
        branch: 'splitbrief/active-wt',
        status: 'active',
        sessionId: 'dip-abc123',
        phase: 'implementing',
        lastUpdated: '2026-04-27T10:00:00.000Z',
      }),
      makeWorktree({
        name: 'idle-wt',
        branch: 'splitbrief/idle-wt',
        status: 'idle',
        sessionId: 'dip-def456',
      }),
    ]);

    await runWorktree(['list']);

    const out = captureOutput();
    for (const text of [
      'NAME',
      'PATH',
      'BRANCH',
      'STATUS',
      'SESSION',
      'PHASE',
      'UPDATED',
      'my-feature',
      'quick-fix',
      '/project/.trees/my-feature',
      'splitbrief/my-feature',
      'splitbrief/quick-fix',
      'active',
      'dip-abc123',
      'implementing',
      '2026-04-27T10:00:00.000Z',
      'idle',
      'dip-def456',
      'unknown',
    ]) {
      expect(out).toContain(text);
    }
  });
});

describe('worktree switch', () => {
  it('prints cd hint when worktree exists', async () => {
    mockListWorktrees.mockResolvedValue([makeWorktree({ name: 'my-feature' })]);

    await runWorktree(['switch', 'my-feature']);

    const out = captureOutput();
    expect(out).toContain('To switch to worktree "my-feature"');
    expect(out).toContain('cd .trees/my-feature');
    expect(out).toContain('splitbrief-switch()');
  });
});

describe('worktree path', () => {
  it('prints the resolved .trees/<name> path when worktree exists', async () => {
    mockListWorktrees.mockResolvedValue([makeWorktree({ name: 'my-feature' })]);

    await runWorktree(['path', 'my-feature']);

    expect(captureOutput()).toContain(join(tmp, '.trees', 'my-feature'));
  });
});

describe('worktree missing target', () => {
  it.each(['switch', 'path'])('exits 1 when %s targets a missing worktree', async (command) => {
    mockListWorktrees.mockResolvedValue([]);

    let captured: unknown;
    try {
      await runWorktree([command, 'missing-wt']);
    } catch (err) {
      captured = err;
    }

    expect(isCliError(captured)).toBe(true);
    expect((captured as Error).message).toContain('missing-wt');
  });

  it('exits 1 when remove targets a genuinely missing worktree', async () => {
    mockListWorktrees.mockResolvedValue([]);

    let captured: unknown;
    try {
      await runWorktree(['remove', 'missing-wt']);
    } catch (err) {
      captured = err;
    }

    expect(isCliError(captured)).toBe(true);
    expect((captured as Error).message).toContain('missing-wt');
  });
});

describe('worktree remove', () => {
  it('`worktree remove` with an unmanaged name exits 1 with `Worktree "<name>" not found.` and deletes no branch', async () => {
    mockListWorktrees.mockResolvedValue([makeWorktree({ name: 'my-feature' })]);

    let captured: unknown;
    try {
      await runWorktree(['remove', 'dip-abc123', '--delete-branch']);
    } catch (err) {
      captured = err;
    }

    expect(isCliError(captured)).toBe(true);
    expect((captured as { exitCode?: number }).exitCode).toBe(1);
    expect((captured as Error).message).toBe('Worktree "dip-abc123" not found.');
    expect(mockRemoveWorktree).not.toHaveBeenCalled();
    expect(captureOutput()).not.toContain('Removed worktree');
  });

  it('propagates cliError when removeWorktree rejects', async () => {
    mockListWorktrees.mockResolvedValue([makeWorktree({ name: 'my-feature' })]);
    mockRemoveWorktree.mockRejectedValue(
      new Error('Worktree ".trees/my-feature" has a live session. Stop it first.'),
    );

    let captured: unknown;
    try {
      await runWorktree(['remove', 'my-feature']);
    } catch (err) {
      captured = err;
    }

    expect(isCliError(captured)).toBe(true);
    expect((captured as Error).message).toContain('live session');
  });
});
