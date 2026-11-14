import { afterEach, beforeEach, describe, expect, it, type MockInstance, vi } from 'vitest';
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
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
import { fixCyclesOf, type WorkflowState } from '../../../core/schemas/workflow/state.js';
import { CONFIG_FILE, SPLITBRIEF_DIR, sessionDir } from '../../../core/paths.js';
import { readSpecFile, writeSpecFile } from '../../../core/sessions/spec-files.js';
import { buildReviewFailedRecoveryIssue } from '../../../engine/orchestrator/recovery/builders/review-failed.js';
import { buildReviewInputTooLargeRecoveryIssue } from '../../../engine/orchestrator/recovery/builders/review-input.js';
import type { PrepareExecutionInput } from '../../../engine/runners/prepare-execution/prepare.js';
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
import { parseContinueActionOption } from '../../options/continue-action.js';
import type { RecoveryIssue } from '../../../core/schemas/recovery/schemas.js';
import { saveDetectionCache } from '../../../engine/detection/cache/store.js';
import * as entry from '../../../engine/orchestrator/approval/file-snapshots/entry/write.js';
import { deriveRunStatus } from '../../../core/sessions/run/status.js';
import { readyToApplyMessage } from '../../sessions/resolve.js';
import { readLockfile } from '../../../core/sessions/lock/file.js';
import { forgetExitInMemory } from '../../../core/sessions/lock/status.js';
import { currentProcessStartTimeMs } from '../../../lib/process/start-time.js';
import { Command } from 'commander';
import { createTestGitRepo } from '#testing/helpers/git.js';
import { setupWorkflow } from '../../setup.js';
import { registerContinueCommand } from './register.js';
import { testCliSeats } from '#testing/helpers/runner-gate.js';

