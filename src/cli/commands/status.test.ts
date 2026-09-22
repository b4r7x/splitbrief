import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Command } from 'commander';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { stripVTControlCharacters } from 'node:util';
import { createTempDir, cleanupTempDir } from '#testing/helpers/temp-dir.js';
import { createTestGitRepo } from '#testing/helpers/git.js';
import { registerStatusCommand } from './status.js';
import { SPLITBRIEF_DIR, STATE_FILE, SESSION_LOG_FILE } from '../../core/paths.js';
import { createInitialState } from '../../core/state/machine.js';
import type { WorkflowState } from '../../core/schemas/workflow.js';
import { makeTask } from '#testing/helpers/factories/task.js';

let tmp: string;
// console.log is a sanctioned global spy — see docs/TESTING.md core rules.
let consoleSpy: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  tmp = createTempDir('status-command-test');
  consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
});

afterEach(() => {
  if (tmp) cleanupTempDir(tmp);
  consoleSpy.mockRestore();
});

function captureOutput(): string {
  return consoleSpy.mock.calls.map((c: unknown[]) => String(c[0])).join('\n');
}

function writeActiveSession(
  projectDir: string,
  sessionId: string,
  feature: string,
  overrides: Partial<WorkflowState> = {},
): void {
  const sessionDir = join(projectDir, SPLITBRIEF_DIR, 'sessions', sessionId);
  mkdirSync(sessionDir, { recursive: true });
  const state = { ...createInitialState(feature), phase: 'implementing' as const, ...overrides };
  writeFileSync(join(sessionDir, STATE_FILE), JSON.stringify(state));
  writeFileSync(join(sessionDir, SESSION_LOG_FILE), '');
  mkdirSync(join(projectDir, SPLITBRIEF_DIR), { recursive: true });
  writeFileSync(join(projectDir, SPLITBRIEF_DIR, 'active'), sessionId + '\n');
}

async function runStatus(args: string[]): Promise<void> {
  const program = new Command();
  program.exitOverride();
  registerStatusCommand(program);
  await program.parseAsync(['node', 'splitbrief', 'status', '--project', tmp, ...args]);
}

describe('status command', () => {
  it('reports no active workflow when .splitbrief has no active marker', async () => {
    await runStatus([]);
    const out = captureOutput();
    expect(out).toContain('No active workflow');
  });

  it('reports the feature name and phase for a live session', async () => {
    writeActiveSession(tmp, '2026-04-18-add-auth', 'add auth');

    await runStatus([]);
    const out = captureOutput();
    expect(out).toContain('add auth');
    expect(out).toContain('implementing');
  });

  it('names the last brief, not one past it, once every brief has settled', async () => {
    writeActiveSession(tmp, '2026-09-21-all-settled', 'all settled', {
      phase: 'final-review',
      currentTaskIndex: 2,
      tasks: [makeTask({ id: 'T001', status: 'done' }), makeTask({ id: 'T002', status: 'done' })],
    });

    await runStatus([]);

    expect(stripVTControlCharacters(captureOutput())).toContain('Task:     2/2');
  });

  it('reports the repository-root session when run from a package subdirectory', async () => {
    createTestGitRepo(tmp);
    const subdir = join(tmp, 'packages', 'web');
    mkdirSync(subdir, { recursive: true });
    writeActiveSession(tmp, '2026-04-18-add-auth', 'add auth');

    const program = new Command();
    program.exitOverride();
    registerStatusCommand(program);
    await program.parseAsync(['node', 'splitbrief', 'status', '--project', subdir]);

    const out = captureOutput();
    expect(out).toContain('add auth');
    expect(out).not.toContain('No active workflow');
  });
});
