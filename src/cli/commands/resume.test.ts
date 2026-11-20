import { afterEach, beforeEach, describe, expect, it, type MockInstance, vi } from 'vitest';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createTempDir, cleanupTempDir } from '#testing/helpers/temp-dir.js';
import { Command } from 'commander';
import { registerResumeCommand, resumeCommand, type ResumeDeps } from './resume.js';
import { resumeSavedSession } from './continue/resume.js';
import { writeActive } from '../../core/sessions/active-pointer.js';
import { currentProcessStartTimeMs } from '../../lib/process/start-time.js';
import { checkSessionLiveness } from '../../core/sessions/lock/file.js';
import type { WorkflowState } from '../../core/schemas/workflow/state.js';
import {
  parsePreparedConfig,
  type RunnerGate,
} from '../../engine/runners/prepare-execution/prepared.js';

import { makeRecoveryIssue } from '#testing/helpers/factories/recovery.js';
import { makePreparedExecution } from '#testing/helpers/factories/prepared-execution.js';
import { CONFIG_FILE, SPLITBRIEF_DIR } from '../../core/paths.js';
import type { ResumeTailDeps } from './continue/resume.js';
import { testCliSeats } from '#testing/helpers/runner-gate.js';

let tmp: string;

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

function writeState(
  sessDir: string,
  feature = 'unresponsive feature',
  extra: Record<string, unknown> = {},
): void {
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
    ...extra,
  };
  writeFileSync(join(sessDir, 'state.json'), JSON.stringify(state));
}

