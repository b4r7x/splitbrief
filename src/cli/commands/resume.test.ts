import { afterEach, describe, expect, it, vi } from 'vitest';
import { Command } from 'commander';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createTempDir, cleanupTempDir } from '#testing/helpers/temp-dir.js';
import { registerResumeCommand, resumeCommand, type ResumeDeps } from './resume.js';
import { resumeSavedSession } from './continue/resume.js';
import { writeActive } from '../../core/sessions/active-pointer.js';
import { currentProcessStartTimeMs } from '../../lib/process/start-time.js';
import { checkServerStatus } from '../../engine/ipc/lockfile.js';
import type { WorkflowState } from '../../core/schemas/workflow.js';
import { TRANSCRIPT_OMITTED_MESSAGE } from '../../core/transcript-policy.js';
import { CONFIG_FILE, SPLITBRIEF_DIR } from '../../core/paths.js';
import { parsePreparedConfig } from '../../engine/runners/prepared-execution.js';
import { makeUsage } from '#testing/helpers/factories/summary.js';

let tmp: string;

async function runResume(args: string[]): Promise<void> {
  const program = new Command();
  program.exitOverride();
  registerResumeCommand(program);
  await program.parseAsync(['node', 'splitbrief', 'resume', ...args]);
}

function makeSessionDir(projectDir: string, sessionId: string): string {
  const sessDir = join(projectDir, '.splitbrief', 'sessions', sessionId);
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
    stateVersion: 4,
    stateRevision: 0,
    stateFence: { token: 0, ownerId: 'initial' },
    phase: 'implementing',
    feature,
    currentTaskIndex: 0,
    attempt: 0,
    plannerSessionId: null,
    startedAt: new Date().toISOString(),
    tokenUsage: makeUsage(),
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
    messageQueue: [],
    briefRecovery: null,
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
      /--worktree is only supported by `splitbrief start`/,
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
    mkdirSync(join(tmp, SPLITBRIEF_DIR), { recursive: true });
    writeFileSync(
      join(tmp, SPLITBRIEF_DIR, CONFIG_FILE),
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
            prepareExecution: async (input) => {
              if (!('existingSession' in input)) throw new Error('expected resume preparation');
              const active = {
                version: 1 as const,
                sessionId: input.existingSession.sessionId,
                generation: '44444444-4444-4444-8444-444444444444',
              };
              return {
                kind: 'prepared',
                execution: {
                  purpose: 'resume',
                  config: parsePreparedConfig(input.effectiveConfig),
                  preparationId: 'private-resume-preparation',
                  report: {
                    generatedAt: '2026-08-04T00:00:00.000Z',
                    projectDir: input.existingSession.projectDir,
                    status: 'ready',
                    counts: { ok: 1, info: 0, warning: 0, blocker: 0 },
                    nextAction: { kind: 'continue', label: 'Continue', reason: 'Ready' },
                    sections: [],
                    metadata: {},
                  },
                  gates: [],
                  session: { kind: 'existing', ref: input.existingSession, active },
                  runtime: {
                    feature: input.feature,
                    resumeState: input.resumeState,
                    allowRepoRunners: input.policy.allowRepoRunners,
                    allowHooks: input.policy.allowHooks,
                  },
                },
              };
            },
          },
        }),
    };

    let resumeLine: string | undefined;
    try {
      await resumeCommand({ projectDir: tmp }, deps);
    } finally {
      resumeLine = logSpy.mock.calls
        .map((call) => call.join(' '))
        .find((line) => line.includes('Resuming:'));
      logSpy.mockRestore();
    }

    expect(resumeLine).toBeDefined();
    expect(resumeLine).toContain(TRANSCRIPT_OMITTED_MESSAGE);
    expect(resumeLine).not.toContain('secret');
  });

  it('passes only prepared CLI identities into a resumed headless run', async () => {
    tmp = createTempDir('resume-readiness-gate');
    const sessionId = '2026-04-18-readiness-gate';
    const sessDir = makeSessionDir(tmp, sessionId);
    writeState(sessDir, 'planning');

    let gatePath: string | undefined;

    await resumeSavedSession({
      projectDir: tmp,
      sessionId,
      state: JSON.parse(readFileSync(join(sessDir, 'state.json'), 'utf8')) as WorkflowState,
      opts: { json: true },
      deps: {
        initStores: async () => {},
        renderApp: async () => {},
        runHeadless: async ({ prepared }) => {
          const gate = prepared.gates.find(
            (gate) => gate.kind === 'cli' && gate.tool === 'claude-code',
          );
          if (gate?.kind === 'cli') gatePath = gate.executable.path;
        },
        runRpc: async () => {},
        setupWorkflow: async () => ({
          projectDir: tmp,
          useFullscreen: false,
          useMouse: false,
          useHover: false,
        }),
        prepareExecution: async (input) => {
          if (!('existingSession' in input)) throw new Error('expected resume preparation');
          const active = {
            version: 1 as const,
            sessionId: input.existingSession.sessionId,
            generation: '55555555-5555-4555-8555-555555555555',
          };
          return {
            kind: 'prepared',
            execution: {
              purpose: 'resume',
              config: parsePreparedConfig(input.effectiveConfig),
              preparationId: 'prepared-cli-resume',
              report: {
                generatedAt: '2026-08-04T00:00:00.000Z',
                projectDir: input.existingSession.projectDir,
                status: 'ready',
                counts: { ok: 1, info: 0, warning: 0, blocker: 0 },
                nextAction: { kind: 'continue', label: 'Continue', reason: 'Ready' },
                sections: [],
                metadata: {},
              },
              gates: [
                {
                  kind: 'cli',
                  tool: 'claude-code',
                  slot: { role: 'planner' },
                  preparationId: 'prepared-cli-resume',
                  executable: {
                    path: '/usr/local/bin/claude',
                    fingerprint: { dev: 1, ino: 2, size: 3, mtimeMs: 4 },
                    executableIdentity: {
                      canonicalPath: '/usr/local/bin/claude',
                      realPath: '/usr/local/bin/claude',
                      platformFileId: '1:2',
                      fingerprint: `1:2:3:4:sha256:${'a'.repeat(64)}`,
                      resolvedAt: 1,
                    },
                  },
                },
              ],
              session: { kind: 'existing', ref: input.existingSession, active },
              runtime: {
                feature: input.feature,
                resumeState: input.resumeState,
                allowRepoRunners: input.policy.allowRepoRunners,
                allowHooks: input.policy.allowHooks,
              },
            },
          };
        },
      },
    });

    expect(gatePath).toBe('/usr/local/bin/claude');
  });
});
