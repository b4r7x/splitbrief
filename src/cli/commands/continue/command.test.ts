import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createTempDir, cleanupTempDir } from '#testing/helpers/temp-dir.js';
import { makeConfig } from '#testing/helpers/factories/config.js';
import { resetAllStores } from '#testing/helpers/stores.js';
import { continueCommand } from './command.js';
import type { ContinueDeps } from './command.js';
import { routerStore } from '../../../stores/navigation/router.js';
import { skillsStore } from '../../../stores/project/skills.js';
import type { WorkflowState } from '../../../core/schemas/workflow.js';
import { activeFile, CONFIG_FILE, sessionsRoot, SPLITBRIEF_DIR } from '../../../core/paths.js';
import type { PrepareExecutionInput } from '../../../engine/runners/prepare-execution/prepare-execution.js';
import type { ReadinessReport } from '../../../core/readiness/types.js';
import { makeUsage } from '#testing/helpers/factories/summary.js';

type HeadlessRun = {
  feature: string;
  projectDir: string;
  state: WorkflowState | undefined;
  sessionId: string;
};

type RenderRun = {
  route: ReturnType<typeof routerStore.get>;
  options: Parameters<ContinueDeps['renderApp']>[1];
};

let tmp: string;
let deps: ContinueDeps;
let headlessRuns: HeadlessRun[];
let renderRuns: RenderRun[];

function makeTmpProject(): string {
  tmp = createTempDir('continue-command-test');
  return tmp;
}

function makeSessionDir(projectDir: string, sessionId: string): string {
  const sessDir = join(projectDir, '.splitbrief', 'sessions', sessionId);
  mkdirSync(sessDir, { recursive: true });
  return sessDir;
}

function writeLockfile(sessDir: string, overrides: Record<string, unknown> = {}): void {
  const data = {
    version: 1,
    pid: process.pid,
    startTimeMs: Date.now(),
    lastAliveMs: Date.now(),
    sessionId: 'test-session',
    mode: 'standard',
    feature: 'test-feature',
    ...overrides,
  };
  writeFileSync(join(sessDir, 'lockfile.json'), JSON.stringify(data));
}

function writeState(sessDir: string, phase: string, extra: Record<string, unknown> = {}): void {
  const state = {
    stateVersion: 3,
    phase,
    feature: 'test-feature',
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
    ...extra,
  };
  writeFileSync(join(sessDir, 'state.json'), JSON.stringify(state));
}

function mockPlatform(value: NodeJS.Platform): () => void {
  const original = process.platform;
  Object.defineProperty(process, 'platform', { value, configurable: true });
  return () => Object.defineProperty(process, 'platform', { value: original, configurable: true });
}

function readyReport(projectDir: string): ReadinessReport {
  return {
    generatedAt: '2026-08-04T00:00:00.000Z',
    projectDir,
    status: 'ready',
    counts: { ok: 1, info: 0, warning: 0, blocker: 0 },
    nextAction: { kind: 'continue', label: 'Continue', reason: 'Ready' },
    sections: [],
    metadata: {},
  };
}

async function prepareResume(input: PrepareExecutionInput) {
  if (!('existingSession' in input)) throw new Error('expected resume preparation');
  return {
    kind: 'prepared' as const,
    execution: {
      purpose: 'resume' as const,
      config: input.effectiveConfig,
      preparationId: 'resume-preparation',
      report: readyReport(input.existingSession.projectDir),
      gates: [],
      session: {
        kind: 'existing' as const,
        ref: input.existingSession,
        active: {
          version: 1 as const,
          sessionId: input.existingSession.sessionId,
          generation: '22222222-2222-4222-8222-222222222222',
        },
      },
      runtime: {
        feature: input.feature,
        resumeState: input.resumeState,
        allowRepoRunners: input.policy.allowRepoRunners,
        allowHooks: input.policy.allowHooks,
      },
    },
  };
}

function createDeps(overrides: Partial<ContinueDeps> = {}): ContinueDeps {
  return {
    initStores: async () => {},
    renderApp: async (_app, options) => {
      renderRuns.push({ route: routerStore.get(), options });
    },
    runHeadless: async ({ prepared }) => {
      headlessRuns.push({
        feature: prepared.runtime.feature,
        projectDir: prepared.session.ref.projectDir,
        state: prepared.runtime.resumeState,
        sessionId: prepared.session.ref.sessionId,
      });
    },
    setupWorkflow: async (opts) => {
      const useFullscreen = opts.fullscreen !== false;
      const useMouse = opts.mouse !== false && useFullscreen;
      return {
        projectDir: opts.project ?? '',
        useFullscreen,
        useMouse,
        useHover: opts.hover === true && useMouse,
      };
    },
    prepareExecution: prepareResume,
    ...overrides,
  };
}