describe('resume command', () => {
  afterEach(() => {
    if (tmp) cleanupTempDir(tmp);
    tmp = '';
  });

  it('resumes a stopped run by numeric alias without using the active pointer', async () => {
    tmp = createTempDir('resume-alias');
    const sessionId = '2026-11-18-paused';
    writeState(makeSessionDir(tmp, sessionId), 'a paused run');
    const resumeSavedSession = vi.fn<ResumeDeps['resumeSavedSession']>(async () => {});
    const program = new Command().exitOverride();
    registerResumeCommand(program, { checkSessionLiveness, resumeSavedSession });

    await program.parseAsync(['resume', '1', '--project', tmp, '--plain'], { from: 'user' });

    expect(resumeSavedSession).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({
        sessionId,
        state: expect.objectContaining({ feature: 'a paused run' }),
      }),
    );
  });

  it.each(['absent', 'closed', 'missing'] as const)(
    'selects the newest open run when the active pointer is %s',
    async (pointer) => {
      tmp = createTempDir('resume-default');
      const older = '2026-11-18-older';
      const newer = '2026-11-18-newer';
      const closed = '2026-11-18-closed';
      for (const [sessionId, lastAliveMs, extra] of [
        [older, 1, {}],
        [newer, 2, {}],
        [closed, 3, { phase: 'complete', reviewStatus: 'passed' }],
      ] as const) {
        const directory = makeSessionDir(tmp, sessionId);
        writeState(directory, sessionId, {
          ...extra,
          startedAt: new Date(lastAliveMs).toISOString(),
        });
        writeFileSync(
          join(directory, 'lockfile.json'),
          JSON.stringify({
            version: 1,
            sessionId,
            feature: sessionId,
            pid: process.pid,
            startTimeMs: lastAliveMs,
            lastAliveMs,
            exitedAt: lastAliveMs,
          }),
        );
      }
      if (pointer !== 'absent') {
        writeActive({
          projectDir: tmp,
          sessionId: pointer === 'closed' ? closed : 'standalone-spec',
        });
      }
      const resumeSavedSession = vi.fn<ResumeDeps['resumeSavedSession']>(async () => {});

      await resumeCommand({ projectDir: tmp }, { checkSessionLiveness, resumeSavedSession });

      expect(resumeSavedSession).toHaveBeenCalledExactlyOnceWith(
        expect.objectContaining({ sessionId: newer }),
      );
    },
  );

  it('refuses a stale-live process before loading state, like continue', async () => {
    tmp = createTempDir('resume-stale-live');
    const sessionId = '2025-04-01-unresponsive';
    const sessDir = makeSessionDir(tmp, sessionId);
    writeStaleLiveLockfile(sessDir, sessionId);
    writeState(sessDir);
    writeActive({ projectDir: tmp, sessionId });

    const resumeRuns: WorkflowState[] = [];
    const deps: ResumeDeps = {
      checkSessionLiveness,
      resumeSavedSession: async ({ state }) => {
        resumeRuns.push(state);
      },
    };

    await expect(resumeCommand({ projectDir: tmp }, deps)).rejects.toThrow(
      new RegExp(`session process ${process.pid} exists but is unresponsive — kill it first`),
    );
    expect(resumeRuns).toHaveLength(0);
  });

  it('resume --plain with a pending recovery prints the continue line instead of refusing', async () => {
    tmp = createTempDir('resume-pending-recovery');
    const sessionId = '2026-04-18-halted';
    const sessDir = makeSessionDir(tmp, sessionId);
    writeState(sessDir, 'halted feature', {
      pendingRecovery: makeRecoveryIssue({ recommendedAction: 'skip-current-task' }),
    });
    writeActive({ projectDir: tmp, sessionId });

    const resumeRuns: WorkflowState[] = [];
    const deps: ResumeDeps = {
      checkSessionLiveness: () => ({ alive: false, processAlive: false, data: null }),
      resumeSavedSession: async ({ state }) => {
        resumeRuns.push(state);
      },
    };

    const error = await resumeCommand({ projectDir: tmp, plain: true }, deps).then(
      () => {
        throw new Error('resumeCommand unexpectedly resolved');
      },
      (err: { exitCode?: number; message?: string }) => err,
    );

    expect(error.exitCode).toBe(1);
    expect(error.message).toContain(
      `Continue with: splitbrief continue ${sessionId} --action skip [--plain|--json]`,
    );
    expect(resumeRuns).toHaveLength(0);
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
          const gates: RunnerGate[] = [
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
          ];
          return {
            kind: 'prepared',
            execution: {
              purpose: 'resume',
              config: parsePreparedConfig(input.effectiveConfig),
              sourceConfig: parsePreparedConfig(input.effectiveConfig),
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
              gates,
              cliSeats: testCliSeats(gates),
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

describe('resume diagnostics before the screen mounts', () => {
  const sessionId = '2026-04-18-boot-warning';
  let stderrSpy: MockInstance<typeof process.stderr.write>;

  // A resume without --json or --plain mounts the TUI, which needs a terminal.
  beforeEach(() => {
    process.stdin.isTTY = true;
    stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
  });

  afterEach(() => {
    stderrSpy.mockRestore();
    delete (process.stdin as { isTTY?: boolean }).isTTY;
    if (tmp) cleanupTempDir(tmp);
    tmp = '';
  });

  function onStderr(text: string): number {
    return stderrSpy.mock.calls.filter(([chunk]) => String(chunk).includes(text)).length;
  }

  /** Resumes the active session on the screen. */
  async function resumeOnScreen(): Promise<Parameters<ResumeTailDeps['prepareExecution']>[0][]> {
    const preparations: Parameters<ResumeTailDeps['prepareExecution']>[0][] = [];
    const tail: ResumeTailDeps = {
      prepareExecution: async (input) => {
        preparations.push(input);
        if (!('existingSession' in input)) throw new Error('expected resume preparation');
        return {
          kind: 'prepared',
          execution: makePreparedExecution({
            projectDir: tmp,
            sessionId,
            feature: input.feature,
            config: input.effectiveConfig,
            resumeState: input.resumeState,
          }),
        };
      },
      initStores: async () => {},
      renderApp: async () => {},
      runHeadless: async () => {},
      setupWorkflow: async () => ({
        projectDir: tmp,
        useFullscreen: true,
        useMouse: false,
        useHover: false,
      }),
    };
    const program = new Command();
    program.exitOverride();
    registerResumeCommand(program, {
      checkSessionLiveness,
      resumeSavedSession: (args) => resumeSavedSession({ ...args, deps: tail }),
    });
    await program.parseAsync(['resume', '--project', tmp], { from: 'user' });
    return preparations;
  }

  function makeSession(): void {
    tmp = createTempDir('resume-boot-warning');
    writeState(makeSessionDir(tmp, sessionId), 'boot warning', { phase: 'planning' });
    writeActive({ projectDir: tmp, sessionId });
  }

  it('hands a notice its own config raises to the run preparation and writes none to stderr', async () => {
    makeSession();
    writeFileSync(
      join(tmp, SPLITBRIEF_DIR, CONFIG_FILE),
      [
        'version: 3',
        'planner:',
        '  kind: cli',
        '  tool: claude-code',
        'implementer:',
        '  kind: api',
        '  provider: ollama',
        '  api_base: http://localhost:11434/v1',
        '  model: qwen2.5-coder:7b',
        'workflow:',
        '  mode: instant',
      ].join('\n'),
    );
    const notice = 'workflow.mode was retired and is ignored';

    const preparations = await resumeOnScreen();

    expect(onStderr(notice)).toBe(0);
    expect(preparations.map((input) => input.configWarnings)).toEqual([
      expect.arrayContaining([{ kind: 'retired-value', notice: expect.stringContaining(notice) }]),
    ]);
  });
});
