import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Command } from 'commander';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createTempDir, cleanupTempDir } from '#testing/helpers/temp-dir.js';
import { createTestGitRepo } from '#testing/helpers/git.js';
import { registerStatusCommand } from './status.js';
import { SPLITBRIEF_DIR, STATE_FILE, SESSION_LOG_FILE } from '../../core/paths.js';
import { createInitialState } from '../../core/state/machine.js';
import { makeSession } from '#testing/helpers/factories/session.js';
import { CONFIG_FILE } from '../../core/paths.js';
import { TRANSCRIPT_OMITTED_MESSAGE } from '../../core/transcript-policy.js';

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

function writeActiveSession(projectDir: string, sessionId: string, feature: string): void {
  const sessionDir = join(projectDir, SPLITBRIEF_DIR, 'sessions', sessionId);
  mkdirSync(sessionDir, { recursive: true });
  const state = { ...createInitialState(feature), phase: 'implementing' as const };
  writeFileSync(join(sessionDir, STATE_FILE), JSON.stringify(state));
  writeFileSync(join(sessionDir, SESSION_LOG_FILE), '');
  mkdirSync(join(projectDir, SPLITBRIEF_DIR), { recursive: true });
  writeFileSync(join(projectDir, SPLITBRIEF_DIR, 'active'), sessionId + '\n');
}

function writeCompletedSession(projectDir: string, sessionId: string, startedAt: number): void {
  const sessionDir = join(projectDir, SPLITBRIEF_DIR, 'sessions', sessionId);
  mkdirSync(sessionDir, { recursive: true });
  const base = makeSession({ status: 'complete' });
  if (!base.summary) throw new Error('expected complete session summary');
  writeFileSync(
    join(sessionDir, 'summary.json'),
    JSON.stringify(
      makeSession({
        id: sessionId,
        status: 'complete',
        startedAt,
        completedAt: startedAt + 1,
        summary: {
          ...base.summary,
          costBreakdown: {
            hypotheticalCost: 2,
            actualPlannerCost: 0.2,
            actualImplementerCost: 0.3,
            totalActualCost: 0.5,
            savingsAmount: 1.5,
            savingsPercentage: 75,
            localCompletionRate: 1,
          },
        },
      }),
    ),
  );
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

  it('omits the feature name when persistTranscript is false', async () => {
    mkdirSync(join(tmp, SPLITBRIEF_DIR), { recursive: true });
    writeFileSync(
      join(tmp, SPLITBRIEF_DIR, CONFIG_FILE),
      ['version: 3', 'workflow:', '  persistTranscript: false', '  mode: standard'].join('\n'),
    );
    writeActiveSession(tmp, '2026-04-18-private', 'secret oauth login');

    await runStatus([]);
    const out = captureOutput();
    expect(out).toContain(TRANSCRIPT_OMITTED_MESSAGE);
    expect(out).not.toContain('secret');
    expect(out).toContain('implementing');
  });

  it('omits the feature name for a transcript-private session when current config allows transcripts', async () => {
    writeActiveSession(tmp, '2026-04-18-session-abcdef123456', 'secret oauth login');

    await runStatus([]);
    const out = captureOutput();
    expect(out).toContain(TRANSCRIPT_OMITTED_MESSAGE);
    expect(out).not.toContain('secret');
    expect(out).toContain('implementing');
  });

  it('triggers the cost-history path when --history is passed and suppresses the --history hint', async () => {
    await runStatus(['--history']);
    const out = captureOutput();
    expect(out).toContain('No completed sessions with cost data.');
    expect(out).not.toMatch(/Run .*--history/);
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

  it('uses all sessions for --history instead of the recent-session cap', async () => {
    for (let i = 0; i < 12; i += 1) {
      writeCompletedSession(tmp, `2026-04-18-history-${i}`, i);
    }

    await runStatus(['--history']);

    expect(captureOutput()).toContain('Cost History (12 sessions)');
  });
});