vi.mock(
  '../../../engine/orchestrator/approval/file-snapshots/entry/write.js',
  async (importOriginal) => {
    const actual =
      await importOriginal<
        typeof import('../../../engine/orchestrator/approval/file-snapshots/entry/write.js')
      >();
    return { ...actual, writeConfinedEntryOrLink: vi.fn(actual.writeConfinedEntryOrLink) };
  },
);

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
  forgetExitInMemory(sessDir);
  const data = {
    version: 1,
    pid: process.pid,
    startTimeMs: currentProcessStartTimeMs(),
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
      cliSeats: testCliSeats([]),
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

const RETIRED_NOTICE = 'workflow.mode was retired and is ignored';

/** A stopped run whose config still carries the retired `workflow.mode` key. */
function sessionWithRetiredKey(sessionId: string): string {
  const projectDir = makeTmpProject();
  const sessDir = makeSessionDir(projectDir, sessionId);
  writeLockfile(sessDir, { exitedAt: Date.now(), sessionId });
  writeState(sessDir, 'implementing');
  writeConfig(projectDir, makeConfig());
  const configFile = join(projectDir, SPLITBRIEF_DIR, CONFIG_FILE);
  const yaml = YAML.parse(readFileSync(configFile, 'utf8'));
  writeFileSync(configFile, YAML.stringify({ ...yaml, workflow: { mode: 'instant' } }));
  return projectDir;
}

/** Continues from the command line, as `splitbrief continue <id> --project <dir>` does. */
async function continueFromCli(args: string[], continueDeps: ContinueDeps): Promise<void> {
  const program = new Command();
  program.exitOverride();
  registerContinueCommand(program, continueDeps);
  await program.parseAsync(['continue', ...args], { from: 'user' });
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

  it('refuses a run another window still runs with the one text', async () => {
    const projectDir = makeTmpProject();
    const sessionId = '2025-04-01-still-running';
    const sessDir = makeSessionDir(projectDir, sessionId);
    writeLockfile(sessDir, { sessionId });
    writeState(sessDir, 'implementing');

    await expect(continueCommand(sessionId, { projectDir }, deps)).rejects.toThrow(
      `Run ${sessionId} is still running. Stop it in the window that runs it, then run 'splitbrief continue ${sessionId}'.`,
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

  it('names the halted seat as the seat left when a save under the halt moved the config', async () => {
    const projectDir = makeTmpProject();
    const sessionId = '2026-10-21-switch-after-save';
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
          reason: 'runner-usage-limit',
          seat: 'build',
          availableActions: ['retry-same-worker', 'switch-seat', 'end-run'],
          recommendedAction: 'switch-seat',
          switchSeat: {
            seat: 'build',
            from: { tool: 'codex' },
            candidates: [{ tool: 'claude-code' }],
          },
        }),
      },
    );
    // A `/crew` save while the halt waits moves the BUILD seat to OpenCode.
    writeConfig(projectDir, makeConfig({ implementer: { kind: 'cli', tool: 'opencode' } }));

    await continueCommand(
      sessionId,
      { projectDir, json: true, action: parseContinueActionOption('switch-seat:claude-code') },
      deps,
    );

    expect(loadState({ projectDir, sessionId })?.seatSwitches).toEqual([
      expect.objectContaining({ fromSeat: { tool: 'codex' }, toSeat: { tool: 'claude-code' } }),
    ]);
    expect(headlessRuns).toHaveLength(1);
  });

  it('keeps the brief on the named BUILD profile it halted on when the seat moves headlessly', async () => {
    const projectDir = makeTmpProject();
    const sessionId = '2026-10-21-switch-on-profile';
    const sessDir = makeSessionDir(projectDir, sessionId);
    writeLockfile(sessDir, { exitedAt: Date.now(), sessionId });
    writeConfig(
      projectDir,
      makeConfig({
        implementer: { kind: 'cli', tool: 'codex' },
        implementerProfiles: {
          default: 'big',
          profiles: {
            big: { kind: 'cli', tool: 'codex' },
            small: { kind: 'cli', tool: 'opencode' },
          },
        },
      }),
    );
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
          selectedImplementerProfile: 'small',
          availableActions: ['retry-same-worker', 'switch-seat', 'end-run'],
          recommendedAction: 'switch-seat',
          switchSeat: { seat: 'build', candidates: [{ tool: 'claude-code' }] },
        }),
      },
    );

    await continueCommand(
      sessionId,
      { projectDir, json: true, action: parseContinueActionOption('switch-seat:claude-code') },
      deps,
    );

    const pin = { taskId: 'T001', profile: 'small' };
    expect(loadState({ projectDir, sessionId })?.retryProfile).toEqual(pin);
    expect(headlessRuns).toHaveLength(1);
    expect(headlessRuns[0]?.state?.retryProfile).toEqual(pin);
    const yaml = YAML.parse(readFileSync(join(projectDir, SPLITBRIEF_DIR, CONFIG_FILE), 'utf8'));
    expect(yaml.implementer_profiles).toMatchObject({
      default: 'big',
      profiles: { big: { tool: 'codex' }, small: { tool: 'claude-code' } },
    });
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

  it('ends a run saved as v3 and saves the close as v4', async () => {
    const projectDir = makeTmpProject();
    const sessionId = '2025-04-01-end-v3-run';
    const sessDir = makeSessionDir(projectDir, sessionId);
    writeLockfile(sessDir, { exitedAt: Date.now(), sessionId });
    reactivateExistingSession({ projectDir, sessionId });
    writeState(sessDir, 'reviewing-briefs', RUN_CREW);
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

    try {
      await continueCommand(
        sessionId,
        { projectDir, plain: true, action: parseContinueActionOption('end-run') },
        deps,
      );
    } finally {
      logSpy.mockRestore();
    }

    expect(JSON.parse(readFileSync(join(sessDir, 'state.json'), 'utf8'))).toMatchObject({
      stateVersion: 4,
      closed: { as: 'ended' },
    });
    expect(readSession({ projectDir, sessionId })?.status).toBe('ended');
    expect(headlessRuns).toHaveLength(0);
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

  describe('diagnostics before the screen mounts', () => {
    let stderrSpy: MockInstance<typeof process.stderr.write>;

    beforeEach(() => {
      stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    });

    afterEach(() => {
      stderrSpy.mockRestore();
    });

    function onStderr(text: string): number {
      return stderrSpy.mock.calls.filter(([chunk]) => String(chunk).includes(text)).length;
    }

    const RETIRED_WARNING = [
      expect.arrayContaining([
        { kind: 'retired-value', notice: expect.stringContaining(RETIRED_NOTICE) },
      ]),
    ];

    it('hands a notice its own config raises to the run preparation and writes none to stderr when the continue mounts the screen', async () => {
      const projectDir = sessionWithRetiredKey('2025-04-01-config-notice');
      const preparations: PrepareExecutionInput[] = [];

      await continueFromCli(
        ['2025-04-01-config-notice', '--project', projectDir],
        createDeps({
          prepareExecution: async (input) => {
            preparations.push(input);
            return prepareResume(input);
          },
        }),
      );

      expect(renderRuns).toHaveLength(1);
      expect(onStderr(RETIRED_NOTICE)).toBe(0);
      expect(preparations.map((input) => input.configWarnings)).toEqual(RETIRED_WARNING);
    });

    it('hands a notice its own config raises to the run preparation and writes none to stderr when the continue fails before the screen mounts', async () => {
      const projectDir = sessionWithRetiredKey('2025-04-01-config-notice-refused');
      const preparations: PrepareExecutionInput[] = [];

      await expect(
        continueFromCli(
          ['2025-04-01-config-notice-refused', '--project', projectDir],
          createDeps({
            prepareExecution: async (input) => {
              preparations.push(input);
              throw new Error('refused');
            },
          }),
        ),
      ).rejects.toThrow('refused');

      expect(onStderr(RETIRED_NOTICE)).toBe(0);
      expect(preparations.map((input) => input.configWarnings)).toEqual(RETIRED_WARNING);
    });

    it('hands a notice its own config raises to the run preparation and writes none to stderr when the continue has no screen', async () => {
      const projectDir = sessionWithRetiredKey('2025-04-01-config-notice-headless');
      const preparations: PrepareExecutionInput[] = [];
      let writtenAtOnce = -1;

      await continueFromCli(
        ['2025-04-01-config-notice-headless', '--json', '--project', projectDir],
        createDeps({
          prepareExecution: async (input) => {
            preparations.push(input);
            return prepareResume(input);
          },
          runHeadless: async () => {
            writtenAtOnce = onStderr(RETIRED_NOTICE);
          },
        }),
      );

      expect(writtenAtOnce).toBe(0);
      expect(onStderr(RETIRED_NOTICE)).toBe(0);
      expect(preparations.map((input) => input.configWarnings)).toEqual(RETIRED_WARNING);
    });

    it('writes a --project warning for a folder inside the repository to stderr once', async () => {
      const projectDir = realpathSync(makeTmpProject());
      createTestGitRepo(projectDir);
      const subdir = join(projectDir, 'pkg');
      mkdirSync(subdir);
      const sessDir = makeSessionDir(projectDir, '2025-04-01-project-subdir');
      writeLockfile(sessDir, { exitedAt: Date.now(), sessionId: '2025-04-01-project-subdir' });
      writeState(sessDir, 'implementing');
      writeConfig(projectDir, makeConfig());
      const warning = `--project ${subdir} is inside git repository ${projectDir}; using repository root.`;

      await continueFromCli(
        ['2025-04-01-project-subdir', '--project', subdir],
        createDeps({ setupWorkflow }),
      );

      expect(onStderr(warning)).toBe(1);
    });
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

  it('keeps the words of a task written on two lines apart on the resume status line, with no phase id', async () => {
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

    expect(logged.find((line) => line.includes('Resuming:'))).toBe(
      'Resuming: Add fixtures, as one task (task 1/1)',
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

describe('continueCommand --action accept-as-is|apply|apply-as-is|discard|end-run', () => {
  const SESSION_ID = '2026-10-04-ready-run';
  const FIVE = 'one\ntwo\nthree\nfour\nfive\n';
  const read = (root: string, file: string): string => readFileSync(join(root, file), 'utf8');
  const HALTED_AT = '2026-10-04T00:00:00.000Z';
  const ACCEPTED = {
    at: HALTED_AT,
    findings: ['missing test'],
    redChecks: [{ id: 'V1', command: 'npm test', lastLine: 'Error: 2 specs failed' }],
  } satisfies NonNullable<WorkflowState['acceptedAsIs']>;
  const ACCEPTED_SENTENCE =
    'Run accepted as is with 1 red check and 1 open finding: V1 failed · npm test · Error: 2 specs failed; missing test.';
  const APPLY_AS_IS = `splitbrief continue ${SESSION_ID} --action apply-as-is`;
  const stateFile = (projectDir: string): string =>
    readFileSync(join(sessionDir(projectDir, SESSION_ID), 'state.json'), 'utf8');

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

  /**
   * A final review that failed on one finding while the check V1 is red: the halt that offers
   * Accept as is. `review.md` holds what the review wrote.
   */
  function saveRedHalt(projectDir: string, overrides: Partial<WorkflowState> = {}): void {
    const ref = { projectDir, sessionId: SESSION_ID };
    saveState(
      ref,
      makeWorkflowState({
        ...RUN_CREW,
        phase: 'complete',
        reviewStatus: 'failed',
        tasks: [makeTask({ status: 'done' })],
        review: {
          cycle: 0,
          at: HALTED_AT,
          outcome: 'fail',
          verification: [],
          redInputs: [{ id: 'V1.1', text: 'npm test failed in src/hello.test.ts' }],
          verdict: {
            tasks: [{ id: makeTask().id, plan: 'met', note: '' }],
            criteria: [],
            findings: [
              {
                id: 'F1',
                kind: 'defect',
                severity: 'blocking',
                taskId: null,
                file: null,
                line: null,
                text: 'missing test',
                acceptance: null,
                checkIds: null,
                criterionId: null,
              },
            ],
          },
        },
        pendingTriage: {
          inputs: [
            {
              id: 'V1.1',
              kind: 'defect',
              source: 'check',
              text: 'npm test failed in src/hello.test.ts',
              file: 'src/hello.test.ts',
              checkIds: ['V1'],
              command: 'npm test',
              output: 'RUN v4\nError: 2 specs failed\n',
            },
          ],
        },
        pendingRecovery: buildReviewFailedRecoveryIssue({
          blocking: 2,
          phase: 'complete',
          createdAt: HALTED_AT,
          acceptAsIs: true,
        }),
        ...overrides,
      }),
    );
    writeSpecFile(ref, 'review.md', '### Verdict\n\nfail\n');
  }

  /** A stopped run with no workspace: its briefs wrote into the project folder. */
  function stoppedProject(): string {
    const projectDir = makeTmpProject();
    writeLockfile(makeSessionDir(projectDir, SESSION_ID), {
      exitedAt: Date.now(),
      sessionId: SESSION_ID,
    });
    return projectDir;
  }

  /** A task review too large to send, halted between two briefs: its accept skips that review. */
  function saveTooLargeTaskReview(projectDir: string): RecoveryIssue {
    const issue = buildReviewInputTooLargeRecoveryIssue({
      phase: 'implementing',
      failure: {
        kind: 'input-too-large',
        figures: { unit: 'characters', size: 900_000, limit: 400_000 },
        promptSize: { characters: 900_000 },
        changeFile: '.splitbrief/reviews/run-1.diff',
        workspaceDir: projectDir,
      },
      tool: 'codex',
      acceptAsIs: true,
      createdAt: HALTED_AT,
    });
    saveState(
      { projectDir, sessionId: SESSION_ID },
      makeWorkflowState({
        ...RUN_CREW,
        phase: 'implementing',
        tasks: [makeTask({ status: 'done' }), makeTask({ id: 'T002', dependsOn: ['T001'] })],
        pendingScheduledReview: { afterTaskId: makeTask().id },
        pendingRecovery: issue,
      }),
    );
    return issue;
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

  async function settle(
    run: Pick<ApplyRun, 'dir'>,
    action: 'accept-as-is' | 'apply' | 'apply-as-is' | 'discard' | 'restore',
    flags: { json?: true } = { json: true },
  ): Promise<void> {
    await continueCommand(
      SESSION_ID,
      { projectDir: run.dir, ...flags, action: parseContinueActionOption(action) },
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

  it('refuses Apply on a project config that does not load: the checkout and the run stay as they were', async () => {
    await withApplyRun({ 'a.txt': FIVE }, { sessionId: SESSION_ID }, async (run) => {
      writeFileSync(join(run.ws, 'a.txt'), 'ONE\ntwo\nthree\nfour\nfive\n');
      saveReady(run);
      mkdirSync(join(run.dir, SPLITBRIEF_DIR), { recursive: true });
      writeFileSync(join(run.dir, SPLITBRIEF_DIR, CONFIG_FILE), 'version: 99\n');
      const output = captureOutput();

      try {
        await expect(settle(run, 'apply')).rejects.toThrow('Unsupported config version: 99');
      } finally {
        output.restore();
      }

      expect(read(run.dir, 'a.txt')).toBe(FIVE);
      expect(loadState({ projectDir: run.dir, sessionId: SESSION_ID })?.closed).toBeUndefined();
      expect(readSession({ projectDir: run.dir, sessionId: SESSION_ID })?.apply).toBeUndefined();
    });
  });

  it('finishes an Apply a SIGTERM reaches, records the exit and exits 143', async () => {
    await withApplyRun({ 'a.txt': FIVE }, { sessionId: SESSION_ID }, async (run) => {
      writeFileSync(join(run.ws, 'b.txt'), 'created by the run\n');
      saveReady(run);
      const actual = await vi.importActual<typeof entry>(
        '../../../engine/orchestrator/approval/file-snapshots/entry/write.js',
      );
      vi.mocked(entry.writeConfinedEntryOrLink).mockImplementationOnce(async (...args) => {
        process.emit('SIGTERM', 'SIGTERM');
        return actual.writeConfinedEntryOrLink(...args);
      });
      const output = captureOutput();
      let exitCode: typeof process.exitCode;

      try {
        await settle(run, 'apply');
      } finally {
        output.restore();
        exitCode = process.exitCode;
        process.exitCode = undefined;
      }

      expect(exitCode).toBe(143);
      expect(output.stderr()).toBe('Applied 1 file to your checkout.\n');
      expect(read(run.dir, 'b.txt')).toBe('created by the run\n');
      expect(loadState({ projectDir: run.dir, sessionId: SESSION_ID })?.closed?.as).toBe('applied');
      expect(readLockfile(sessionDir(run.dir, SESSION_ID))?.exitedAt).toBeTypeOf('number');
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

  it.each([
    { edited: undefined, said: 'Restored 1 file in your checkout.', a: FIVE },
    { edited: 'mine a\n', said: 'Restored 0 files in your checkout.', a: 'mine a\n' },
  ])(
    'restores a partial Apply at rest and says how many files it put back (checkout edited: $edited)',
    async ({ edited, said, a }) => {
      await withApplyRun(
        { 'a.txt': FIVE, 'b.txt': 'base b\n' },
        { sessionId: SESSION_ID },
        async (run) => {
          writeFileSync(join(run.ws, 'a.txt'), 'ours a\n');
          writeFileSync(join(run.ws, 'b.txt'), 'ours b\n');
          saveReady(run);
          const actual = await vi.importActual<typeof entry>(
            '../../../engine/orchestrator/approval/file-snapshots/entry/write.js',
          );
          vi.mocked(entry.writeConfinedEntryOrLink).mockImplementation(
            async (root, path, ...rest) => {
              if (root === run.dir && path === 'b.txt') throw new Error('disk full');
              return actual.writeConfinedEntryOrLink(root, path, ...rest);
            },
          );
          const halted = captureOutput();
          try {
            await expect(settle(run, 'apply')).rejects.toMatchObject({ exitCode: 1 });
          } finally {
            halted.restore();
            vi.mocked(entry.writeConfinedEntryOrLink).mockImplementation(
              actual.writeConfinedEntryOrLink,
            );
          }
          expect(read(run.dir, 'a.txt')).toBe('ours a\n');
          if (edited !== undefined) writeFileSync(join(run.dir, 'a.txt'), edited);
          const output = captureOutput();

          try {
            await settle(run, 'restore');
          } finally {
            output.restore();
          }

          const state = loadState({ projectDir: run.dir, sessionId: SESSION_ID });
          if (state === null) throw new Error('The restored run has no saved state');
          expect(output.stderr()).toContain(`${said}\n${readyToApplyMessage(SESSION_ID, state)}\n`);
          if (edited !== undefined)
            expect(output.stderr()).toContain('left as you changed them: a.txt');
          expect(read(run.dir, 'a.txt')).toBe(a);
          expect(read(run.dir, 'b.txt')).toBe('base b\n');
          expect(deriveRunStatus({ reviewNone: false, state, liveness: 'not-alive' }).kind).toBe(
            'ready-to-apply',
          );
          expect(headlessRuns).toHaveLength(0);
          expect(renderRuns).toHaveLength(0);
        },
      );
    },
  );

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

  it.each(['none', 'passed'] as const)(
    'carries a run that ended with review status %s into its checks only when REVIEW is None at Apply',
    async (reviewStatus) => {
      await withApplyRun({ 'a.txt': FIVE }, { sessionId: SESSION_ID }, async (run) => {
        writeConfig(run.dir, makeConfig({ reviewer: 'none' }));
        writeFileSync(join(run.ws, 'a.txt'), 'ONE\ntwo\nthree\nfour\nfive\n');
        writeFileSync(join(run.dir, 'a.txt'), 'one\ntwo\nthree\nfour\nFIVE\n');
        saveReady(run, { reviewStatus });
        const output = captureOutput();

        try {
          await settle(run, 'apply');
        } finally {
          output.restore();
        }

        expect(output.stderr()).toContain(
          `Your checkout changed files run ${SESSION_ID} changed too; the merged result goes through its checks again.\n`,
        );
        expect(headlessRuns).toHaveLength(1);
        const rechecking = headlessRuns[0]?.state;
        expect(rechecking?.applyReview).toBeDefined();
        expect(rechecking && fixCyclesOf(rechecking).used).toBe(0);
      });
    },
  );

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

  it('refuses a plain apply on a run accepted as is and names --action apply-as-is', async () => {
    await withApplyRun({ 'a.txt': FIVE }, { sessionId: SESSION_ID }, async (run) => {
      writeFileSync(join(run.ws, 'b.txt'), 'created by the run\n');
      saveReady(run, { reviewStatus: 'failed', acceptedAsIs: ACCEPTED });
      const before = stateFile(run.dir);
      const output = captureOutput();

      try {
        await expect(settle(run, 'apply')).rejects.toMatchObject({
          exitCode: 1,
          message: `Run ${SESSION_ID} was accepted as is with 1 red check and 1 open finding; apply it as is with: ${APPLY_AS_IS}`,
        });
      } finally {
        output.restore();
      }

      expect(output.stderr()).toBe('');
      expect(output.stdout()).toBe('');
      expect(stateFile(run.dir)).toBe(before);
      expect(existsSync(join(run.dir, 'b.txt'))).toBe(false);
    });
  });

  it('applies a run accepted as is on apply-as-is: what the accept left open comes before the Apply line', async () => {
    await withApplyRun({ 'a.txt': FIVE }, { sessionId: SESSION_ID }, async (run) => {
      writeFileSync(join(run.ws, 'b.txt'), 'created by the run\n');
      saveReady(run, { reviewStatus: 'failed', acceptedAsIs: ACCEPTED });
      const ref = { projectDir: run.dir, sessionId: SESSION_ID };
      const output = captureOutput();

      try {
        await expect(settle(run, 'apply-as-is')).resolves.toBeUndefined();
      } finally {
        output.restore();
      }

      expect(output.stderr()).toBe(`${ACCEPTED_SENTENCE}\nApplied 1 file to your checkout.\n`);
      expect(output.stdout()).toBe('');
      expect(read(run.dir, 'b.txt')).toBe('created by the run\n');
      expect(loadState(ref)?.closed?.as).toBe('applied');
      expect(readSession(ref)?.apply).toBe('applied');
      expect(headlessRuns).toHaveLength(0);
      expect(renderRuns).toHaveLength(0);
    });
  });

  it('refuses apply-as-is on a ready run that was not accepted as is and names --action apply', async () => {
    await withApplyRun({ 'a.txt': FIVE }, { sessionId: SESSION_ID }, async (run) => {
      writeFileSync(join(run.ws, 'b.txt'), 'created by the run\n');
      saveReady(run);
      const before = stateFile(run.dir);
      const output = captureOutput();

      try {
        await expect(settle(run, 'apply-as-is')).rejects.toMatchObject({
          exitCode: 1,
          message: `Run ${SESSION_ID} was not accepted as is; apply it with: splitbrief continue ${SESSION_ID} --action apply`,
        });
      } finally {
        output.restore();
      }

      expect(output.stderr()).toBe('');
      expect(output.stdout()).toBe('');
      expect(stateFile(run.dir)).toBe(before);
      expect(existsSync(join(run.dir, 'b.txt'))).toBe(false);
    });
  });

  it('accepts the failed final review of a worktree run as is: the red check is recorded and the run is ready to apply as is', async () => {
    await withApplyRun({ 'a.txt': FIVE }, { sessionId: SESSION_ID }, async (run) => {
      writeFileSync(join(run.ws, 'b.txt'), 'created by the run\n');
      saveRedHalt(run.dir, { workspace: run.workspace });
      const ref = { projectDir: run.dir, sessionId: SESSION_ID };
      const output = captureOutput();

      try {
        await expect(settle(run, 'accept-as-is')).resolves.toBeUndefined();
      } finally {
        output.restore();
      }

      const state = loadState(ref);
      expect(state?.acceptedAsIs).toEqual({ ...ACCEPTED, at: expect.any(String) });
      expect(state?.pendingRecovery).toBeUndefined();
      expect(
        output
          .stdout()
          .trimEnd()
          .split('\n')
          .map((line) => JSON.parse(line)),
      ).toEqual([
        expect.objectContaining({
          type: 'ready_to_apply',
          sessionId: SESSION_ID,
          override: true,
          applyCommand: APPLY_AS_IS,
        }),
      ]);
      expect(output.stderr()).toBe(
        `${ACCEPTED_SENTENCE}\nRun ${SESSION_ID} is ready to apply.\nApply with: ${APPLY_AS_IS}\nDiscard with: splitbrief continue ${SESSION_ID} --action discard\n`,
      );
      expect(readSession(ref)?.apply).toBe('ready');
      expect(readSpecFile(ref, 'review.md')).toContain(
        '- V1 failed · npm test · Error: 2 specs failed',
      );
      expect(existsSync(join(run.dir, 'b.txt'))).toBe(false);
      expect(headlessRuns).toHaveLength(0);
      expect(renderRuns).toHaveLength(0);
    });
  });

  it('accepts the failed final review of a run with no workspace as is, with no terminal: the run closes', async () => {
    const projectDir = stoppedProject();
    const ref = { projectDir, sessionId: SESSION_ID };
    reactivateExistingSession(ref);
    saveRedHalt(projectDir);
    delete (process.stdin as { isTTY?: boolean }).isTTY;
    const output = captureOutput();
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    let logged: string[] = [];

    try {
      await expect(settle({ dir: projectDir }, 'accept-as-is', {})).resolves.toBeUndefined();
    } finally {
      logged = logSpy.mock.calls.map((call) => call.join(' '));
      logSpy.mockRestore();
      output.restore();
    }

    expect(logged).toEqual([`Run ${SESSION_ID} closed. The files it wrote are still on disk.`]);
    expect(output.stderr()).toBe(`${ACCEPTED_SENTENCE}\n`);
    expect(output.stdout()).toBe('');
    expect(loadState(ref)?.acceptedAsIs).toEqual({ ...ACCEPTED, at: expect.any(String) });
    expect(loadState(ref)?.pendingRecovery).toBeUndefined();
    expect(readSession(ref)?.status).toBe('complete');
    expect(readActive(projectDir)).toBeNull();
    expect(headlessRuns).toHaveLength(0);
    expect(renderRuns).toHaveLength(0);
  });

  it.each([
    {
      on: 'a halt that does not offer the row',
      halt: (run: ApplyRun) =>
        saveRedHalt(run.dir, {
          workspace: run.workspace,
          pendingRecovery: buildReviewFailedRecoveryIssue({
            blocking: 2,
            phase: 'complete',
            createdAt: HALTED_AT,
          }),
        }),
      message: 'Recovery action "accept-as-is" is not available for review-failed.',
    },
    {
      on: 'a ready run with no halt',
      halt: (run: ApplyRun) => saveReady(run),
      message: 'No pending recovery issue is available.',
    },
  ])('refuses accept-as-is on $on and writes nothing', async ({ halt, message }) => {
    await withApplyRun({ 'a.txt': FIVE }, { sessionId: SESSION_ID }, async (run) => {
      writeFileSync(join(run.ws, 'b.txt'), 'created by the run\n');
      halt(run);
      const before = stateFile(run.dir);
      const output = captureOutput();

      try {
        await expect(settle(run, 'accept-as-is')).rejects.toMatchObject({ exitCode: 1, message });
      } finally {
        output.restore();
      }

      expect(output.stderr()).toBe('');
      expect(output.stdout()).toBe('');
      expect(stateFile(run.dir)).toBe(before);
      expect(read(run.dir, 'a.txt')).toBe(FIVE);
      expect(existsSync(join(run.dir, 'b.txt'))).toBe(false);
      expect(headlessRuns).toHaveLength(0);
    });
  });

  it('accepts a task review too large to send and carries the run on', async () => {
    const projectDir = stoppedProject();
    const issue = saveTooLargeTaskReview(projectDir);
    const output = captureOutput();

    try {
      await expect(settle({ dir: projectDir }, 'accept-as-is')).resolves.toBeUndefined();
    } finally {
      output.restore();
    }

    expect(headlessRuns).toHaveLength(1);
    const resumed = headlessRuns[0]?.state;
    expect(resumed?.phase).toBe('implementing');
    expect(resumed?.pendingRecovery).toBeUndefined();
    expect(resumed?.pendingScheduledReview).toBeUndefined();
    expect(resumed?.acceptedAsIs).toEqual({ at: expect.any(String), findings: [issue.message] });
    expect(output.stderr()).not.toContain('Run accepted as is');
  });

  it('refuses the accept of a task review too large to send without a terminal before the accept writes', async () => {
    const projectDir = stoppedProject();
    saveTooLargeTaskReview(projectDir);
    const before = stateFile(projectDir);
    delete (process.stdin as { isTTY?: boolean }).isTTY;

    await expect(settle({ dir: projectDir }, 'accept-as-is', {})).rejects.toMatchObject({
      exitCode: 1,
      message: expect.stringContaining('interactive mode needs a TTY — use --json or --plain'),
    });
    expect(stateFile(projectDir)).toBe(before);
    expect(headlessRuns).toHaveLength(0);
    expect(renderRuns).toHaveLength(0);
  });

  it.each([
    ['apply', 'whose review passed'],
    ['apply-as-is', 'that was accepted as is'],
    ['discard', 'whose review passed'],
  ] as const)(
    'refuses --action %s on a run that is not ready to apply',
    async (action, settles) => {
      const projectDir = stoppedProject();
      saveState(
        { projectDir, sessionId: SESSION_ID },
        {
          ...createInitialState('test-feature'),
          ...RUN_CREW,
          phase: 'implementing',
          tasks: [makeTask()],
        },
      );
      const before = stateFile(projectDir);

      await expect(settle({ dir: projectDir }, action)).rejects.toMatchObject({
        exitCode: 1,
        message: `Run ${SESSION_ID} is not ready to apply; --action ${action} settles a run ${settles} in its workspace.`,
      });
      expect(stateFile(projectDir)).toBe(before);
      expect(headlessRuns).toHaveLength(0);
    },
  );
});
