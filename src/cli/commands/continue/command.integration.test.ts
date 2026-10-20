import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
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
import { CONFIG_FILE, SPLITBRIEF_DIR, sessionDir } from '../../../core/paths.js';
import type { PrepareExecutionInput } from '../../../engine/runners/prepare-execution/prepare-execution.js';
import type { ReadinessReport } from '../../../core/readiness/types.js';
import { makeUsage } from '#testing/helpers/factories/summary.js';
import { makeRecoveryIssue } from '#testing/helpers/factories/recovery.js';
import { makeTask } from '#testing/helpers/factories/task.js';
import { makeWorkflowState, RUN_CREW } from '#testing/helpers/factories/workflow-state.js';
import { type ApplyRun, withApplyRun } from '#testing/helpers/apply-run.js';
import { readSession } from '../../../core/sessions/io.js';
import { readActive, reactivateExistingSession } from '../../../core/sessions/active-pointer.js';
import { readRunEvents } from '../../../engine/events/replay.js';
import { createInitialState } from '../../../core/state/machine.js';
import { loadState, saveState } from '../../../core/state/persistence.js';
import { parseContinueActionOption } from '../../options.js';
import type { RecoveryIssue } from '../../../core/schemas/recovery/schemas.js';
import { saveDetectionCache } from '../../../engine/detection/cache.js';

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

// An interactive continue mounts the TUI, which needs a terminal; each test that renders has one.
beforeEach(() => {
  process.stdin.isTTY = true;
});