describe('continueCommand', () => {
  beforeEach(() => {
    resetAllStores();
    headlessRuns = [];
    renderRuns = [];
    deps = createDeps();
  });

  afterEach(() => {
    if (tmp) cleanupTempDir(tmp);
    tmp = '';
  });

  it('throws when no session exists and no active pointer', async () => {
    const projectDir = makeTmpProject();

    await expect(continueCommand(undefined, { projectDir }, deps)).rejects.toThrow(
      /no session to continue/,
    );
  });

  it('throws a curated not-found error for an explicit session id with no session dir', async () => {
    const projectDir = makeTmpProject();

    await expect(continueCommand('typo-session', { projectDir }, deps)).rejects.toThrow(
      /session 'typo-session' not found/,
    );
  });

  it('throws when explicit session ID has no state and is not running', async () => {
    const projectDir = makeTmpProject();
    const sessDir = makeSessionDir(projectDir, '2025-04-01-my-feature');
    writeLockfile(sessDir, { exitedAt: Date.now(), sessionId: '2025-04-01-my-feature' });

    await expect(continueCommand('2025-04-01-my-feature', { projectDir }, deps)).rejects.toThrow(
      /no usable saved state and is not running/,
    );
  });

  it('throws for a completed session that is not resumable', async () => {
    const projectDir = makeTmpProject();
    const sessDir = makeSessionDir(projectDir, '2025-04-01-done');
    writeLockfile(sessDir, { exitedAt: Date.now(), sessionId: '2025-04-01-done' });
    writeState(sessDir, 'complete');

    await expect(continueCommand('2025-04-01-done', { projectDir }, deps)).rejects.toThrow(
      /cannot be resumed/,
    );
  });

  it('resumes a reviewing-briefs session addressed by alias number', async () => {
    const projectDir = makeTmpProject();
    const sessionId = '2025-04-01-parked';
    const sessDir = makeSessionDir(projectDir, sessionId);
    writeLockfile(sessDir, { exitedAt: Date.now(), sessionId });
    writeState(sessDir, 'reviewing-briefs');

    await continueCommand('1', { projectDir, json: true }, deps);

    expect(headlessRuns).toHaveLength(1);
    expect(headlessRuns[0]).toMatchObject({
      feature: 'test-feature',
      projectDir,
      state: { phase: 'reviewing-briefs' },
      sessionId,
    });
  });

  it('resume reauthorizes the existing session without creating another', async () => {
    const projectDir = makeTmpProject();
    const sessionId = '2025-04-01-exact-resume';
    const sessDir = makeSessionDir(projectDir, sessionId);
    writeLockfile(sessDir, { exitedAt: Date.now(), sessionId });
    writeState(sessDir, 'implementing');
    const prepare = vi.fn(prepareResume);
    deps = createDeps({ prepareExecution: prepare });

    await continueCommand(sessionId, { projectDir, json: true }, deps);

    expect(prepare).toHaveBeenCalledOnce();
    expect(prepare.mock.calls[0]?.[0]).toMatchObject({
      existingSession: { projectDir, sessionId },
      policy: { purpose: 'resume', interaction: 'headless' },
    });
    expect(readdirSync(join(projectDir, SPLITBRIEF_DIR, 'sessions'))).toEqual([sessionId]);
    expect(headlessRuns[0]).toMatchObject({ sessionId, state: { phase: 'implementing' } });
  });

  it('rejects JSON task review before publishing a new active generation', async () => {
    const projectDir = makeTmpProject();
    const sessionId = '2025-04-01-json-review';
    const sessDir = makeSessionDir(projectDir, sessionId);
    writeLockfile(sessDir, { exitedAt: Date.now(), sessionId });
    writeState(sessDir, 'implementing');
    writeFileSync(
      join(projectDir, SPLITBRIEF_DIR, CONFIG_FILE),
      JSON.stringify(makeConfig({ workflow: { taskReview: 'every' } })),
    );
    const existingActive = JSON.stringify({
      version: 1,
      sessionId,
      generation: '11111111-1111-4111-8111-111111111111',
    });
    writeFileSync(activeFile(projectDir), existingActive);
    const prepare = vi.fn(prepareResume);
    const runHeadless = vi.fn(async () => {});
    deps = createDeps({ prepareExecution: prepare, runHeadless });

    await expect(
      continueCommand(sessionId, { projectDir, json: true }, deps),
    ).rejects.toMatchObject({
      kind: 'cli-error',
      message: expect.stringContaining('workflow.taskReview requires an interactive TUI run'),
    });

    expect(prepare).not.toHaveBeenCalled();
    expect(runHeadless).not.toHaveBeenCalled();
    expect(readFileSync(activeFile(projectDir), 'utf8')).toBe(existingActive);
    expect(readdirSync(sessionsRoot(projectDir))).toEqual([sessionId]);
  });

  it('rejects a session with an older stateVersion via loadState filtering', async () => {
    const projectDir = makeTmpProject();
    const sessDir = makeSessionDir(projectDir, '2025-04-01-old');
    writeLockfile(sessDir, { exitedAt: Date.now(), sessionId: '2025-04-01-old' });
    writeState(sessDir, 'implementing', { stateVersion: 1 });

    await expect(continueCommand('2025-04-01-old', { projectDir }, deps)).rejects.toThrow(
      /no usable saved state/,
    );
  });

  it('preserves the saved workflow mode on resume when --mode is not passed', async () => {
    const projectDir = makeTmpProject();
    const sessDir = makeSessionDir(projectDir, '2025-04-01-saved-mode');
    writeLockfile(sessDir, { exitedAt: Date.now(), sessionId: '2025-04-01-saved-mode' });
    writeState(sessDir, 'implementing', { mode: 'speckit', approve: 'all' });

    await continueCommand('2025-04-01-saved-mode', { projectDir, json: true }, deps);

    expect(headlessRuns).toHaveLength(1);
    expect(headlessRuns[0]?.state).toMatchObject({ mode: 'speckit', approve: 'all' });
  });

  it('rehydrates the skills selection from persisted state on resume', async () => {
    const projectDir = makeTmpProject();
    const sessDir = makeSessionDir(projectDir, '2025-04-01-skills');
    writeLockfile(sessDir, { exitedAt: Date.now(), sessionId: '2025-04-01-skills' });
    writeState(sessDir, 'implementing', { selectedSkills: ['typescript', 'react'] });

    await continueCommand('2025-04-01-skills', { projectDir }, deps);

    expect(renderRuns).toHaveLength(1);
    expect([...skillsStore.get().selected].sort()).toEqual(['react', 'typescript']);
  });

  it('overrides the saved workflow mode when --mode is passed explicitly', async () => {
    const projectDir = makeTmpProject();
    const sessDir = makeSessionDir(projectDir, '2025-04-01-override-mode');
    writeLockfile(sessDir, { exitedAt: Date.now(), sessionId: '2025-04-01-override-mode' });
    writeState(sessDir, 'implementing', { mode: 'speckit', approve: 'all' });

    await continueCommand(
      '2025-04-01-override-mode',
      { projectDir, json: true, mode: 'quick' },
      deps,
    );

    expect(headlessRuns).toHaveLength(1);
    expect(headlessRuns[0]?.state).toMatchObject({ mode: 'quick' });
  });

  it('strips terminal control bytes from the pre-TUI resume status line', async () => {
    const projectDir = makeTmpProject();
    const sessDir = makeSessionDir(projectDir, '2025-04-01-osc');
    writeLockfile(sessDir, { exitedAt: Date.now(), sessionId: '2025-04-01-osc' });
    writeState(sessDir, 'implementing', { feature: 'add \u001b]0;pwned\u0007login' });

    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    let logged: string[] = [];
    try {
      await continueCommand('2025-04-01-osc', { projectDir }, deps);
    } finally {
      logged = logSpy.mock.calls.map((call) => call.join(' '));
      logSpy.mockRestore();
    }

    const resumeLine = logged.find((line) => line.includes('Resuming:'));
    expect(resumeLine).toBeDefined();
    expect(resumeLine).toContain('add login');
    expect(resumeLine).not.toContain('\u001b');
    expect(resumeLine).not.toContain('pwned');
  });

  it('resumes an interrupted session on Windows without a platform rejection', async () => {
    const projectDir = makeTmpProject();
    const sessDir = makeSessionDir(projectDir, '2025-04-01-win-resume');
    writeLockfile(sessDir, { exitedAt: Date.now(), sessionId: '2025-04-01-win-resume' });
    writeState(sessDir, 'implementing');

    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const restorePlatform = mockPlatform('win32');
    try {
      await continueCommand('2025-04-01-win-resume', { projectDir }, deps);
    } finally {
      restorePlatform();
      logSpy.mockRestore();
    }

    expect(renderRuns).toHaveLength(1);
  });
});
