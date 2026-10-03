import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import YAML from 'yaml';
import { createTempDir, cleanupTempDir } from '#testing/helpers/temp-dir.js';
import { makeConfig } from '#testing/helpers/factories/config.js';
import { resetAllStores } from '#testing/helpers/stores.js';
import { continueCommand } from './command.js';
import type { ContinueDeps } from './command.js';
import { writeConfig } from '../../../core/config/load/io.js';
import { routerStore } from '../../../stores/navigation/router.js';
import { skillsStore } from '../../../stores/project/skills.js';
import type { WorkflowState } from '../../../core/schemas/workflow.js';
import { CONFIG_FILE, SPLITBRIEF_DIR } from '../../../core/paths.js';
import type { PrepareExecutionInput } from '../../../engine/runners/prepare-execution/prepare-execution.js';
import type { ReadinessReport } from '../../../core/readiness/types.js';
import { makeUsage } from '#testing/helpers/factories/summary.js';
import { makeRecoveryIssue } from '#testing/helpers/factories/recovery.js';
import { makeTask } from '#testing/helpers/factories/task.js';
import { createInitialState } from '../../../core/state/machine.js';
import { loadState, saveState } from '../../../core/state/persistence.js';
import { parseRecoveryActionOption } from '../../options.js';
import type { RecoveryIssue } from '../../../core/schemas/recovery/schemas.js';

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

  it('continues a run that reached complete without a passing review', async () => {
    const projectDir = makeTmpProject();
    const sessDir = makeSessionDir(projectDir, '2025-04-01-done');
    writeLockfile(sessDir, { exitedAt: Date.now(), sessionId: '2025-04-01-done' });
    writeState(sessDir, 'complete');

    await continueCommand('2025-04-01-done', { projectDir, json: true }, deps);

    // A passing review is what closes a run; reaching the last phase without one does not.
    expect(headlessRuns).toHaveLength(1);
  });

  it('refuses a run that closed on a passing review', async () => {
    const projectDir = makeTmpProject();
    const sessionId = '2025-04-01-closed';
    const sessDir = makeSessionDir(projectDir, sessionId);
    writeLockfile(sessDir, { exitedAt: Date.now(), sessionId });
    saveState(
      { projectDir, sessionId },
      { ...createInitialState('test-feature'), phase: 'complete', reviewStatus: 'passed' },
    );

    await expect(continueCommand(sessionId, { projectDir, json: true }, deps)).rejects.toThrow(
      /Run 2025-04-01-closed is closed \(complete\); nothing to resume\./,
    );
    expect(headlessRuns).toHaveLength(0);
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

  it('applies skip/retry/switch-seat headlessly', async () => {
    const projectDir = makeTmpProject();
    const cases = [
      { id: 'skip', action: 'skip', issue: {} as Partial<RecoveryIssue>, phase: 'implementing' },
      { id: 'retry', action: 'retry', issue: {} as Partial<RecoveryIssue>, phase: 'implementing' },
      {
        id: 'switch',
        action: 'switch-seat:codex',
        issue: {
          reason: 'runner-usage-limit',
          availableActions: ['switch-seat', 'pause-run', 'end-run'],
          recommendedAction: 'switch-seat',
          switchSeat: { seat: 'build', candidates: [{ tool: 'codex' }] },
        } as Partial<RecoveryIssue>,
        phase: 'implementing',
      },
    ] as const;

    for (const testCase of cases) {
      const sessionId = `2025-04-01-action-${testCase.id}`;
      const sessDir = makeSessionDir(projectDir, sessionId);
      writeLockfile(sessDir, { exitedAt: Date.now(), sessionId });
      saveState(
        { projectDir, sessionId },
        {
          ...createInitialState('test-feature'),
          phase: testCase.phase,
          tasks: [makeTask({ id: 'T001' })],
          pendingRecovery: makeRecoveryIssue({ status: 'paused', ...testCase.issue }),
        },
      );

      await continueCommand(
        sessionId,
        { projectDir, json: true, action: parseRecoveryActionOption(testCase.action) },
        deps,
      );

      const resumed = headlessRuns.find((run) => run.sessionId === sessionId);
      expect(resumed, testCase.id).toBeDefined();
      expect(resumed?.state?.pendingRecovery, testCase.id).toBeUndefined();
    }
  });

  it('records a seat the command line moved in the config of record, comments kept', async () => {
    const projectDir = makeTmpProject();
    const sessionId = '2025-04-01-seat-of-record';
    const sessDir = makeSessionDir(projectDir, sessionId);
    writeLockfile(sessDir, { exitedAt: Date.now(), sessionId });
    writeState(sessDir, 'implementing');
    writeConfig(projectDir, makeConfig({ implementer: { kind: 'cli', tool: 'codex' } }));
    const configFile = join(projectDir, SPLITBRIEF_DIR, CONFIG_FILE);
    writeFileSync(configFile, `# the crew of record\n${readFileSync(configFile, 'utf8')}`);
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    // `mockRestore` clears the recorded calls, so they are read before it runs.
    let warnings: string[] = [];

    try {
      await continueCommand(
        sessionId,
        { projectDir, json: true, implementerModel: 'gpt-6-astra' },
        deps,
      );
      warnings = warnSpy.mock.calls.map((call) => call.join(' '));
    } finally {
      warnSpy.mockRestore();
    }

    const yaml = readFileSync(configFile, 'utf8');
    expect(yaml).toContain('# the crew of record');
    expect(YAML.parse(yaml)).toMatchObject({
      implementer: { kind: 'cli', tool: 'codex', model: 'gpt-6-astra' },
    });
    expect(warnings).toContain('BUILD seat recorded in .splitbrief/config.yaml');
    expect(headlessRuns).toHaveLength(1);
  });

  it('moves the planner block when a final review that follows PLAN halts on its limit', async () => {
    const projectDir = makeTmpProject();
    const sessionId = '2025-04-01-review-limit';
    const sessDir = makeSessionDir(projectDir, sessionId);
    writeLockfile(sessDir, { exitedAt: Date.now(), sessionId });
    writeConfig(projectDir, makeConfig({ planner: { kind: 'cli', tool: 'codex' } }));
    saveState(
      { projectDir, sessionId },
      {
        ...createInitialState('test-feature'),
        phase: 'final-review',
        tasks: [makeTask({ id: 'T001', status: 'done' })],
        currentTaskIndex: 1,
        pendingRecovery: makeRecoveryIssue({
          status: 'paused',
          reason: 'runner-usage-limit',
          seat: 'review',
          phase: 'final-review',
          taskId: undefined,
          taskTitle: undefined,
          files: [],
          affectedTaskIds: [],
          availableActions: ['retry-same-worker', 'switch-seat', 'pause-run', 'end-run'],
          recommendedAction: 'switch-seat',
          switchSeat: { seat: 'plan', candidates: [{ tool: 'claude-code' }] },
        }),
      },
    );
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

    try {
      await continueCommand(
        sessionId,
        { projectDir, json: true, action: parseRecoveryActionOption('switch-seat:claude-code') },
        deps,
      );
    } finally {
      warnSpy.mockRestore();
    }

    const recorded = YAML.parse(
      readFileSync(join(projectDir, SPLITBRIEF_DIR, CONFIG_FILE), 'utf8'),
    );
    expect(recorded.planner).toMatchObject({ kind: 'cli', tool: 'claude-code' });
    expect(recorded.reviewer).toBeUndefined();
    // The halt named no brief, so the run re-enters the review it never finished.
    expect(headlessRuns).toHaveLength(1);
    expect(headlessRuns[0]?.state?.phase).toBe('final-review');
    expect(headlessRuns[0]?.state?.pendingRecovery).toBeUndefined();
  });

  it('leaves the config of record alone when no seat moved', async () => {
    const projectDir = makeTmpProject();
    const sessionId = '2025-04-01-seat-unchanged';
    const sessDir = makeSessionDir(projectDir, sessionId);
    writeLockfile(sessDir, { exitedAt: Date.now(), sessionId });
    writeState(sessDir, 'implementing');
    writeConfig(projectDir, makeConfig({ implementer: { kind: 'cli', tool: 'codex' } }));
    const configFile = join(projectDir, SPLITBRIEF_DIR, CONFIG_FILE);
    const before = readFileSync(configFile, 'utf8');

    await continueCommand(sessionId, { projectDir, json: true }, deps);

    expect(readFileSync(configFile, 'utf8')).toBe(before);
  });

  it('closes the run on --action end-run and never re-enters it', async () => {
    const projectDir = makeTmpProject();
    const sessionId = '2025-04-01-action-end-run';
    const sessDir = makeSessionDir(projectDir, sessionId);
    writeLockfile(sessDir, { exitedAt: Date.now(), sessionId });
    saveState(
      { projectDir, sessionId },
      {
        ...createInitialState('test-feature'),
        phase: 'implementing',
        tasks: [makeTask({ id: 'T001' })],
        pendingRecovery: makeRecoveryIssue({
          status: 'paused',
          availableActions: ['pause-run', 'end-run'],
          recommendedAction: 'pause-run',
        }),
      },
    );

    await continueCommand(
      sessionId,
      { projectDir, json: true, action: parseRecoveryActionOption('end-run') },
      deps,
    );

    expect(headlessRuns).toHaveLength(0);
    expect(loadState({ projectDir, sessionId })?.closed).toMatchObject({ as: 'ended' });
  });

  it('exits 1 when the named action is not one the halt offers', async () => {
    const projectDir = makeTmpProject();
    const sessionId = '2025-04-01-action-blocked';
    const sessDir = makeSessionDir(projectDir, sessionId);
    writeLockfile(sessDir, { exitedAt: Date.now(), sessionId });
    saveState(
      { projectDir, sessionId },
      {
        ...createInitialState('test-feature'),
        phase: 'implementing',
        tasks: [makeTask({ id: 'T001' })],
        pendingRecovery: makeRecoveryIssue({
          status: 'paused',
          availableActions: ['pause-run', 'end-run'],
          recommendedAction: 'pause-run',
        }),
      },
    );

    await expect(
      continueCommand(
        sessionId,
        { projectDir, json: true, action: parseRecoveryActionOption('skip') },
        deps,
      ),
    ).rejects.toMatchObject({ exitCode: 1, message: expect.stringContaining('is not available') });
    expect(headlessRuns).toHaveLength(0);
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

  it('resumes a run that saved a workflow mode, with its approve mapped onto plan', async () => {
    const projectDir = makeTmpProject();
    const sessDir = makeSessionDir(projectDir, '2025-04-01-saved-mode');
    writeLockfile(sessDir, { exitedAt: Date.now(), sessionId: '2025-04-01-saved-mode' });
    writeState(sessDir, 'implementing', { mode: 'speckit', approve: 'all' });

    await continueCommand('2025-04-01-saved-mode', { projectDir, json: true }, deps);

    expect(headlessRuns).toHaveLength(1);
    expect(headlessRuns[0]?.state).toMatchObject({ mode: 'speckit', approve: 'plan' });
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

  it('names the last brief, not one past it, when a run resumes after every brief settled', async () => {
    const projectDir = makeTmpProject();
    const sessDir = makeSessionDir(projectDir, '2025-04-01-all-settled');
    writeLockfile(sessDir, { exitedAt: Date.now(), sessionId: '2025-04-01-all-settled' });
    writeState(sessDir, 'final-review', {
      currentTaskIndex: 1,
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
          status: 'done',
        },
      ],
    });

    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    let logged: string[] = [];
    try {
      await continueCommand('2025-04-01-all-settled', { projectDir }, deps);
    } finally {
      logged = logSpy.mock.calls.map((call) => call.join(' '));
      logSpy.mockRestore();
    }

    expect(logged.find((line) => line.includes('Resuming:'))).toContain('task 1/1)');
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
