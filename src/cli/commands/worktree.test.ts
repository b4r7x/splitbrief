import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Command } from 'commander';
import { createTempDir, cleanupTempDir } from '#testing/helpers/temp-dir.js';
import { isCliError } from '../errors.js';

vi.mock('../../engine/worktree.js', () => ({
  listWorktrees: vi.fn(),
  removeWorktree: vi.fn(),
}));

import { registerWorktreeCommand } from './worktree.js';
import { listWorktrees, removeWorktree } from '../../engine/worktree.js';
import type { WorktreeInfo } from '../../engine/worktree.js';

let tmp: string;
let consoleSpy: ReturnType<typeof vi.spyOn>;

const makeWorktree = (overrides: Partial<WorktreeInfo> = {}): WorktreeInfo => ({
  name: 'my-feature',
  path: '/project/.trees/my-feature',
  branch: 'diptych/my-feature',
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
  vi.mocked(listWorktrees).mockReset().mockResolvedValue([]);
  vi.mocked(removeWorktree).mockReset().mockResolvedValue(undefined);
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
  registerWorktreeCommand(program);
  await program.parseAsync(['node', 'diptych', 'worktree', ...args, '--project', tmp]);
}

describe('worktree list — empty', () => {
  it('prints "no worktrees" message when listWorktrees returns []', async () => {
    vi.mocked(listWorktrees).mockResolvedValue([]);
    await runWorktree(['list']);
    expect(captureOutput()).toContain('No diptych-managed worktrees found.');
  });
});

describe('worktree list — with entries', () => {
  it('prints headers and one row per WorktreeInfo entry', async () => {
    vi.mocked(listWorktrees).mockResolvedValue([
      makeWorktree({ name: 'my-feature', branch: 'diptych/my-feature', status: 'none', sessionId: null }),
      makeWorktree({ name: 'quick-fix', branch: 'diptych/quick-fix', status: 'none', sessionId: null }),
    ]);

    await runWorktree(['list']);

    const out = captureOutput();
    expect(out).toContain('NAME');
    expect(out).toContain('PATH');
    expect(out).toContain('BRANCH');
    expect(out).toContain('STATUS');
    expect(out).toContain('SESSION');
    expect(out).toContain('PHASE');
    expect(out).toContain('UPDATED');
    expect(out).toContain('my-feature');
    expect(out).toContain('quick-fix');
    expect(out).toContain('/project/.trees/my-feature');
    expect(out).toContain('diptych/my-feature');
    expect(out).toContain('diptych/quick-fix');
  });

  it('shows session ID, phase, and last-updated for active status', async () => {
    vi.mocked(listWorktrees).mockResolvedValue([
      makeWorktree({
        name: 'active-wt',
        branch: 'diptych/active-wt',
        status: 'active',
        sessionId: 'dip-abc123',
        phase: 'implementing',
        lastUpdated: '2026-04-27T10:00:00.000Z',
      }),
    ]);

    await runWorktree(['list']);

    const out = captureOutput();
    expect(out).toContain('active');
    expect(out).toContain('dip-abc123');
    expect(out).toContain('implementing');
    expect(out).toContain('2026-04-27T10:00:00.000Z');
  });

  it('prints unknown for missing session metadata', async () => {
    vi.mocked(listWorktrees).mockResolvedValue([
      makeWorktree({ name: 'idle-wt', branch: 'diptych/idle-wt', status: 'idle', sessionId: 'dip-def456' }),
    ]);

    await runWorktree(['list']);

    const out = captureOutput();
    expect(out).toContain('idle');
    expect(out).toContain('dip-def456');
    expect(out).toContain('unknown');
  });
});

describe('worktree switch', () => {
  it('prints cd hint when worktree exists', async () => {
    vi.mocked(listWorktrees).mockResolvedValue([
      makeWorktree({ name: 'my-feature' }),
    ]);

    await runWorktree(['switch', 'my-feature']);

    const out = captureOutput();
    expect(out).toContain('To switch to worktree "my-feature"');
    expect(out).toContain('cd .trees/my-feature');
    expect(out).toContain('diptych-switch()');
  });

  it('exits 1 when worktree does not exist', async () => {
    vi.mocked(listWorktrees).mockResolvedValue([]);

    let captured: unknown;
    try {
      await runWorktree(['switch', 'missing-wt']);
    } catch (err) {
      captured = err;
    }

    expect(isCliError(captured)).toBe(true);
    expect((captured as Error).message).toContain('missing-wt');
  });
});

describe('worktree remove', () => {
  it('prints success message on removal', async () => {
    vi.mocked(listWorktrees).mockResolvedValue([makeWorktree({ name: 'my-feature' })]);

    await runWorktree(['remove', 'my-feature']);

    const out = captureOutput();
    expect(out).toContain('Removed worktree ".trees/my-feature".');
  });

  it('prints success message when --force is used', async () => {
    vi.mocked(listWorktrees).mockResolvedValue([makeWorktree({ name: 'my-feature' })]);

    const program = new Command();
    program.exitOverride();
    program.configureOutput({ writeErr: () => {}, writeOut: () => {} });
    registerWorktreeCommand(program);
    await program.parseAsync(['node', 'diptych', 'worktree', 'remove', 'my-feature', '--force', '--project', tmp]);

    const out = captureOutput();
    expect(out).toContain('Removed worktree ".trees/my-feature".');
  });

  it('prints branch deletion message when --delete-branch is used', async () => {
    vi.mocked(listWorktrees).mockResolvedValue([makeWorktree({ name: 'my-feature' })]);

    const program = new Command();
    program.exitOverride();
    program.configureOutput({ writeErr: () => {}, writeOut: () => {} });
    registerWorktreeCommand(program);
    await program.parseAsync([
      'node', 'diptych', 'worktree', 'remove', 'my-feature', '--delete-branch', '--project', tmp,
    ]);

    const out = captureOutput();
    expect(out).toContain('Deleted branch diptych/my-feature.');
  });

  it('propagates cliError when removeWorktree rejects', async () => {
    vi.mocked(listWorktrees).mockResolvedValue([makeWorktree({ name: 'my-feature' })]);
    vi.mocked(removeWorktree).mockRejectedValue(
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

  it('exits 1 when worktree does not exist', async () => {
    vi.mocked(listWorktrees).mockResolvedValue([]);

    let captured: unknown;
    try {
      await runWorktree(['remove', 'ghost-wt']);
    } catch (err) {
      captured = err;
    }

    expect(isCliError(captured)).toBe(true);
    expect((captured as Error).message).toContain('ghost-wt');
  });
});