afterEach(() => {
  delete (process.stdin as { isTTY?: boolean }).isTTY;
});

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
      sourceConfig: input.effectiveConfig,
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
      {
        ...createInitialState('test-feature'),
        ...RUN_CREW,
        phase: 'complete',
        reviewStatus: 'passed',
      },
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

  it('refuses an interactive continue without a terminal before its recovery action writes', async () => {
    const projectDir = makeTmpProject();
    const sessionId = '2025-04-01-no-terminal';
    writeLockfile(makeSessionDir(projectDir, sessionId), { exitedAt: Date.now(), sessionId });
    saveState(
      { projectDir, sessionId },
      {
        ...createInitialState('test-feature'),
        ...RUN_CREW,
        phase: 'implementing',
        tasks: [makeTask({ id: 'T001' })],
        pendingRecovery: makeRecoveryIssue({}),
      },
    );
    const statePath = join(sessionDir(projectDir, sessionId), 'state.json');
    const before = readFileSync(statePath, 'utf8');
    delete (process.stdin as { isTTY?: boolean }).isTTY;

    for (const action of [undefined, parseContinueActionOption('retry')]) {
      await expect(
        continueCommand(sessionId, { projectDir, ...(action && { action }) }, deps),
      ).rejects.toMatchObject({
        message: expect.stringContaining('interactive mode needs a TTY — use --json or --plain'),
        exitCode: 1,
      });
    }
    expect(readFileSync(statePath, 'utf8')).toBe(before);
    expect(renderRuns).toHaveLength(0);
    expect(headlessRuns).toHaveLength(0);
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
          availableActions: ['retry-same-worker', 'switch-seat', 'end-run'],
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
          ...RUN_CREW,
          phase: testCase.phase,
          tasks: [makeTask({ id: 'T001' })],
          pendingRecovery: makeRecoveryIssue(testCase.issue),
        },
      );

      await continueCommand(
        sessionId,
        { projectDir, json: true, action: parseContinueActionOption(testCase.action) },
        deps,
      );

      const resumed = headlessRuns.find((run) => run.sessionId === sessionId);
      expect(resumed, testCase.id).toBeDefined();
      expect(resumed?.state?.pendingRecovery, testCase.id).toBeUndefined();
    }
  });

  it('records the remembered catalog name when continuing on a fallback', async () => {
    const projectDir = makeTmpProject();
    const sessionId = 'catalog-fallback-continue';
    const sessDir = makeSessionDir(projectDir, sessionId);
    writeLockfile(sessDir, { exitedAt: 1, sessionId });
    writeConfig(projectDir, makeConfig({ implementer: { kind: 'cli', tool: 'claude-code' } }));
    saveState(
      { projectDir, sessionId },
      {
        ...createInitialState('catalog names'),
        ...RUN_CREW,
        phase: 'implementing',
        tasks: [makeTask()],
        pendingRecovery: makeRecoveryIssue({
          reason: 'runner-usage-limit',
          availableActions: ['switch-seat'],
          recommendedAction: 'switch-seat',
          switchSeat: { seat: 'build', candidates: [{ tool: 'codex', model: 'gpt-6-luna' }] },
        }),
      },
    );
    await saveDetectionCache({
      projectDir,
      snapshot: {
        contextKey: 'remembered',
        fetchedAt: 1,
        validatedAt: 1,
        generation: 1,
        requestId: 1,
        providers: [],
        cliTools: [],
        cliCatalogs: [
          { tool: 'codex', probedAt: 1, models: [{ id: 'gpt-6-luna', displayName: 'GPT-6-Luna' }] },
        ],
      },
    });

    await continueCommand(
      sessionId,
      { projectDir, json: true, action: parseContinueActionOption('switch-seat:codex:gpt-6-luna') },
      deps,
    );

    expect(loadState({ projectDir, sessionId })?.seatSwitches?.[0]?.to).toBe(
      'OpenAI Codex CLI · GPT-6-Luna',
    );
  });

  it('records the switched build seat, the file comment and its fallback kept', async () => {
    const projectDir = makeTmpProject();
    const sessionId = '2025-04-01-seat-of-record';
    const sessDir = makeSessionDir(projectDir, sessionId);
    writeLockfile(sessDir, { exitedAt: Date.now(), sessionId });
    writeConfig(
      projectDir,
      makeConfig({
        implementer: {
          kind: 'cli',
          tool: 'codex',
          fallback: { tool: 'opencode' },
        },
      }),
    );
    const configFile = join(projectDir, SPLITBRIEF_DIR, CONFIG_FILE);
    writeFileSync(configFile, `# the crew of record\n${readFileSync(configFile, 'utf8')}`);
    saveState(
      { projectDir, sessionId },
      {
        ...createInitialState('test-feature'),
        ...RUN_CREW,
        phase: 'implementing',
        tasks: [makeTask({ id: 'T001' })],
        pendingRecovery: makeRecoveryIssue({
          reason: 'runner-usage-limit',
          seat: 'build',
          selectedImplementerProfile: undefined,
          availableActions: ['retry-same-worker', 'switch-seat', 'end-run'],
          recommendedAction: 'switch-seat',
          switchSeat: { seat: 'build', candidates: [{ tool: 'claude-code' }] },
        }),
      },
    );
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    // `mockRestore` clears the recorded calls, so they are read before it runs.
    let warnings: string[] = [];

    try {
      await continueCommand(
        sessionId,
        { projectDir, json: true, action: parseContinueActionOption('switch-seat:claude-code') },
        deps,
      );
      warnings = warnSpy.mock.calls.map((call) => call.join(' '));
    } finally {
      warnSpy.mockRestore();
    }

    const yaml = readFileSync(configFile, 'utf8');
    expect(yaml).toContain('# the crew of record');
    expect(YAML.parse(yaml)).toMatchObject({
      implementer: {
        kind: 'cli',
        tool: 'claude-code',
        fallback: { tool: 'opencode' },
      },
    });
    expect(warnings).toContain('BUILD seat recorded in .splitbrief/config.yaml');
    expect(headlessRuns).toHaveLength(1);
  });

  it('gives an inherited final review its own reviewer block after a seat switch', async () => {
    const projectDir = makeTmpProject();
    const sessionId = '2025-04-01-review-limit';
    const sessDir = makeSessionDir(projectDir, sessionId);
    writeLockfile(sessDir, { exitedAt: Date.now(), sessionId });
    const config = makeConfig({ planner: { kind: 'cli', tool: 'codex' } });
    writeConfig(projectDir, config);
    saveState(
      { projectDir, sessionId },
      {
        ...createInitialState('test-feature'),
        ...RUN_CREW,
        phase: 'final-review',
        tasks: [makeTask({ id: 'T001', status: 'done' })],
        currentTaskIndex: 1,
        pendingRecovery: makeRecoveryIssue({
          reason: 'runner-usage-limit',
          seat: 'review',
          phase: 'final-review',
          taskId: undefined,
          taskTitle: undefined,
          files: [],
          affectedTaskIds: [],
          availableActions: ['retry-same-worker', 'switch-seat', 'end-run'],
          recommendedAction: 'switch-seat',
          switchSeat: { seat: 'review', candidates: [{ tool: 'claude-code' }] },
        }),
      },
    );
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

    try {
      await continueCommand(
        sessionId,
        { projectDir, json: true, action: parseContinueActionOption('switch-seat:claude-code') },
        deps,
      );
    } finally {
      warnSpy.mockRestore();
    }

    const recorded = YAML.parse(
      readFileSync(join(projectDir, SPLITBRIEF_DIR, CONFIG_FILE), 'utf8'),
    );
    expect(recorded.planner).toEqual(config.planner);
    expect(recorded.reviewer).toMatchObject({ kind: 'cli', tool: 'claude-code' });
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

  it('ends a recovery run even when the halt does not offer end-run', async () => {
    const projectDir = makeTmpProject();
    const sessionId = '2025-04-01-action-end-run';
    const sessDir = makeSessionDir(projectDir, sessionId);
    writeLockfile(sessDir, { exitedAt: Date.now(), sessionId });
    reactivateExistingSession({ projectDir, sessionId });
    saveState(
      { projectDir, sessionId },
      {
        ...createInitialState('test-feature'),
        ...RUN_CREW,
        phase: 'implementing',
        tasks: [makeTask({ id: 'T001', status: 'failed' })],
        pendingRecovery: makeRecoveryIssue({
          availableActions: ['retry-same-worker', 'skip-current-task'],
          recommendedAction: 'retry-same-worker',
        }),
      },
    );

    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    let logged: string[] = [];
    try {
      await continueCommand(
        sessionId,
        { projectDir, json: true, action: parseContinueActionOption('end-run') },
        deps,
      );
    } finally {
      logged = logSpy.mock.calls.map((call) => call.join(' '));
      logSpy.mockRestore();
    }

    expect(headlessRuns).toHaveLength(0);
    expect(renderRuns).toHaveLength(0);
    const ref = { projectDir, sessionId };
    expect(loadState(ref)?.closed).toMatchObject({ as: 'ended' });
    expect(loadState(ref)?.pendingRecovery).toBeUndefined();
    expect(readSession(ref)?.status).toBe('ended');
    expect(readActive(projectDir)).toBeNull();
    const events = (await readRunEvents(ref)).events;
    expect(events.filter((event) => event.type === 'workflow_cancelled')).toHaveLength(1);
    expect(events.filter((event) => event.type === 'recovery_resolved')).toEqual([
      expect.objectContaining({ action: 'end-run', outcome: 'aborted' }),
    ]);
    expect(logged.join('\n')).toContain('The files it wrote are still on disk.');
  });

  it('ends a stopped run without pending recovery and never re-enters it', async () => {
    const projectDir = makeTmpProject();
    const sessionId = '2025-04-01-end-stopped-run';
    const sessDir = makeSessionDir(projectDir, sessionId);
    writeLockfile(sessDir, { exitedAt: Date.now(), sessionId });
    reactivateExistingSession({ projectDir, sessionId });
    saveState(
      { projectDir, sessionId },
      makeWorkflowState({
        ...RUN_CREW,
        phase: 'implementing',
        awaitingContinue: true,
        tasks: [makeTask({ id: 'T001', status: 'in_progress' })],
      }),
    );
    expect(loadState({ projectDir, sessionId })?.pendingRecovery).toBeUndefined();
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    let logged: string[] = [];

    try {
      await continueCommand(
        sessionId,
        { projectDir, plain: true, action: parseContinueActionOption('end-run') },
        deps,
      );
    } finally {
      logged = logSpy.mock.calls.map((call) => call.join(' '));
      logSpy.mockRestore();
    }

    expect(logged).toEqual([`Run ${sessionId} closed. The files it wrote are still on disk.`]);
    expect(loadState({ projectDir, sessionId })?.closed?.as).toBe('ended');
    expect(readSession({ projectDir, sessionId })?.status).toBe('ended');
    expect(readActive(projectDir)).toBeNull();
    expect(
      (await readRunEvents({ projectDir, sessionId })).events.filter(
        (event) => event.type === 'workflow_cancelled',
      ),
    ).toHaveLength(1);
    expect(headlessRuns).toHaveLength(0);
    expect(renderRuns).toHaveLength(0);
  });

  it('refuses End run on an already closed run', async () => {
    const projectDir = makeTmpProject();
    const sessionId = '2025-04-01-end-closed-run';
    makeSessionDir(projectDir, sessionId);
    saveState(
      { projectDir, sessionId },
      makeWorkflowState({ ...RUN_CREW, closed: { as: 'ended', at: '2025-04-01T00:00:00.000Z' } }),
    );

    await expect(
      continueCommand(
        sessionId,
        { projectDir, plain: true, action: parseContinueActionOption('end-run') },
        deps,
      ),
    ).rejects.toMatchObject({
      exitCode: 1,
      message: expect.stringMatching(/is closed \(.*\); nothing to end\./),
    });
    expect(headlessRuns).toHaveLength(0);
  });

  it.each(['skip', 'retry', 'restore', 'switch-seat:codex'])(
    'still requires pending recovery for --action %s',
    async (action) => {
      const projectDir = makeTmpProject();
      const sessionId = '2025-04-01-retry-without-recovery';
      makeSessionDir(projectDir, sessionId);
      saveState(
        { projectDir, sessionId },
        makeWorkflowState({ ...RUN_CREW, phase: 'implementing' }),
      );

      await expect(
        continueCommand(
          sessionId,
          { projectDir, plain: true, action: parseContinueActionOption(action) },
          deps,
        ),
      ).rejects.toMatchObject({
        exitCode: 1,
        message: 'No pending recovery issue is available.',
      });
      expect(loadState({ projectDir, sessionId })?.closed).toBeUndefined();
      expect(headlessRuns).toHaveLength(0);
    },
  );

  it('closes a worktree run without saying its files are still on disk', async () => {
    const projectDir = makeTmpProject();
    const sessionId = '2025-04-01-action-end-run-worktree';
    const sessDir = makeSessionDir(projectDir, sessionId);
    writeLockfile(sessDir, { exitedAt: Date.now(), sessionId });
    saveState(
      { projectDir, sessionId },
      {
        ...createInitialState('test-feature'),
        ...RUN_CREW,
        phase: 'implementing',
        tasks: [makeTask({ id: 'T001' })],
        workspace: {
          kind: 'worktree',
          path: join(projectDir, '.trees', 'test-run'),
          base: { snapshotId: 'snapshot-1', head: null },
        },
        pendingRecovery: makeRecoveryIssue({
          status: 'awaiting-user',
          availableActions: ['end-run'],
          recommendedAction: 'end-run',
        }),
      },
    );

    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    let logged: string[] = [];
    try {
      await continueCommand(
        sessionId,
        { projectDir, json: true, action: parseContinueActionOption('end-run') },
        deps,
      );
    } finally {
      logged = logSpy.mock.calls.map((call) => call.join(' '));
      logSpy.mockRestore();
    }

    expect(loadState({ projectDir, sessionId })?.closed).toMatchObject({ as: 'ended' });
    expect(logged.join('\n')).toContain(`Run ${sessionId} closed.`);
    expect(logged.join('\n')).not.toContain('still on disk');
    expect(headlessRuns).toHaveLength(0);
  });

  it('answers a partial Apply with --action restore: the run re-enters to restore the backup', async () => {
    const projectDir = makeTmpProject();
    const sessionId = '2025-04-01-action-restore';
    const sessDir = makeSessionDir(projectDir, sessionId);
    writeLockfile(sessDir, { exitedAt: Date.now(), sessionId });
    saveState(
      { projectDir, sessionId },
      {
        ...createInitialState('test-feature'),
        ...RUN_CREW,
        phase: 'complete',
        tasks: [makeTask({ id: 'T001' })],
        pendingRecovery: makeRecoveryIssue({
          reason: 'apply-partial',
          phase: 'complete',
          status: 'awaiting-user',
          availableActions: ['retry-same-worker', 'restore-backup', 'end-run'],
          recommendedAction: 'retry-same-worker',
        }),
      },
    );

    await continueCommand(
      sessionId,
      { projectDir, json: true, action: parseContinueActionOption('restore') },
      deps,
    );

    const resumed = headlessRuns.find((run) => run.sessionId === sessionId);
    expect(resumed?.state?.pendingRecovery).toMatchObject({
      status: 'applying',
      selectedAction: 'restore-backup',
    });
  });

  it('exits 1 on --action restore when the halt is not a partial Apply', async () => {
    const projectDir = makeTmpProject();
    const sessionId = '2025-04-01-action-restore-blocked';
    const sessDir = makeSessionDir(projectDir, sessionId);
    writeLockfile(sessDir, { exitedAt: Date.now(), sessionId });
    saveState(
      { projectDir, sessionId },
      {
        ...createInitialState('test-feature'),
        ...RUN_CREW,
        phase: 'implementing',
        tasks: [makeTask({ id: 'T001' })],
        pendingRecovery: makeRecoveryIssue({ status: 'awaiting-user' }),
      },
    );

    await expect(
      continueCommand(
        sessionId,
        { projectDir, json: true, action: parseContinueActionOption('restore') },
        deps,
      ),
    ).rejects.toMatchObject({ exitCode: 1 });
    expect(headlessRuns).toHaveLength(0);
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
        ...RUN_CREW,
        phase: 'implementing',
        tasks: [makeTask({ id: 'T001' })],
        pendingRecovery: makeRecoveryIssue({
          availableActions: ['retry-same-worker', 'end-run'],
          recommendedAction: 'retry-same-worker',
        }),
      },
    );

    await expect(
      continueCommand(
        sessionId,
        { projectDir, json: true, action: parseContinueActionOption('skip') },
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

  it('keeps the words of a task written on two lines apart on the resume status line', async () => {
    const projectDir = makeTmpProject();
    const sessDir = makeSessionDir(projectDir, '2025-04-01-two-lines');
    writeLockfile(sessDir, { exitedAt: Date.now(), sessionId: '2025-04-01-two-lines' });
    writeState(sessDir, 'implementing', { feature: 'Add fixtures,\nas one task' });

    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    let logged: string[] = [];
    try {
      await continueCommand('2025-04-01-two-lines', { projectDir }, deps);
    } finally {
      logged = logSpy.mock.calls.map((call) => call.join(' '));
      logSpy.mockRestore();
    }

    expect(logged.find((line) => line.includes('Resuming:'))).toContain(
      'Resuming: Add fixtures, as one task (phase:',
    );
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

describe('continueCommand --action apply|discard|end-run', () => {
  const SESSION_ID = '2026-10-04-ready-run';
  const FIVE = 'one\ntwo\nthree\nfour\nfive\n';
  const read = (root: string, file: string): string => readFileSync(join(root, file), 'utf8');

  beforeEach(() => {
    resetAllStores();
    headlessRuns = [];
    renderRuns = [];
    deps = createDeps();
  });

  function saveReady(run: ApplyRun, overrides: Partial<WorkflowState> = {}): void {
    saveState(
      { projectDir: run.dir, sessionId: SESSION_ID },
      makeWorkflowState({
        ...RUN_CREW,
        phase: 'complete',
        reviewStatus: 'passed',
        workspace: run.workspace,
        ...overrides,
      }),
    );
  }

  /** What the command wrote to each stream; stdout belongs to the NDJSON records alone. */
  function captureOutput(): { stdout: () => string; stderr: () => string; restore: () => void } {
    const out = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    const err = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    const text = (spy: typeof out): string =>
      spy.mock.calls.map((call) => String(call[0])).join('');
    let written = { stdout: '', stderr: '' };
    return {
      stdout: () => written.stdout,
      stderr: () => written.stderr,
      restore: () => {
        written = { stdout: text(out), stderr: text(err) };
        out.mockRestore();
        err.mockRestore();
      },
    };
  }

  function settle(run: ApplyRun, action: 'apply' | 'discard'): Promise<void> {
    return continueCommand(
      SESSION_ID,
      { projectDir: run.dir, json: true, action: parseContinueActionOption(action) },
      deps,
    );
  }

  it('applies a ready run: the checkout takes its files and the run closes applied', async () => {
    await withApplyRun({ 'a.txt': FIVE }, { sessionId: SESSION_ID }, async (run) => {
      writeFileSync(join(run.ws, 'a.txt'), 'ONE\ntwo\nthree\nfour\nfive\n');
      writeFileSync(join(run.ws, 'b.txt'), 'created by the run\n');
      saveReady(run);
      const output = captureOutput();

      try {
        await settle(run, 'apply');
      } finally {
        output.restore();
      }

      expect(output.stderr()).toContain('Applied 2 files to your checkout.');
      expect(output.stdout()).toBe('');

      expect(read(run.dir, 'a.txt')).toBe('ONE\ntwo\nthree\nfour\nfive\n');
      expect(read(run.dir, 'b.txt')).toBe('created by the run\n');
      expect(loadState({ projectDir: run.dir, sessionId: SESSION_ID })?.closed?.as).toBe('applied');
      expect(readSession({ projectDir: run.dir, sessionId: SESSION_ID })?.apply).toBe('applied');
      expect(headlessRuns).toHaveLength(0);
      expect(renderRuns).toHaveLength(0);
    });
  });

  it('discards a ready run: run.patch keeps its work and the checkout stays as it was', async () => {
    await withApplyRun({ 'a.txt': FIVE }, { sessionId: SESSION_ID }, async (run) => {
      writeFileSync(join(run.ws, 'b.txt'), 'created by the run\n');
      saveReady(run);
      const output = captureOutput();

      try {
        await settle(run, 'discard');
      } finally {
        output.restore();
      }

      expect(output.stderr()).toBe(
        `Run ${SESSION_ID} discarded. Run changes not applied are saved in ${join(SPLITBRIEF_DIR, 'sessions', SESSION_ID, 'run.patch')}; apply them with git apply.\n`,
      );
      expect(output.stdout()).toBe('');
      expect(read(run.dir, 'a.txt')).toBe(FIVE);
      expect(existsSync(join(run.dir, 'b.txt'))).toBe(false);
      const patch = read(sessionDir(run.dir, SESSION_ID), 'run.patch');
      expect(patch).toContain('+created by the run');
      expect(loadState({ projectDir: run.dir, sessionId: SESSION_ID })?.closed?.as).toBe(
        'discarded',
      );
      expect(readSession({ projectDir: run.dir, sessionId: SESSION_ID })?.apply).toBe('discarded');
      expect(existsSync(run.ws)).toBe(false);
      expect(headlessRuns).toHaveLength(0);
    });
  });

  it('ends a ready run as discarded and keeps run.patch', async () => {
    await withApplyRun({ 'a.txt': FIVE }, { sessionId: SESSION_ID }, async (run) => {
      writeFileSync(join(run.ws, 'b.txt'), 'created by the run\n');
      saveReady(run);
      const output = captureOutput();
      const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
      let logged: string[] = [];

      try {
        await continueCommand(
          SESSION_ID,
          { projectDir: run.dir, plain: true, action: parseContinueActionOption('end-run') },
          deps,
        );
      } finally {
        logged = logSpy.mock.calls.map((call) => call.join(' '));
        logSpy.mockRestore();
        output.restore();
      }

      const ref = { projectDir: run.dir, sessionId: SESSION_ID };
      const patch = join(sessionDir(run.dir, SESSION_ID), 'run.patch');
      expect(logged).toEqual([
        `Run ${SESSION_ID} closed. Run changes not applied are saved in ${join(SPLITBRIEF_DIR, 'sessions', SESSION_ID, 'run.patch')}; apply them with git apply.`,
      ]);
      expect(output.stderr()).not.toContain('run.patch');
      expect(loadState(ref)?.closed?.as).toBe('discarded');
      expect(readSession(ref)?.apply).toBe('discarded');
      expect(readFileSync(patch, 'utf8')).toContain('+created by the run');
      expect(existsSync(run.ws)).toBe(false);
      expect(read(run.dir, 'a.txt')).toBe(FIVE);
      expect(existsSync(join(run.dir, 'b.txt'))).toBe(false);
      expect(headlessRuns).toHaveLength(0);
      expect(renderRuns).toHaveLength(0);
    });
  });

  it('says no patch was written when the run workspace is already gone', async () => {
    await withApplyRun({ 'a.txt': FIVE }, { sessionId: SESSION_ID }, async (run) => {
      saveReady(run);
      rmSync(run.ws, { recursive: true, force: true });
      const output = captureOutput();

      try {
        await settle(run, 'discard');
      } finally {
        output.restore();
      }

      expect(output.stderr()).toContain('is gone; no run patch was written.');
      expect(output.stderr()).not.toContain('run.patch;');
      expect(existsSync(join(sessionDir(run.dir, SESSION_ID), 'run.patch'))).toBe(false);
      expect(loadState({ projectDir: run.dir, sessionId: SESSION_ID })?.closed?.as).toBe(
        'discarded',
      );
    });
  });

  it('carries the run into its checks and review when the checkout changed a file the run changed', async () => {
    await withApplyRun({ 'a.txt': FIVE }, { sessionId: SESSION_ID }, async (run) => {
      writeFileSync(join(run.ws, 'a.txt'), 'ONE\ntwo\nthree\nfour\nfive\n');
      writeFileSync(join(run.dir, 'a.txt'), 'one\ntwo\nthree\nfour\nFIVE\n');
      saveReady(run);
      const output = captureOutput();

      try {
        await settle(run, 'apply');
      } finally {
        output.restore();
      }

      expect(output.stderr()).toContain(
        'the merged result goes through its checks and review again.',
      );
      expect(output.stdout()).toBe('');
      expect(read(run.dir, 'a.txt')).toBe('one\ntwo\nthree\nfour\nFIVE\n');
      expect(headlessRuns).toHaveLength(1);
      expect(headlessRuns[0]?.state?.applyReview).toBeDefined();
    });
  });

  it('halts with the conflict and its resume line when both sides changed a binary file', async () => {
    await withApplyRun({ 'a.txt': FIVE }, { sessionId: SESSION_ID }, async (run) => {
      writeFileSync(join(run.ws, 'a.txt'), 'RUN\0\ntwo\nthree\nfour\nfive\n');
      writeFileSync(join(run.dir, 'a.txt'), 'USER\0\ntwo\nthree\nfour\nfive\n');
      saveReady(run);

      await expect(
        continueCommand(
          SESSION_ID,
          { projectDir: run.dir, plain: true, action: parseContinueActionOption('apply') },
          deps,
        ),
      ).rejects.toMatchObject({
        exitCode: 1,
        message: expect.stringContaining('Needs you (apply-conflict)'),
      });
      expect(read(run.dir, 'a.txt')).toBe('USER\0\ntwo\nthree\nfour\nfive\n');
      expect(headlessRuns).toHaveLength(0);
    });
  });

  it('asks for the confirmation on the run screen before it applies a run accepted as is', async () => {
    await withApplyRun({ 'a.txt': FIVE }, { sessionId: SESSION_ID }, async (run) => {
      writeFileSync(join(run.ws, 'b.txt'), 'created by the run\n');
      saveReady(run, {
        reviewStatus: 'failed',
        acceptedAsIs: { at: '2026-10-04T00:00:00.000Z', findings: ['missing test'] },
      });

      await expect(settle(run, 'apply')).rejects.toMatchObject({
        exitCode: 1,
        message: expect.stringContaining('/run accept confirm'),
      });
      expect(existsSync(join(run.dir, 'b.txt'))).toBe(false);
      expect(loadState({ projectDir: run.dir, sessionId: SESSION_ID })?.closed).toBeUndefined();
    });
  });

  it.each(['apply', 'discard'] as const)(
    'refuses --action %s on a run that is not ready to apply',
    async (action) => {
      const projectDir = makeTmpProject();
      const sessionId = `2025-04-01-not-ready-${action}`;
      const sessDir = makeSessionDir(projectDir, sessionId);
      writeLockfile(sessDir, { exitedAt: Date.now(), sessionId });
      saveState(
        { projectDir, sessionId },
        {
          ...createInitialState('test-feature'),
          ...RUN_CREW,
          phase: 'implementing',
          tasks: [makeTask()],
        },
      );

      await expect(
        continueCommand(
          sessionId,
          { projectDir, json: true, action: parseContinueActionOption(action) },
          deps,
        ),
      ).rejects.toMatchObject({
        exitCode: 1,
        message: expect.stringContaining('is not ready to apply'),
      });
      expect(loadState({ projectDir, sessionId })?.closed).toBeUndefined();
      expect(headlessRuns).toHaveLength(0);
    },
  );
});
