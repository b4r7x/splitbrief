import { afterEach, beforeEach, describe, expect, it, type MockInstance, vi } from 'vitest';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createTempDir, cleanupTempDir } from '#testing/helpers/temp-dir.js';
import { Command } from 'commander';
import { registerResumeCommand, resumeCommand, type ResumeDeps } from './resume.js';
import { resumeSavedSession } from './continue/resume.js';
import { writeActive } from '../../core/sessions/active-pointer.js';
import { currentProcessStartTimeMs } from '../../lib/process/start-time.js';
import { checkSessionLiveness } from '../../core/sessions/lockfile.js';
import type { WorkflowState } from '../../core/schemas/workflow.js';
import { parsePreparedConfig } from '../../engine/runners/prepared-execution.js';
import { makeUsage } from '#testing/helpers/factories/summary.js';
import { makeRecoveryIssue } from '#testing/helpers/factories/recovery.js';
import { makeConfig } from '#testing/helpers/factories/config.js';
import { makePreparedExecution } from '#testing/helpers/factories/prepared-execution.js';
import { writeConfig } from '../../core/config/load/io.js';
import { CONFIG_FILE, SPLITBRIEF_DIR } from '../../core/paths.js';
import { installDiagnosticSink, warnStderr } from '../../lib/warn.js';
import type { ResumeTailDeps } from './continue/resume.js';

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
    ...extra,
  };
  writeFileSync(join(sessDir, 'state.json'), JSON.stringify(state));
}

describe('resume command', () => {
  afterEach(() => {
    if (tmp) cleanupTempDir(tmp);
    tmp = '';
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

  /** Resumes the active session on the screen; the screen collects what it is shown. */
  async function resumeOnScreen(
    initStores: ResumeTailDeps['initStores'],
    held: string,
  ): Promise<string[]> {
    const shown: string[] = [];
    const tail: ResumeTailDeps = {
      prepareExecution: async (input) => {
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
      initStores,
      renderApp: async () => {
        const release = installDiagnosticSink((message) => shown.push(message));
        try {
          expect(onStderr(held)).toBe(0);
        } finally {
          release();
        }
      },
      runHeadless: async () => {},
      setupWorkflow: async () => ({
        projectDir: tmp,
        useFullscreen: true,
        useMouse: false,
        useHover: false,
      }),
    };
    await resumeFromCli(['--project', tmp], {
      checkSessionLiveness,
      resumeSavedSession: (args) => resumeSavedSession({ ...args, deps: tail }),
    });
    return shown;
  }

  async function resumeFromCli(args: string[], deps: ResumeDeps): Promise<void> {
    const program = new Command();
    program.exitOverride();
    registerResumeCommand(program, deps);
    await program.parseAsync(['resume', ...args], { from: 'user' });
  }

  function makeSession(): void {
    tmp = createTempDir('resume-boot-warning');
    writeState(makeSessionDir(tmp, sessionId), 'boot warning', { phase: 'planning' });
    writeActive({ projectDir: tmp, sessionId });
  }

  it('shows a warning raised while it starts on the screen once the screen mounts', async () => {
    makeSession();
    writeConfig(tmp, makeConfig());
    const warning = 'Could not read .splitbrief/ui-prefs.json, so the default layout is used';

    const shown = await resumeOnScreen(async () => warnStderr(warning), warning);

    expect(shown).toEqual([warning]);
    expect(onStderr(warning)).toBe(1);
  });

  it('shows a notice its own config raises on the screen once the screen mounts', async () => {
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
    const notice = '⚠ workflow.mode was retired and is ignored';

    const shown = await resumeOnScreen(async () => {}, notice);

    expect(shown).toEqual([expect.stringContaining(notice)]);
    expect(onStderr(notice)).toBe(1);
  });

  it('writes a warning as it comes when the resume has no screen', async () => {
    makeSession();
    writeConfig(tmp, makeConfig());
    const warning = 'Could not read .splitbrief/ui-prefs.json, so the default layout is used';
    let writtenAtOnce = 0;

    await resumeFromCli(['--json', '--project', tmp], {
      checkSessionLiveness,
      resumeSavedSession: async () => {
        warnStderr(warning);
        writtenAtOnce = onStderr(warning);
      },
    });

    expect(writtenAtOnce).toBe(1);
    expect(onStderr(warning)).toBe(1);
  });
});
