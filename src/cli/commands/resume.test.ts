import { afterEach, describe, expect, it, vi } from 'vitest';
import { Command } from 'commander';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createTempDir, cleanupTempDir } from '#testing/helpers/temp-dir.js';
import { registerResumeCommand, resumeCommand, type ResumeDeps } from './resume.js';
import { resumeSavedSession } from './continue.js';
import { writeActive } from '../../core/sessions/lifecycle.js';
import { currentProcessStartTimeMs } from '../../core/sessions/lockfile-status.js';
import { checkServerStatus } from '../../engine/ipc/lockfile.js';
import type { WorkflowState } from '../../core/schemas/workflow.js';
import { TRANSCRIPT_OMITTED_MESSAGE } from '../../core/transcript-policy.js';
import { CONFIG_FILE, DIPTYCH_DIR } from '../../core/paths.js';

let tmp: string;

async function runResume(args: string[]): Promise<void> {
  const program = new Command();
  program.exitOverride();
  registerResumeCommand(program);
  await program.parseAsync(['node', 'diptych', 'resume', ...args]);
}

function makeSessionDir(projectDir: string, sessionId: string): string {
  const sessDir = join(projectDir, '.diptych', 'sessions', sessionId);
  mkdirSync(sessDir, { recursive: true });
  return sessDir;
}

function writeStaleLiveLockfile(sessDir: string, sessionId: string): void {
  const data = {
    version: 1,
    pid: process.pid,
    startTimeMs: currentProcessStartTimeMs(),
    lastAliveMs: Date.now() - 999_999,
    sessionId,
    mode: 'standard',
    feature: 'unresponsive feature',
  };
  writeFileSync(join(sessDir, 'lockfile.json'), JSON.stringify(data));
}

function writeExitedLockfile(sessDir: string, sessionId: string): void {
  const data = {
    version: 1,
    pid: process.pid,
    startTimeMs: Date.now(),
    lastAliveMs: Date.now(),
    sessionId,
    mode: 'standard',
    feature: 'test-feature',
    exitedAt: Date.now(),
  };
  writeFileSync(join(sessDir, 'lockfile.json'), JSON.stringify(data));
}

function writeState(sessDir: string, feature = 'unresponsive feature'): void {
  const state = {
    stateVersion: 3,
    phase: 'implementing',
    feature,
    currentTaskIndex: 0,
    attempt: 0,
    plannerSessionId: null,
    startedAt: new Date().toISOString(),
    tokenUsage: {
      plannerInput: 0,
      plannerOutput: 0,
      implementerInput: 0,
      implementerOutput: 0,
      escalationInput: 0,
      escalationOutput: 0,
    },
    tasks: [
      {
        id: 'T001',
        title: 'task-1',
        action: 'create',
        file: 'src/test.ts',
        dependsOn: [],
        description: 'Test task',
        tests: [],
        constraints: [],
        typeDefs: '',
        implementationSteps: [],
        status: 'pending',
      },
    ],
    awaitingContinue: false,
  };
  writeFileSync(join(sessDir, 'state.json'), JSON.stringify(state));
}

describe('resume command', () => {
  afterEach(() => {
    if (tmp) cleanupTempDir(tmp);
    tmp = '';
  });

  it('rejects --worktree as a start-only flag instead of silently ignoring it', async () => {
    await expect(runResume(['--worktree', 'feature-x'])).rejects.toThrow(
      /--worktree is only supported by `diptych start`/,
    );
  });

  it('refuses a stale-live process before loading state, like continue', async () => {
    tmp = createTempDir('resume-stale-live');
    const sessionId = '2025-04-01-unresponsive';
    const sessDir = makeSessionDir(tmp, sessionId);
    writeStaleLiveLockfile(sessDir, sessionId);
    writeState(sessDir);
    writeActive({ projectDir: tmp, sessionId });

    const resumeRuns: WorkflowState[] = [];
    const deps: ResumeDeps = {
      checkServerStatus,
      resumeSavedSession: async ({ state }) => {
        resumeRuns.push(state);
      },
    };

    await expect(resumeCommand({ projectDir: tmp }, deps)).rejects.toThrow(
      new RegExp(`server process ${process.pid} exists but is unresponsive — kill it first`),
    );
    expect(resumeRuns).toHaveLength(0);
  });

  it('omits the feature on the resume status line when persistTranscript is false', async () => {
    tmp = createTempDir('resume-transcript-omitted');
    const sessionId = '2026-04-18-private';
    mkdirSync(join(tmp, DIPTYCH_DIR), { recursive: true });
    writeFileSync(
      join(tmp, DIPTYCH_DIR, CONFIG_FILE),
      ['version: 3', 'workflow:', '  persistTranscript: false', '  mode: standard'].join('\n'),
    );
    const sessDir = makeSessionDir(tmp, sessionId);
    writeExitedLockfile(sessDir, sessionId);
    writeState(sessDir, 'secret oauth login');
    writeActive({ projectDir: tmp, sessionId });

    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const deps: ResumeDeps = {
      checkServerStatus,
      resumeSavedSession: (args) =>
        resumeSavedSession({
          ...args,
          deps: {
            initStores: async () => {},
            renderApp: async () => {},
            runHeadless: async () => {},
            runRpc: async () => {},
            setupWorkflow: async () => ({
              projectDir: tmp,
              useFullscreen: false,
              useMouse: false,
              useHover: false,
            }),
          },
        }),
    };

    try {
      await resumeCommand({ projectDir: tmp }, deps);
    } finally {
      const resumeLine = logSpy.mock.calls
        .map((call) => call.join(' '))
        .find((line) => line.includes('Resuming:'));
      expect(resumeLine).toBeDefined();
      expect(resumeLine).toContain(TRANSCRIPT_OMITTED_MESSAGE);
      expect(resumeLine).not.toContain('secret');
      logSpy.mockRestore();
    }
  });
});
