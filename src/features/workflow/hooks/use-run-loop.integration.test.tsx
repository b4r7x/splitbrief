import { plainUserMessage, type UserMessageInput } from '../../../core/types/user-input.js';
import { useEffect } from 'react';
import { makeRunRecord } from '#testing/helpers/factories/run-record.js';
import type { RunRecord } from '../../../core/sessions/run-record.js';
import { routerStore } from '../../../stores/navigation/router.js';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { render } from 'ink-testing-library';
import { Box, Text } from 'ink';
import { chmodSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createTempDir, cleanupTempDir } from '#testing/helpers/temp-dir.js';
import { tick } from '#testing/helpers/ink.js';
import { execFileSync } from 'node:child_process';
import { makeConfig } from '#testing/helpers/factories/config.js';
import { makeRecoveryIssue } from '#testing/helpers/factories/recovery.js';
import { makeSummary } from '#testing/helpers/factories/summary.js';
import { makeSession } from '#testing/helpers/factories/session.js';
import { makeTask } from '#testing/helpers/factories/task.js';
import { makeImplState, RUN_CREW } from '#testing/helpers/factories/workflow-state.js';
import { makePreparedExecution } from '#testing/helpers/factories/prepared-execution.js';
import type { Config } from '../../../core/schemas/config.js';
import type { Implementer } from '../../../engine/implementers/types.js';
import type { ClarificationQuestion } from '../../../core/schemas/question.js';
import { questionsText } from '../../../core/state/planning-conversation.js';
import type { PlannerConfig } from '../../../core/schemas/planner-config.js';
import { buildContextOverflowRecoveryIssue } from '../../../engine/orchestrator/recovery/builders/task.js';
import { buildRequiredChecksUnrunnableRecoveryIssue } from '../../../engine/orchestrator/recovery/builders/checks.js';
import { writeConfig } from '../../../core/config/load/io.js';
import { readConfigDocument } from '../../../core/config/load/document.js';
import { makeImplementer, makePlanner } from '#testing/helpers/orchestrator-factories.js';
import {
  cliDetectionFor,
  cliDetectionsFor,
  rememberDetectedTools,
} from '#testing/helpers/factories/detection.js';
import { detectionStore } from '../../../stores/project/detection.js';
import { runWorkflow } from '../../../engine/orchestrator/run/workflow.js';
import { createRunIsolation } from '../../../engine/orchestrator/isolation/create.js';
import { readWorkspaceRecord } from '../../../engine/orchestrator/isolation/retention.js';
import { createSnapshot } from '../../../engine/snapshots/create.js';
import { readRunEvents } from '../../../engine/events/replay.js';
import type { PrepareExecutionInput } from '../../../engine/runners/prepare-execution/prepare-execution.js';
import {
  parsePreparedConfig,
  type PreparedExecution,
} from '../../../engine/runners/prepared-execution.js';
import { plainAnswer, useInputMode, type QuestionAnswer } from './use-input-mode.js';
import { useRunContinue } from './use-run-continue.js';
import { useRunLoop } from './use-run-loop.js';
import { addEvent } from '../../../stores/workflow/actions/event.js';
import { resetWorkflow } from '../../../stores/workflow/actions/reset.js';
import { lifecycleStore } from '../../../stores/workflow/lifecycle.js';
import { eventsStore } from '../../../stores/workflow/events.js';
import { controlsStore } from '../../../stores/ui/controls.js';
import { feedbackStore } from '../../../stores/ui/feedback.js';
import { overlayStore } from '../../../stores/ui/overlay.js';
import { pickerViewStore } from '../../../stores/ui/picker-view.js';
import { terminalSizeStore } from '../../../stores/ui/terminal-size.js';
import { ToolModelPicker } from '../../../app/overlays/runners.js';
import { toolRowFocus } from '../../../core/navigation/types.js';
import { configStore } from '../../../stores/project/config.js';
import {
  abortTurn,
  requestBoundaryPause,
  requestStopNow,
  requestCancel,
  requestEndRun,
  clearAllHandlers,
} from '../handlers.js';
import { stopStore } from '../../../stores/workflow/stop.js';
import {
  reactivateExistingSession,
  readActive,
  readActiveRecord,
} from '../../../core/sessions/active-pointer.js';
import { inspectSessionLiveness } from '../../../core/sessions/liveness.js';
import { ensureSplitbriefDir, ensureSessionDir } from '../../../core/paths-io.js';
import { saveState, loadState } from '../../../core/state/persistence.js';
import { saveSummary } from '../../../core/sessions/io.js';
import { createInitialState } from '../../../core/state/machine.js';
import { sessionDir } from '../../../core/paths.js';
import type { WorkflowState } from '../../../core/schemas/workflow.js';
import type { PrepareExecutionFn, RunWorkflowFn } from './use-run-loop.js';

// Harness mounts the run loop with a bogus planner command so that
// runWorkflow exits fast via the "planner not available" branch in
// initializeWorkflow. That keeps the hook's React-side lifecycle observable
// (reset, resume, rewind, cancel) without requiring a full engine spin-up.
// A run started here is admitted again before it re-enters the engine; the
// harness admits the same session, since admitting real tools is the
// preparation suite's concern.

interface RunnerHandle {
  handleResume: (message?: UserMessageInput) => void;
  /** Answers the question the recovery panel is asking, as the composer would. */
  answer: (answer: QuestionAnswer) => void;
}

interface HarnessProps {
  prepared: PreparedExecution;
  steer?: UserMessageInput | undefined;
  captureRunner?: { current: RunnerHandle | null };
  runWorkflow?: RunWorkflowFn | undefined;
  prepareExecution?: PrepareExecutionFn | undefined;
  continueAtRest?: ((record: RunRecord, steer: UserMessageInput) => void) | undefined;
}

function Harness({
  prepared,
  steer,
  captureRunner,
  runWorkflow,
  prepareExecution = reprepareSameSession(),
  continueAtRest,
}: HarnessProps) {
  const inputMode = useInputMode();
  const continuation = useRunContinue({ prepared, inputMode });
  useRunLoop({
    prepared,
    steer,
    inputMode,
    continuation,
    runWorkflow,
    prepareExecution,
    continueAtRest,
  });
  useEffect(() => {
    if (captureRunner)
      captureRunner.current = {
        handleResume: continuation.handleResume,
        answer: inputMode.resolve,
      };
  });
  return (
    <Box>
      <Text>{inputMode.mode === 'normal' ? 'idle' : inputMode.hint}</Text>
    </Box>
  );
}

function renderHarness(props: HarnessProps) {
  routerStore.init({
    screen: 'workflow',
    run: makeRunRecord({ ref: props.prepared.session.ref }),
    execution: { kind: 'local', prepared: props.prepared },
  });
  return render(<Harness {...props} />);
}

/** The BUILD seat's picker the way the router mounts it: only while its overlay is open. */
function BuildSeatPicker() {
  const open = overlayStore.use((s) => s.active === 'implementer-picker');
  return open ? <ToolModelPicker slot="seat" role="implementer" /> : null;
}

/** The loop with the real BUILD seat picker beside it, so a halt's picker takes keys. */
function renderHarnessWithPicker(props: HarnessProps) {
  routerStore.init({
    screen: 'workflow',
    run: makeRunRecord({ ref: props.prepared.session.ref }),
    execution: { kind: 'local', prepared: props.prepared },
  });
  terminalSizeStore.__testReset({ cols: 120, rows: 40, isSmall: false });
  return render(
    <Box flexDirection="column">
      <Harness {...props} />
      <BuildSeatPicker />
    </Box>,
  );
}

/** The run the loop handed back to the screen: the same route, at rest, with a fresh record. */
function settledRun(): RunRecord | null {
  const route = routerStore.get();
  if (route.screen !== 'workflow' || route.execution.kind !== 'at-rest') return null;
  return route.run;
}

function preparedExecution(input: {
  projectDir: string;
  feature: string;
  sessionId?: string | undefined;
  resumeState?: WorkflowState | undefined;
  planner?: PlannerConfig | undefined;
  implementer?: Config['implementer'] | undefined;
  implementerProfiles?: Config['implementerProfiles'] | undefined;
  workflow?: Partial<Config['workflow']> | undefined;
}): PreparedExecution {
  const sessionId = input.sessionId ?? 'prepared-workflow-session';
  const ref = { projectDir: input.projectDir, sessionId };
  ensureSessionDir(input.projectDir, sessionId);
  return makePreparedExecution({
    projectDir: input.projectDir,
    sessionId,
    feature: input.feature,
    config: makeConfig({
      planner: input.planner ?? {
        kind: 'agent',
        command: 'splitbrief-non-existent-planner-x7q9',
      },
      ...(input.implementer !== undefined && { implementer: input.implementer }),
      ...(input.implementerProfiles !== undefined && {
        implementerProfiles: input.implementerProfiles,
      }),
      ...(input.workflow !== undefined && { workflow: input.workflow }),
    }),
    preparationId: `workflow-hook-${sessionId}`,
    active: reactivateExistingSession(ref),
    ...(input.resumeState !== undefined && { resumeState: input.resumeState }),
  });
}

/** Admits the same session again under the policy asked for, recording each request. */
function reprepareSameSession(requests: PrepareExecutionInput[] = []): PrepareExecutionFn {
  return async (input) => {
    requests.push(input);
    const ref = input.existingSession;
    if (ref === undefined) throw new Error('expected a preparation of an existing session');
    return {
      kind: 'prepared',
      execution: makePreparedExecution({
        projectDir: ref.projectDir,
        sessionId: ref.sessionId,
        feature: input.feature,
        config: input.effectiveConfig,
        purpose: input.policy.purpose,
        resumeState: input.resumeState,
        active: reactivateExistingSession(ref, { inspectOwner: inspectSessionLiveness }),
      }),
    };
  };
}

/**
 * The engine the loop enters, recorded pass by pass. A scripted pass stands for the engine
 * reaching a halt or a gate; every other pass is the real `runWorkflow`.
 */
function recordedEngine(script: Partial<Record<number, RunWorkflowFn>> = {}) {
  const entered: PreparedExecution[] = [];
  let returned = 0;
  const engine: RunWorkflowFn = async (options) => {
    const pass = entered.push(options.prepared);
    try {
      return await (script[pass] ?? runWorkflow)(options);
    } finally {
      returned += 1;
    }
  };
  return { engine, entered, returned: () => returned };
}

function errorMessages(): string[] {
  return eventsStore
    .get()
    .events.flatMap((event) => (event.type === 'error' ? [event.message] : []));
}

/** A run halted on a brief whose panel offers a retry, saved where the loop reads it back. */
function saveHaltedRun(sessionId: string): WorkflowState {
  const halted = makeImplState([makeTask({ id: 'T001', status: 'failed' })], {
    ...RUN_CREW,
    pendingRecovery: makeRecoveryIssue(),
  });
  saveState({ projectDir, sessionId }, halted);
  return halted;
}

/** A run whose BUILD seat halted Seat down, its panel offering Try again and a move to Claude Code. */
function saveSeatDownHalt(sessionId: string): WorkflowState {
  const halted = makeImplState([makeTask({ id: 'T001', status: 'failed' })], {
    ...RUN_CREW,
    pendingRecovery: makeRecoveryIssue({
      reason: 'runner-usage-limit',
      seat: 'build',
      availableActions: ['retry-same-worker', 'switch-seat', 'skip-current-task', 'end-run'],
      recommendedAction: 'switch-seat',
      switchSeat: { seat: 'build', candidates: [{ tool: 'claude-code' }] },
    }),
  });
  saveState({ projectDir, sessionId }, halted);
  return halted;
}

/** The config a Settings save writes while the halt waits: the BUILD seat moved to Codex. */
const CODEX_SEAT_SAVED = makeConfig({
  planner: { kind: 'agent', command: 'splitbrief-non-existent-planner-x7q9' },
  implementer: { kind: 'cli', tool: 'codex' },
});

/** The config with the BUILD seat on Claude Code, the tool the Seat down halt offers. */
const CLAUDE_CODE_SEAT_SAVED = makeConfig({
  planner: { kind: 'agent', command: 'splitbrief-non-existent-planner-x7q9' },
  implementer: { kind: 'cli', tool: 'claude-code' },
});

/** The engine entry after a halt, recording what would stop it at its first brief boundary. */
function engineEntryAfterHalt() {
  let seen: { intent: string; pausedAtBoundary: boolean | undefined; steer: string | undefined };
  const engine: RunWorkflowFn = async (options) => {
    seen = {
      intent: stopStore.get().intent,
      pausedAtBoundary: options.sinks.consumeBoundaryPause?.(),
      steer: options.steer?.text,
    };
    return makeSummary();
  };
  return { engine, seen: () => seen };
}

async function answerRecoveryPanel(
  captureRunner: NonNullable<HarnessProps['captureRunner']>,
  text: string,
): Promise<void> {
  await vi.waitFor(() => {
    expect(controlsStore.get().inputMode).toBe('question');
  });
  await tick(60);
  const runner = captureRunner.current;
  if (!runner) throw new Error('expected captureRunner.current to be populated');
  runner.answer(plainAnswer(text));
}

function userMessageEvents() {
  return eventsStore.get().events.filter((event) => event.type === 'user_message');
}

function loggedMessageRows(log: string, text: string): number {
  return log
    .split('\n')
    .filter((line) => line.includes('"kind":"message"') && line.includes(JSON.stringify(text)))
    .length;
}

let projectDir: string;

beforeEach(() => {
  projectDir = createTempDir('workflow-runner-test');
  execFileSync('git', ['init', projectDir], { stdio: 'ignore' });
  ensureSplitbriefDir(projectDir);
  resetWorkflow();
  controlsStore.reset();
  feedbackStore.reset();
  configStore.__testReset({ projectDir });
  overlayStore.reset();
  clearAllHandlers();
});

afterEach(() => {
  clearAllHandlers();
  stopStore.__testReset();
  resetWorkflow();
  controlsStore.reset();
  feedbackStore.reset();
  configStore.__testReset();
  overlayStore.reset();
  cleanupTempDir(projectDir);
});

describe('useRunLoop', () => {
  async function saveRetainedRun(sessionId: string, state: WorkflowState) {
    const ref = { projectDir, sessionId };
    ensureSessionDir(projectDir, sessionId);
    const base = await createSnapshot({ ...ref, phase: 'manual', name: 'workspace-base' });
    const isolation = createRunIsolation({ ...ref, strategy: 'staged-copy', onFallback: () => {} });
    const workspace = await isolation.acquire({ role: 'implementer', config: makeConfig() });
    await workspace.retain?.();
    await isolation.dispose();
    const retained = {
      ...state,
      workspace: {
        kind: 'staged-copy' as const,
        path: workspace.projectDir,
        base: { snapshotId: base.manifest.id, head: workspace.snapshot.head },
      },
    };
    saveState(ref, retained);
    return retained;
  }

  it.each([
    ['malformed', 'halt'],
    ['unreadable', 'halt'],
    ['malformed', 'failure'],
    ['unreadable', 'failure'],
  ] as const)(
    'settles a retained %s record at a %s without losing the handoff',
    async (record, outcome) => {
      const sessionId = `retention-${record}-${outcome}`;
      const ref = { projectDir, sessionId };
      const state = await saveRetainedRun(
        sessionId,
        makeImplState([], {
          ...RUN_CREW,
          ...(outcome === 'halt' && { pendingRecovery: makeRecoveryIssue() }),
          ...(outcome === 'failure' && {
            lastFailure: {
              message: 'call failed',
              step: { kind: 'review', cycle: 0 },
              at: '2026-10-10T00:00:00.000Z',
            },
          }),
        }),
      );
      const path = join(sessionDir(projectDir, sessionId), 'retained-workspace.json');
      if (record === 'malformed') writeFileSync(path, '{invalid');
      else chmodSync(path, 0o000);
      await expect(readWorkspaceRecord(ref)).rejects.toThrow(
        record === 'malformed' ? 'The stopped workspace could not be verified.' : 'EACCES',
      );
      const prepared = preparedExecution({
        projectDir,
        sessionId,
        feature: state.feature,
      });
      const inst = renderHarness({ prepared, runWorkflow: async () => makeSummary() });
      if (outcome === 'halt') {
        await vi.waitFor(() => expect(controlsStore.get().inputMode).toBe('question'));
        requestStopNow();
      }
      await vi.waitFor(() => expect(settledRun()?.status.kind).toBe('open'));
      expect(errorMessages()).toEqual([
        record === 'malformed'
          ? 'The stopped workspace could not be verified. Its files were left in place; automatic continuation is blocked.'
          : `permission denied · ${path}`,
      ]);
      expect(
        eventsStore
          .get()
          .events.filter(
            (event) => event.type === 'warning' && event.message.startsWith('Workspace kept at '),
          ),
      ).toEqual([]);
      expect(loadState(ref)?.pendingRecovery).toEqual(state.pendingRecovery);
      expect(loadState(ref)?.lastFailure).toEqual(state.lastFailure);
      inst.unmount();
    },
  );

  it('does not publish additional retention notices when the same halt is reopened twice', async () => {
    const sessionId = 'retained-halt-reopened-twice';
    const ref = { projectDir, sessionId };
    const initial = makeImplState([makeTask({ id: 'T001', status: 'failed' })], RUN_CREW);
    ensureSessionDir(projectDir, sessionId);
    saveState(ref, initial);
    const prepared = preparedExecution({
      projectDir,
      sessionId,
      feature: initial.feature,
      resumeState: initial,
    });
    const captureRunner: HarnessProps['captureRunner'] = { current: null };
    const run = recordedEngine({
      1: async () => {
        await saveRetainedRun(sessionId, {
          ...initial,
          pendingRecovery: makeRecoveryIssue(),
        });
        return makeSummary();
      },
    });
    const inst = renderHarness({ prepared, captureRunner, runWorkflow: run.engine });
    await vi.waitFor(() => expect(controlsStore.get().inputMode).toBe('question'));
    const halted = loadState(ref);
    const workspaceDir = halted?.workspace?.path;
    expect(workspaceDir).toBeDefined();
    const continueNotices = () =>
      eventsStore
        .get()
        .events.flatMap((event) =>
          event.type === 'warning' && event.message.startsWith('Workspace kept at ')
            ? [event.message]
            : [],
        );
    const originalNotices = [
      `Workspace kept at ${workspaceDir} for Continue, with its private CLI state and caches.`,
    ];
    expect(continueNotices()).toEqual(originalNotices);

    for (let reopen = 0; reopen < 2; reopen += 1) {
      await tick(60);
      expect(requestStopNow()).toBe(true);
      await vi.waitFor(() => {
        expect(controlsStore.get().inputMode).toBe('normal');
        expect(stopStore.get().phase).toBe('parked');
      });
      const runner = captureRunner.current;
      if (runner === null) throw new Error('expected captureRunner.current to be populated');
      stopStore.reset();
      runner.handleResume();
      await vi.waitFor(() => expect(controlsStore.get().inputMode).toBe('question'));
      expect(run.entered).toHaveLength(1);
      expect(loadState(ref)?.pendingRecovery).toEqual(halted?.pendingRecovery);
      expect(continueNotices()).toEqual(originalNotices);
    }

    requestStopNow();
    await vi.waitFor(() => expect(stopStore.get().phase).toBe('parked'));
    expect(continueNotices()).toEqual(originalNotices);
    inst.unmount();
  });

  it.each(['replayed retry', 'replayed End run', 'supplied correction'] as const)(
    'keeps retention unpublished during %s before any panel opens',
    async (decision) => {
      const sessionId = `retained-${decision.replaceAll(' ', '-')}`;
      const ref = { projectDir, sessionId };
      const correction = decision === 'supplied correction';
      const state = await saveRetainedRun(
        sessionId,
        makeImplState([makeTask({ id: 'T001', status: 'failed' })], {
          ...RUN_CREW,
          pendingRecovery: makeRecoveryIssue({
            ...(correction
              ? {
                  reason: 'plan-checks-failed',
                  taskId: undefined,
                  phase: 'planning',
                  availableActions: ['revise', 'end-run'],
                  recommendedAction: 'revise',
                }
              : {
                  status: 'applying',
                  selectedAction: decision === 'replayed retry' ? 'retry-same-worker' : 'end-run',
                }),
          }),
        }),
      );
      const prepared = preparedExecution({
        projectDir,
        sessionId,
        feature: state.feature,
        resumeState: state,
      });
      let entered = false;
      let noticesAtEntry: string[] = [];
      const inst = renderHarness({
        prepared,
        ...(correction && { steer: plainUserMessage('log the error and rethrow') }),
        runWorkflow: async () => {
          entered = true;
          noticesAtEntry = eventsStore
            .get()
            .events.flatMap((event) =>
              event.type === 'warning' && event.message.startsWith('Workspace kept at ')
                ? [event.message]
                : [],
            );
          const current = loadState(ref);
          if (current === null) throw new Error('expected resumed state');
          saveState(ref, { ...current, phase: 'complete', reviewStatus: 'passed' });
          return makeSummary();
        },
      });
      await vi.waitFor(() => expect(settledRun()).not.toBeNull());
      expect(entered).toBe(decision !== 'replayed End run');
      expect(noticesAtEntry).toEqual([]);
      expect(controlsStore.get().inputMode).not.toBe('question');
      expect(
        eventsStore
          .get()
          .events.filter(
            (event) => event.type === 'warning' && event.message.startsWith('Workspace kept at '),
          ),
      ).toEqual([]);
      expect(settledRun()?.status.kind).toBe(
        decision === 'replayed End run' ? 'closed' : 'ready-to-apply',
      );
      inst.unmount();
    },
  );

  async function automaticBalanceSwitch(outcome: 'admitted' | 'refused' | 'conflict') {
    const sessionId = `balance-${outcome}`;
    const ref = { projectDir, sessionId };
    ensureSessionDir(projectDir, sessionId);
    const config = makeConfig({
      implementer: {
        kind: 'cli',
        tool: 'opencode',
        model: 'deepseek/deepseek-flash',
        fallback: { tool: 'opencode', model: 'opencode-go/deepseek-v4.1-flash', variant: 'high' },
      },
      workflow: { isolation: 'staged-copy', approve: 'none' },
      validation: { endChecks: false, testCommand: 'true' },
    });
    writeConfig(projectDir, config);
    configStore.load(projectDir);
    const originalRawYaml = configStore.get().rawYaml;
    await rememberDetectedTools(projectDir, cliDetectionsFor('ready', ['opencode']));
    const state = makeImplState([
      makeTask({
        id: 'T001',
        action: 'create',
        suggestedFiles: ['fallback.txt'],
        scope: { inBounds: ['fallback.txt'] },
      }),
    ]);
    saveState(ref, state);
    const prepared = makePreparedExecution({
      ...ref,
      config,
      feature: state.feature,
      resumeState: state,
      active: reactivateExistingSession(ref),
    });
    const save = vi.spyOn(configStore, 'save');
    let fallbackStarted = false;
    const implementer = makeImplementer({
      implement: vi.fn<Implementer['implement']>(async (input) => {
        if (input.config.implementer.model === 'deepseek/deepseek-flash') {
          return {
            success: false,
            output: '',
            error: 'provider.quota: Insufficient Balance',
            outcome: 'usage-limit',
          };
        }
        fallbackStarted = true;
        writeFileSync(join(input.projectDir, 'fallback.txt'), 'fallback work\n');
        return { success: true, output: 'done' };
      }),
    });
    const admit = reprepareSameSession();
    const prepare: PrepareExecutionFn = async (input) => {
      if (outcome === 'refused')
        return { kind: 'blocked', report: { ...prepared.report, status: 'blocked' } };
      if (outcome === 'conflict')
        writeConfig(projectDir, {
          ...config,
          implementer: { kind: 'cli', tool: 'codex', model: 'gpt-5' },
        });
      return admit(input);
    };
    const engine: RunWorkflowFn = (options) =>
      runWorkflow({ ...options, _planner: makePlanner(), _implementer: implementer });
    const inst = renderHarness({ prepared, runWorkflow: engine, prepareExecution: prepare });
    await vi.waitFor(() => {
      if (outcome === 'admitted') expect(fallbackStarted).toBe(true);
      else expect(controlsStore.get().inputMode).toBe('question');
    });
    const workspaceDir = loadState(ref)?.workspace?.path;
    expect(workspaceDir).toBeDefined();
    return { inst, save, ref, workspaceDir, fallbackStarted, originalRawYaml };
  }

  it.each(['admitted', 'refused'] as const)(
    'publishes retention only when an automatic switch returns to the user',
    async (outcome) => {
      const { inst, save, workspaceDir } = await automaticBalanceSwitch(outcome);
      const continueNotices = eventsStore
        .get()
        .events.flatMap((event) =>
          event.type === 'warning' && event.message.startsWith('Workspace kept at ')
            ? [event.message]
            : [],
        );
      if (outcome === 'admitted') {
        const continueNoticesBeforeFallback = continueNotices;
        expect(continueNoticesBeforeFallback).toEqual([]);
        await vi.waitFor(() => expect(settledRun()).not.toBeNull());
      } else {
        expect(continueNotices).toEqual([
          `Workspace kept at ${workspaceDir} for Continue, with its private CLI state and caches.`,
        ]);
        requestStopNow();
        await vi.waitFor(() => expect(settledRun()).not.toBeNull());
        expect(
          eventsStore
            .get()
            .events.filter(
              (event) => event.type === 'warning' && event.message.startsWith('Workspace kept at '),
            ),
        ).toHaveLength(1);
      }
      inst.unmount();
      save.mockRestore();
    },
  );

  it('refreshes the displayed crew after an automatic switch without another save', async () => {
    const { inst, save } = await automaticBalanceSwitch('admitted');
    expect(configStore.get().config?.implementer).toMatchObject({
      tool: 'opencode',
      model: 'opencode-go/deepseek-v4.1-flash',
      variant: 'high',
    });
    expect(configStore.get().diskConfig?.implementer).toMatchObject({ variant: 'high' });
    expect(configStore.get().rawYaml).toContain('variant: high');
    expect(configStore.get().revision?.rawSha256).toBe(
      readConfigDocument(projectDir).revision?.rawSha256,
    );
    expect(configStore.save).not.toHaveBeenCalled();
    expect(stopStore.get().seatChange).toBe(false);
    expect(stopStore.get().intent).toBe('none');
    await vi.waitFor(() => expect(settledRun()?.status.kind).toBe('ready-to-apply'));
    inst.unmount();
    save.mockRestore();
  });

  it('refreshes a memory-only switched seat without creating a config', async () => {
    const sessionId = 'memory-only-switch';
    const ref = { projectDir, sessionId };
    ensureSessionDir(projectDir, sessionId);
    const candidate = {
      tool: 'opencode' as const,
      model: 'opencode-go/deepseek-v4.1-flash',
      variant: 'high',
    };
    const state = makeImplState([makeTask({ id: 'T001', status: 'failed' })], {
      ...RUN_CREW,
      pendingRecovery: makeRecoveryIssue({
        reason: 'runner-usage-limit',
        availableActions: ['switch-seat', 'end-run'],
        recommendedAction: 'switch-seat',
        switchSeat: { seat: 'build', candidates: [candidate] },
      }),
    });
    saveState(ref, state);
    const config = makeConfig({
      implementer: { kind: 'cli', tool: 'opencode', model: 'deepseek/deepseek-flash' },
    });
    configStore.__testReset({ projectDir, config });
    const prepared = makePreparedExecution({
      ...ref,
      config,
      feature: state.feature,
      resumeState: state,
      active: reactivateExistingSession(ref),
    });
    const captureRunner: HarnessProps['captureRunner'] = { current: null };
    const save = vi.spyOn(configStore, 'save');
    const run = recordedEngine({ 1: async () => makeSummary() });
    const inst = renderHarness({ prepared, captureRunner, runWorkflow: run.engine });
    await answerRecoveryPanel(captureRunner, 'switch');
    await vi.waitFor(() => expect(overlayStore.get().active).toBe('implementer-picker'));
    configStore.__testReset({
      projectDir,
      config: { ...config, implementer: { kind: 'cli', ...candidate } },
    });
    pickerViewStore.setCommitted(true);
    overlayStore.close();
    await vi.waitFor(() => expect(run.returned()).toBe(1));
    expect(configStore.get().config?.implementer).toMatchObject({
      tool: 'opencode',
      model: 'opencode-go/deepseek-v4.1-flash',
      variant: 'high',
    });
    expect(configStore.get().revision).toBeNull();
    expect(existsSync(join(projectDir, '.splitbrief', 'config.yaml'))).toBe(false);
    expect(configStore.save).not.toHaveBeenCalled();
    expect(run.entered[0]?.config.implementer).toMatchObject(candidate);
    await vi.waitFor(() => expect(settledRun()).not.toBeNull());
    inst.unmount();
    save.mockRestore();
  });

  it.each(['refused', 'conflict'] as const)(
    'never displays an uncommitted %s switch',
    async (outcome) => {
      const { inst, save, ref, fallbackStarted, originalRawYaml } =
        await automaticBalanceSwitch(outcome);
      expect(fallbackStarted).toBe(false);
      expect(configStore.get().config?.implementer.model).toBe('deepseek/deepseek-flash');
      expect(configStore.get().rawYaml).toBe(originalRawYaml);
      expect(loadState(ref)?.seatSwitches ?? []).toEqual([]);
      requestStopNow();
      await vi.waitFor(() => expect(settledRun()).not.toBeNull());
      inst.unmount();
      save.mockRestore();
    },
  );

  it('runs once from prepared config session report and gates', async () => {
    const prepared = preparedExecution({ projectDir, feature: 'prepared authority' });
    const received: PreparedExecution[] = [];
    const runWorkflowStub: RunWorkflowFn = vi.fn(async (options) => {
      received.push(options.prepared);
      return makeSummary();
    });

    const inst = renderHarness({ prepared, runWorkflow: runWorkflowStub });

    await vi.waitFor(() => {
      expect(received).toHaveLength(1);
    });
    await tick(60);

    const authority = received[0];
    expect(authority).toBe(prepared);
    expect(Object.isFrozen(authority?.config)).toBe(true);
    expect(runWorkflowStub).toHaveBeenCalledTimes(1);

    inst.unmount();
  });

  it('resets workflow stores on mount', async () => {
    // Seed the stores so the test proves they were reset on mount.
    lifecycleStore.__testReset({ cancelled: true, queueDepth: 5 });
    const prepared = preparedExecution({ projectDir, feature: 'add auth' });

    const inst = renderHarness({ prepared });
    await tick(60);

    expect(lifecycleStore.get().cancelled).toBe(false);
    expect(lifecycleStore.get().queueDepth).toBe(0);
    inst.unmount();
  });

  it("clears stale store state and applies the resume phase from startWorkflow's authoritative reset", async () => {
    // Seed the lifecycle store with stale data; startWorkflow's own reset is the
    // single authoritative reset.
    lifecycleStore.__testReset({ cancelled: true, queueDepth: 7, phase: 'final-review' });
    const sessionId = '2026-08-14-resume-reset';
    const resume: WorkflowState = {
      ...createInitialState('add auth'),
      ...RUN_CREW,
      phase: 'reviewing-spec',
    };
    const prepared = preparedExecution({
      projectDir,
      feature: 'add auth',
      sessionId,
      resumeState: resume,
    });
    saveState({ projectDir, sessionId }, resume);

    const inst = renderHarness({ prepared });

    // Stale fields are cleared (the reset ran) and the resume phase is applied
    // (the reset received the resume state) — one reset carries both.
    await vi.waitFor(() => {
      const lifecycle = lifecycleStore.get();
      expect(lifecycle.cancelled).toBe(false);
      expect(lifecycle.queueDepth).toBe(0);
      expect(lifecycle.phase).toBe('reviewing-spec');
    });
    inst.unmount();
  });

  it('clears session state before a missing persisted resume exits', async () => {
    lifecycleStore.__testReset({ cancelled: true, queueDepth: 7, phase: 'final-review' });
    eventsStore.__testReset({
      events: [
        {
          type: 'workflow_started',
          ts: Date.now(),
          phase: 'final-review',
          feature: 'old session',
        },
      ],
    });
    const runWorkflowStub: RunWorkflowFn = vi.fn(async () => makeSummary());
    const prepared = preparedExecution({
      projectDir,
      feature: 'new session',
      sessionId: '2026-08-14-missing-resume',
      resumeState: { ...createInitialState('new session'), ...RUN_CREW },
    });

    const inst = renderHarness({ prepared, runWorkflow: runWorkflowStub });
    await vi.waitFor(() => {
      expect(lifecycleStore.get().phase).toBe('idle');
      expect(lifecycleStore.get().cancelled).toBe(false);
    });

    expect(lifecycleStore.get().queueDepth).toBe(0);
    expect(eventsStore.get().events).toEqual([]);
    expect(runWorkflowStub).not.toHaveBeenCalled();
    inst.unmount();
  });

  it('clears session state before an invalid persisted resume exits', async () => {
    lifecycleStore.__testReset({ cancelled: true, queueDepth: 9, phase: 'implementing' });
    const sessionId = '2026-08-14-invalid-resume';
    const prepared = preparedExecution({
      projectDir,
      feature: 'invalid session',
      sessionId,
      resumeState: { ...createInitialState('invalid session'), ...RUN_CREW },
    });
    writeFileSync(
      join(sessionDir(projectDir, sessionId), 'state.json'),
      JSON.stringify({ stateVersion: 999 }),
      'utf8',
    );
    const runWorkflowStub: RunWorkflowFn = vi.fn(async () => makeSummary());

    const inst = renderHarness({ prepared, runWorkflow: runWorkflowStub });
    await vi.waitFor(() => {
      expect(lifecycleStore.get().phase).toBe('idle');
      expect(eventsStore.get().events).toEqual([
        expect.objectContaining({
          type: 'error',
          message: expect.stringContaining('Cannot resume'),
        }),
      ]);
    });

    expect(lifecycleStore.get().cancelled).toBe(false);
    expect(lifecycleStore.get().queueDepth).toBe(0);
    expect(runWorkflowStub).not.toHaveBeenCalled();
    inst.unmount();
  });

  it('settles the run at rest on the screen it is already on when the loop returns', async () => {
    const sessionId = '2026-06-18-settled-session';
    ensureSessionDir(projectDir, sessionId);
    saveSummary({ projectDir, sessionId }, makeSession({ id: sessionId, status: 'open' }));
    const runWorkflowStub: RunWorkflowFn = vi.fn(async () => makeSummary());
    const prepared = preparedExecution({ projectDir, feature: 'add auth', sessionId });

    const inst = renderHarness({ prepared, runWorkflow: runWorkflowStub });

    await vi.waitFor(() => {
      expect(settledRun()?.ref.sessionId).toBe(sessionId);
    });
    expect(routerStore.get().screen).toBe('workflow');

    inst.unmount();
  });

  it('settles a run the user stopped without parking, instead of leaving a dead screen', async () => {
    const sessionId = '2026-07-10-stopped-regen';
    ensureSessionDir(projectDir, sessionId);
    const runWorkflowStub: RunWorkflowFn = vi.fn(async (opts) => {
      // Stop now during an approval-gate regeneration: an abort handler is live
      // (runLiveRegenerate), the stop aborts the regen, and the engine run returns
      // without parking a continuation prompt or publishing a cancellation event.
      addEvent({
        type: 'workflow_started',
        ts: Date.now(),
        phase: 'reviewing-spec',
        feature: 'add auth',
      });
      opts.sinks.setAbortHandler(() => {});
      requestStopNow();
      opts.sinks.setAbortHandler(null);
      return makeSummary();
    });
    const prepared = preparedExecution({ projectDir, feature: 'add auth', sessionId });

    const inst = renderHarness({ prepared, runWorkflow: runWorkflowStub });

    await vi.waitFor(() => {
      expect(settledRun()).not.toBeNull();
    });

    inst.unmount();
  });

  it('writes the session record when a halt is answered with End run', async () => {
    const sessionId = '2024-01-01-end-run';
    ensureSessionDir(projectDir, sessionId);
    const task = makeTask({ id: 'T001' });
    const issue = buildContextOverflowRecoveryIssue({
      task,
      phase: 'implementing',
      createdAt: '2026-04-28T12:00:00.000Z',
    });
    const closed: WorkflowState = {
      ...makeImplState([task], RUN_CREW),
      pendingRecovery: { ...issue, status: 'applying', selectedAction: 'end-run' },
    };
    saveState({ projectDir, sessionId }, closed);
    const prepared = preparedExecution({
      projectDir,
      feature: 'add auth',
      sessionId,
      resumeState: closed,
    });
    const inst = renderHarness({ prepared });
    await tick(60);

    expect(existsSync(join(sessionDir(projectDir, sessionId), 'summary.json'))).toBe(true);
    expect(settledRun()?.status).toEqual({ kind: 'closed', as: 'ended' });

    inst.unmount();
  });

  it('keeps the halt and records no cut step when the run is stopped at the recovery panel', async () => {
    const sessionId = '2026-09-24-stop-at-halt';
    const halted = saveHaltedRun(sessionId);
    const prepared = preparedExecution({
      projectDir,
      feature: 'add auth',
      sessionId,
      resumeState: halted,
    });
    const runWorkflowStub: RunWorkflowFn = vi.fn(async () => makeSummary());

    const inst = renderHarness({ prepared, runWorkflow: runWorkflowStub });
    await vi.waitFor(() => {
      expect(controlsStore.get().inputMode).toBe('question');
    });
    await tick(60);
    expect(requestStopNow()).toBe(true);
    await vi.waitFor(() => {
      expect(settledRun()).not.toBeNull();
    });

    const persisted = loadState({ projectDir, sessionId });
    expect(persisted?.pendingRecovery).toEqual(halted.pendingRecovery);
    expect(persisted?.interruptedStep).toBeUndefined();
    expect(runWorkflowStub).not.toHaveBeenCalled();

    inst.unmount();
  });

  it('requestCancel marks the workflow cancelled and clears the review input mode', async () => {
    const prepared = preparedExecution({ projectDir, feature: 'add auth' });
    const inst = renderHarness({
      prepared,
      runWorkflow: async (options) => {
        await options.callbacks?.onApprovalNeeded?.('plan', 'plan.md', []);
        return makeSummary();
      },
    });
    await tick(60);

    // Simulate a pending review mode (as if the engine had called onApprovalNeeded).
    controlsStore.setInputMode('review');

    const cancelled = requestCancel();
    expect(cancelled).toBe(true);
    await tick(60);

    expect(lifecycleStore.get().cancelled).toBe(true);
    // Cancel handler registered by the runner calls inputMode.resetMode(),
    // which clears controls.inputMode back to 'normal'.
    expect(controlsStore.get().inputMode).toBe('normal');

    // A second cancel is a no-op (cancelled gate).
    const before = eventsStore.get().events.length;
    expect(requestCancel()).toBe(false);
    expect(eventsStore.get().events.length).toBe(before);

    inst.unmount();
  });

  it('requestCancel aborts the engine signal with the canonical user_cancelled reason', async () => {
    const sessionId = '2026-06-18-cancel-reason';
    const { promise: runFinished, resolve: finishRun } = Promise.withResolvers<void>();
    const runWorkflowWithCompletion: RunWorkflowFn = async (options) => {
      try {
        return await runWorkflow(options);
      } finally {
        finishRun();
      }
    };
    const prepared = preparedExecution({
      projectDir,
      feature: 'cancel reason',
      sessionId,
      planner: { kind: 'shell', command: 'sleep', args: ['10'] },
      workflow: {},
    });
    const inst = renderHarness({ prepared, runWorkflow: runWorkflowWithCompletion });
    const logPath = join(sessionDir(projectDir, sessionId), 'session.jsonl');
    await vi.waitFor(() => {
      expect(existsSync(logPath)).toBe(true);
    });

    expect(requestCancel()).toBe(true);

    await vi.waitFor(() => {
      const log = readFileSync(logPath, 'utf-8');
      expect(log).toContain('"type":"workflow_cancelled"');
      expect(log).toContain('"reason":"user_cancelled"');
    });

    await runFinished;
    inst.unmount();
  });

  it('handleResume shows a feedback error when there is no saved state on disk', async () => {
    const captureRunner: HarnessProps['captureRunner'] = { current: null };
    const prepared = preparedExecution({ projectDir, feature: 'add auth' });
    const runWorkflowStub: RunWorkflowFn = vi.fn(async () => makeSummary());

    const inst = renderHarness({ prepared, captureRunner, runWorkflow: runWorkflowStub });
    await tick(60);

    // No active session was written — handleResume should surface a feedback
    // error instead of trying to resume.
    const runner = captureRunner.current;
    if (!runner) throw new Error('expected captureRunner.current to be populated');
    lifecycleStore.__testReset({ cancelled: true, queueDepth: 4, phase: 'final-review' });
    eventsStore.__testReset({
      events: [
        {
          type: 'workflow_started',
          ts: Date.now(),
          phase: 'final-review',
          feature: 'stale session',
        },
      ],
    });
    runner.handleResume();
    await tick(60);

    expect(feedbackStore.get().message).toMatch(/no saved state/i);
    expect(feedbackStore.get().isError).toBe(true);
    expect(lifecycleStore.get().cancelled).toBe(false);
    expect(lifecycleStore.get().queueDepth).toBe(0);
    expect(eventsStore.get().events).toEqual([]);

    inst.unmount();
  });

  it.each([
    { phase: 'planning', sessionId: '2024-01-01-inject', text: 'what about edge case X?' },
    {
      phase: 'implementing',
      sessionId: '2024-01-01-implementing-inject',
      text: 'carry this into implementation',
    },
  ] as const)(
    'carries the typed continuation into the re-entered run as a steer and records it as a user message',
    async ({ phase, sessionId, text }) => {
      const resume: WorkflowState = {
        ...createInitialState('add auth'),
        ...RUN_CREW,
        phase,
      };
      saveState({ projectDir, sessionId }, resume);

      const captureRunner: HarnessProps['captureRunner'] = { current: null };
      const prepared = preparedExecution({
        projectDir,
        feature: 'add auth',
        sessionId,
        resumeState: resume,
      });
      const seen: (string | undefined)[] = [];
      const runWorkflowSpy: RunWorkflowFn = async (options) => {
        seen.push(options.steer?.text);
        return runWorkflow(options);
      };
      const inst = renderHarness({ prepared, captureRunner, runWorkflow: runWorkflowSpy });
      await vi.waitFor(() => {
        expect(settledRun()).not.toBeNull();
      });
      expect(userMessageEvents()).toHaveLength(0);

      const runner = captureRunner.current;
      if (!runner) throw new Error('expected captureRunner.current to be populated');
      runner.handleResume(plainUserMessage(text));
      await vi.waitFor(() => {
        expect(userMessageEvents()).toHaveLength(1);
        const log = readFileSync(join(sessionDir(projectDir, sessionId), 'session.jsonl'), 'utf-8');
        expect(loggedMessageRows(log, text)).toBe(1);
        expect(loadState({ projectDir, sessionId })?.messageQueue).toHaveLength(0);
      });

      expect(seen.at(-1)).toBe(text);
      expect(userMessageEvents()[0]).toMatchObject({ type: 'user_message', phase, text });
      expect(feedbackStore.get().isError).toBe(false);

      inst.unmount();
    },
  );

  it('re-enters with no steer and no new row when no text was typed', async () => {
    const sessionId = '2024-01-01-empty-continue';
    const resume: WorkflowState = {
      ...createInitialState('add auth'),
      ...RUN_CREW,
      phase: 'planning',
    };
    saveState({ projectDir, sessionId }, resume);

    const captureRunner: HarnessProps['captureRunner'] = { current: null };
    const prepared = preparedExecution({
      projectDir,
      feature: 'add auth',
      sessionId,
      resumeState: resume,
    });
    const seen: (string | undefined)[] = [];
    const runWorkflowSpy: RunWorkflowFn = async (options) => {
      seen.push(options.steer?.text);
      return runWorkflow(options);
    };
    const inst = renderHarness({ prepared, captureRunner, runWorkflow: runWorkflowSpy });
    await tick(60);
    expect(userMessageEvents()).toHaveLength(0);

    const runner = captureRunner.current;
    if (!runner) throw new Error('expected captureRunner.current to be populated');
    runner.handleResume();
    await tick(60);

    expect(seen.at(-1)).toBeUndefined();
    expect(userMessageEvents()).toHaveLength(0);
    const persisted = loadState({ projectDir, sessionId });
    if (!persisted) throw new Error('expected persisted state on disk');
    expect(persisted.messageQueue).toHaveLength(0);

    inst.unmount();
  });

  it('leaves the steer unrecorded when it answers a planner question still pending', async () => {
    const sessionId = '2024-01-01-pending-answer';
    const answer = 'change src/auth.ts instead';
    const questions: ClarificationQuestion[] = [
      { id: 'module', type: 'input', text: 'Which module should change?', default: 'src/app.ts' },
    ];
    const resume: WorkflowState = {
      ...createInitialState('add auth'),
      ...RUN_CREW,
      phase: 'planning',
      pendingPlannerConversation: {
        call: 'plan',
        text: questionsText(questions),
        questions,
        answers: [],
        answered: false,
      },
    };
    saveState({ projectDir, sessionId }, resume);

    const captureRunner: HarnessProps['captureRunner'] = { current: null };
    const prepared = preparedExecution({
      projectDir,
      feature: 'add auth',
      sessionId,
      resumeState: resume,
    });
    let returned = 0;
    const inst = renderHarness({
      prepared,
      captureRunner,
      runWorkflow: async (options) => {
        const summary = await runWorkflow(options);
        returned += 1;
        return summary;
      },
    });
    await vi.waitFor(() => {
      expect(returned).toBe(1);
    });

    const runner = captureRunner.current;
    if (!runner) throw new Error('expected captureRunner.current to be populated');
    runner.handleResume(plainUserMessage(answer));
    await vi.waitFor(() => {
      expect(returned).toBe(2);
    });

    // The planning session's pending question owns the answer: the session records it when it
    // consumes the seed, so the re-entry itself publishes nothing.
    expect(userMessageEvents()).toHaveLength(0);
    const log = readFileSync(join(sessionDir(projectDir, sessionId), 'session.jsonl'), 'utf-8');
    expect(log).not.toContain(answer);

    inst.unmount();
  });

  it('seeds the correction typed at a halt into the next call, and only that call', async () => {
    const sessionId = '2026-09-21-recovery-steer';
    const halted = saveHaltedRun(sessionId);
    const captureRunner: HarnessProps['captureRunner'] = { current: null };
    const prepared = preparedExecution({
      projectDir,
      feature: 'add auth',
      sessionId,
      resumeState: halted,
    });
    const seen: (string | undefined)[] = [];
    const runWorkflowStub: RunWorkflowFn = vi.fn(async (options) => {
      seen.push(options.steer?.text);
      // The first call halts again on the same brief; the second is answered with the keyword.
      if (seen.length === 1) {
        const current = loadState({ projectDir, sessionId });
        if (!current) throw new Error('expected persisted state on disk');
        saveState({ projectDir, sessionId }, { ...current, pendingRecovery: makeRecoveryIssue() });
      }
      return makeSummary();
    });

    const inst = renderHarness({ prepared, captureRunner, runWorkflow: runWorkflowStub });
    await answerRecoveryPanel(captureRunner, 'add a default');
    await vi.waitFor(() => {
      expect(seen).toEqual(['add a default']);
    });

    await answerRecoveryPanel(captureRunner, 'retry');
    await vi.waitFor(() => {
      expect(seen).toEqual(['add a default', undefined]);
    });
    expect(runWorkflowStub).toHaveBeenCalledTimes(2);

    inst.unmount();
  });

  it('keeps the re-entry steer when the panel answer carries none', async () => {
    const sessionId = '2026-09-21-recovery-keeps-steer';
    const halted = saveHaltedRun(sessionId);
    const captureRunner: HarnessProps['captureRunner'] = { current: null };
    const prepared = preparedExecution({
      projectDir,
      feature: 'add auth',
      sessionId,
      resumeState: halted,
    });
    const seen: (string | undefined)[] = [];
    const runWorkflowStub: RunWorkflowFn = vi.fn(async (options) => {
      seen.push(options.steer?.text);
      return makeSummary();
    });

    const inst = renderHarness({
      prepared,
      steer: plainUserMessage('original'),
      captureRunner,
      runWorkflow: runWorkflowStub,
    });
    await answerRecoveryPanel(captureRunner, 'retry');
    await vi.waitFor(() => {
      expect(seen).toEqual(['original']);
    });

    inst.unmount();
  });

  it.each([
    { phase: 'planning', seat: 'plan' },
    { phase: 'final-review', seat: 'review' },
  ] as const)(
    'records a restarted taskless $seat retry correction once',
    async ({ phase, seat }) => {
      const sessionId = `taskless-${seat}-retry-correction`;
      const halted: WorkflowState = {
        ...createInitialState('add auth'),
        ...RUN_CREW,
        phase,
        pendingRecovery: makeRecoveryIssue({
          reason: 'runner-usage-limit',
          phase,
          seat,
          taskId: undefined,
          taskTitle: undefined,
          availableActions: ['retry-same-worker', 'end-run'],
          recommendedAction: 'retry-same-worker',
        }),
      };
      const prepared = preparedExecution({
        projectDir,
        feature: halted.feature,
        sessionId,
        resumeState: halted,
      });
      saveState(prepared.session.ref, halted);
      const correction: UserMessageInput = {
        text: 'use @/outside/context.txt\n\n--- @/outside/context.txt ---\ncontext body',
        displayText: 'use @/outside/context.txt',
        images: [],
        attachedInputs: [{ kind: 'text', path: '/outside/context.txt' }],
      };
      const captureRunner: HarnessProps['captureRunner'] = { current: null };
      const run = recordedEngine();
      const inst = renderHarness({
        prepared,
        steer: correction,
        captureRunner,
        runWorkflow: run.engine,
      });
      try {
        await answerRecoveryPanel(captureRunner, 'retry');
        await vi.waitFor(() => expect(run.returned()).toBe(1));

        expect(userMessageEvents()).toEqual([
          expect.objectContaining({
            phase,
            text: correction.displayText,
            attachedInputs: correction.attachedInputs,
          }),
        ]);
        const log = readFileSync(join(sessionDir(projectDir, sessionId), 'session.jsonl'), 'utf-8');
        expect(loggedMessageRows(log, correction.displayText)).toBe(1);
        expect(loadState(prepared.session.ref)?.messageQueue).toMatchObject([correction]);
      } finally {
        inst.unmount();
      }
    },
  );

  it('stops at the brief boundary and continues at rest when a seat changed under the run', async () => {
    const sessionId = '2026-09-21-seat-change';
    ensureSessionDir(projectDir, sessionId);
    saveState(
      { projectDir, sessionId },
      { ...createInitialState('add auth'), ...RUN_CREW, phase: 'implementing' },
    );
    const prepared = preparedExecution({ projectDir, feature: 'add auth', sessionId });
    configStore.__testReset({ projectDir, config: prepared.config });
    const continueAtRest = vi.fn();
    const { promise: seatChanged, resolve: seatChangedNow } = Promise.withResolvers<void>();
    const runWorkflowStub: RunWorkflowFn = vi.fn(async (options) => {
      // The engine's side of a boundary pause: consume it and ask how to continue.
      await seatChanged;
      options.sinks.consumeBoundaryPause?.();
      await options.callbacks.onContinuationNeeded?.('', 'boundary', []);
      return makeSummary();
    });

    const inst = renderHarness({ prepared, continueAtRest, runWorkflow: runWorkflowStub });
    await vi.waitFor(() => {
      expect(runWorkflowStub).toHaveBeenCalledTimes(1);
    });
    lifecycleStore.__testReset({ phase: 'implementing' });
    configStore.__testReset({
      projectDir,
      config: makeConfig({ implementer: { kind: 'cli', tool: 'codex' } }),
    });
    expect(stopStore.get()).toMatchObject({ intent: 'none', seatChange: true });

    seatChangedNow();
    await vi.waitFor(() => {
      expect(continueAtRest).toHaveBeenCalledTimes(1);
    });
    expect(continueAtRest).toHaveBeenCalledWith(
      expect.objectContaining({ ref: { projectDir, sessionId } }),
      plainUserMessage(''),
    );
    expect(stopStore.get()).toMatchObject({ intent: 'none', phase: 'idle' });
    expect(overlayStore.get().active).toBe('none');

    inst.unmount();
  });

  it('stays paused at the brief boundary the operator asked for when a seat changed under the same brief', async () => {
    const sessionId = '2026-10-19-seat-change-operator-pause';
    ensureSessionDir(projectDir, sessionId);
    saveState(
      { projectDir, sessionId },
      { ...createInitialState('add auth'), ...RUN_CREW, phase: 'implementing' },
    );
    const prepared = preparedExecution({ projectDir, feature: 'add auth', sessionId });
    configStore.__testReset({ projectDir, config: prepared.config });
    const continueAtRest = vi.fn();
    const { promise: seatChanged, resolve: seatChangedNow } = Promise.withResolvers<void>();
    const runWorkflowStub: RunWorkflowFn = vi.fn(async (options) => {
      await seatChanged;
      options.sinks.consumeBoundaryPause?.();
      await options.callbacks.onContinuationNeeded?.('', 'boundary', []);
      return makeSummary();
    });

    const inst = renderHarness({ prepared, continueAtRest, runWorkflow: runWorkflowStub });
    await vi.waitFor(() => {
      expect(runWorkflowStub).toHaveBeenCalledTimes(1);
    });
    lifecycleStore.__testReset({ phase: 'implementing' });
    requestBoundaryPause();
    configStore.__testReset({
      projectDir,
      config: makeConfig({ implementer: { kind: 'cli', tool: 'codex' } }),
    });

    seatChangedNow();
    await vi.waitFor(() => {
      expect(settledRun()).not.toBeNull();
    });
    expect(continueAtRest).not.toHaveBeenCalled();
    expect(stopStore.get()).toMatchObject({ intent: 'pause-after-brief', phase: 'parked' });

    inst.unmount();
  });

  describe('a seat saved while the run is parked', () => {
    function savedRun(sessionId: string): PreparedExecution {
      ensureSessionDir(projectDir, sessionId);
      saveState(
        { projectDir, sessionId },
        { ...createInitialState('add auth'), ...RUN_CREW, phase: 'implementing' },
      );
      return preparedExecution({ projectDir, feature: 'add auth', sessionId });
    }

    /**
     * The engine pass by pass: the first parks where the test says, once the test lets the brief
     * run; every later pass records the preparation it runs on and the words it was continued with.
     */
    function parkingEngine(park: (options: Parameters<RunWorkflowFn>[0]) => Promise<void>) {
      const { promise: running, resolve: letBriefRun } = Promise.withResolvers<void>();
      const passes: { prepared: PreparedExecution; steer: string | undefined }[] = [];
      let continuedInPlace: boolean | undefined;
      const engine: RunWorkflowFn = vi.fn(async (options) => {
        passes.push({ prepared: options.prepared, steer: options.steer?.text });
        if (passes.length === 1) {
          await running;
          await park(options);
          continuedInPlace = options.signal?.aborted !== true;
        }
        return makeSummary();
      });
      return { engine, letBriefRun, passes, continuedInPlace: () => continuedInPlace };
    }

    const parkAtBoundary = async (options: Parameters<RunWorkflowFn>[0]) => {
      requestBoundaryPause();
      options.sinks.consumeBoundaryPause?.();
      await options.callbacks.onContinuationNeeded?.('', 'boundary', []);
    };

    async function renderParked(
      prepared: PreparedExecution,
      run: ReturnType<typeof parkingEngine>,
      requests: PrepareExecutionInput[],
    ) {
      const captureRunner: HarnessProps['captureRunner'] = { current: null };
      // The screen's continuation of a run at rest re-enters it; here the loop's own re-entry.
      const continueAtRest = vi.fn((_record: RunRecord, steer: UserMessageInput) => {
        captureRunner.current?.handleResume(steer);
      });
      const inst = renderHarness({
        prepared,
        captureRunner,
        continueAtRest,
        runWorkflow: run.engine,
        prepareExecution: reprepareSameSession(requests),
      });
      await vi.waitFor(() => {
        expect(run.engine).toHaveBeenCalledTimes(1);
      });
      lifecycleStore.__testReset({ phase: 'implementing', status: 'running' });
      run.letBriefRun();
      await vi.waitFor(() => {
        expect(stopStore.get().phase).toBe('parked');
      });
      const resume = (message?: UserMessageInput) => captureRunner.current?.handleResume(message);
      return { inst, continueAtRest, resume };
    }

    it('continues a boundary park on the seat saved while it waited, with the words typed to continue it', async () => {
      const prepared = savedRun('2026-10-21-park-seat-saved');
      configStore.__testReset({ projectDir, config: prepared.config });
      const requests: PrepareExecutionInput[] = [];
      const run = parkingEngine(parkAtBoundary);
      const { inst, continueAtRest, resume } = await renderParked(prepared, run, requests);

      configStore.__testReset({ projectDir, config: CODEX_SEAT_SAVED });
      resume(plainUserMessage('carry on'));
      await vi.waitFor(() => {
        expect(run.passes).toHaveLength(2);
      });

      expect(run.continuedInPlace()).toBe(false);
      expect(continueAtRest).toHaveBeenCalledTimes(1);
      expect(requests).toHaveLength(1);
      expect(requests[0]?.effectiveConfig.implementer).toMatchObject({ tool: 'codex' });
      expect(run.passes[1]?.prepared.config.implementer).toMatchObject({ tool: 'codex' });
      expect(run.passes[1]?.steer).toBe('carry on');

      inst.unmount();
    });

    it('continues a boundary park on the seat a hand edit of the file wrote while it waited', async () => {
      const prepared = savedRun('2026-10-23-park-seat-hand-edit');
      writeConfig(projectDir, prepared.config);
      configStore.load(projectDir);
      const requests: PrepareExecutionInput[] = [];
      const run = parkingEngine(parkAtBoundary);
      const { inst, continueAtRest, resume } = await renderParked(prepared, run, requests);

      writeConfig(projectDir, CODEX_SEAT_SAVED);
      resume();
      await vi.waitFor(() => {
        expect(run.passes).toHaveLength(2);
      });

      expect(continueAtRest).toHaveBeenCalledTimes(1);
      expect(run.passes[1]?.prepared.config.implementer).toMatchObject({ tool: 'codex' });

      inst.unmount();
    });

    it('continues a boundary park in place when no seat was saved while it waited', async () => {
      const prepared = savedRun('2026-10-21-park-no-seat-saved');
      configStore.__testReset({ projectDir, config: prepared.config });
      const requests: PrepareExecutionInput[] = [];
      const run = parkingEngine(parkAtBoundary);
      const { inst, continueAtRest, resume } = await renderParked(prepared, run, requests);

      configStore.__testReset({
        projectDir,
        config: { ...prepared.config, workflow: { ...prepared.config.workflow, approve: 'none' } },
      });
      resume();
      await vi.waitFor(() => {
        expect(settledRun()).not.toBeNull();
      });

      expect(run.continuedInPlace()).toBe(true);
      expect(continueAtRest).not.toHaveBeenCalled();
      expect(requests).toHaveLength(0);
      expect(run.passes).toHaveLength(1);

      inst.unmount();
    });

    it('takes a seat saved while a cut brief waits at the next brief boundary', async () => {
      const prepared = savedRun('2026-10-21-cut-brief-seat-saved');
      configStore.__testReset({ projectDir, config: prepared.config });
      const requests: PrepareExecutionInput[] = [];
      let pausedAtBoundary: boolean | undefined;
      const run = parkingEngine(async (options) => {
        await options.callbacks.onContinuationNeeded?.('', 'mid-step', []);
        pausedAtBoundary = options.sinks.consumeBoundaryPause?.();
        if (pausedAtBoundary) await options.callbacks.onContinuationNeeded?.('', 'boundary', []);
      });
      const { inst, continueAtRest, resume } = await renderParked(prepared, run, requests);

      configStore.__testReset({ projectDir, config: CODEX_SEAT_SAVED });
      resume();
      await vi.waitFor(() => {
        expect(run.passes).toHaveLength(2);
      });

      expect(pausedAtBoundary).toBe(true);
      expect(continueAtRest).toHaveBeenCalledTimes(1);
      expect(run.passes[1]?.prepared.config.implementer).toMatchObject({ tool: 'codex' });

      inst.unmount();
    });
  });

  describe('a save that changes no seat under a running brief', () => {
    // Preparation names the model a seat leaves to its tool; the config it read keeps the seat as saved.
    function preparedOnHostModel(sessionId: string, read: Config): PreparedExecution {
      ensureSessionDir(projectDir, sessionId);
      saveState(
        { projectDir, sessionId },
        { ...createInitialState('add auth'), ...RUN_CREW, phase: 'implementing' },
      );
      return {
        ...preparedExecution({
          projectDir,
          feature: 'add auth',
          sessionId,
          implementer: { kind: 'cli', tool: 'codex', model: 'gpt-5.5' },
        }),
        sourceConfig: parsePreparedConfig(read),
      };
    }

    /** The engine runs one brief until the save lands, then reaches the brief boundary. */
    function briefUntilSaved() {
      const { promise: saved, resolve: savedNow } = Promise.withResolvers<void>();
      let pausedAtBoundary: boolean | undefined;
      const engine: RunWorkflowFn = vi.fn(async (options) => {
        await saved;
        pausedAtBoundary = options.sinks.consumeBoundaryPause?.();
        if (pausedAtBoundary) await options.callbacks.onContinuationNeeded?.('', 'boundary', []);
        return makeSummary();
      });
      return { engine, savedNow, pausedAtBoundary: () => pausedAtBoundary };
    }

    it('requests no pause for a seat left to its tool', async () => {
      const seats = {
        planner: { kind: 'agent', command: 'splitbrief-non-existent-planner-x7q9' },
        implementer: { kind: 'cli', tool: 'codex' },
      } as const;
      const prepared = preparedOnHostModel('2026-10-19-unrelated-save-running', makeConfig(seats));
      configStore.__testReset({ projectDir, config: makeConfig(seats) });
      const continueAtRest = vi.fn();
      const brief = briefUntilSaved();
      const inst = renderHarness({ prepared, continueAtRest, runWorkflow: brief.engine });
      await vi.waitFor(() => {
        expect(brief.engine).toHaveBeenCalledTimes(1);
      });
      lifecycleStore.__testReset({ phase: 'implementing', status: 'running' });

      configStore.__testReset({
        projectDir,
        config: makeConfig({ ...seats, workflow: { approve: 'none' } }),
      });
      const intentAfterSave = stopStore.get().intent;
      brief.savedNow();
      await vi.waitFor(() => {
        expect(settledRun()).not.toBeNull();
      });

      expect(intentAfterSave).toBe('none');
      expect(brief.pausedAtBoundary()).toBe(false);
      expect(continueAtRest).not.toHaveBeenCalled();

      inst.unmount();
    });

    it('requests no pause when Settings saves another key of a config whose seat is on auto', async () => {
      const onAuto = makeConfig({
        planner: { kind: 'agent', command: 'splitbrief-non-existent-planner-x7q9' },
        implementer: { kind: 'cli', tool: 'codex', model: 'auto' },
      });
      const prepared = preparedOnHostModel('2026-10-19-unrelated-save-settings', onAuto);
      writeConfig(projectDir, onAuto);
      configStore.load(projectDir);
      const continueAtRest = vi.fn();
      const brief = briefUntilSaved();
      const inst = renderHarness({ prepared, continueAtRest, runWorkflow: brief.engine });
      await vi.waitFor(() => {
        expect(brief.engine).toHaveBeenCalledTimes(1);
      });
      lifecycleStore.__testReset({ phase: 'implementing', status: 'running' });

      const current = configStore.get().config;
      if (current === null) throw new Error('expected a loaded config');
      const saved = await configStore.save({
        ...current,
        workflow: { ...current.workflow, approve: 'none' },
      });
      const intentAfterSave = stopStore.get().intent;
      brief.savedNow();
      await vi.waitFor(() => {
        expect(settledRun()).not.toBeNull();
      });

      expect(saved.kind).toBe('saved');
      expect(intentAfterSave).toBe('none');
      expect(brief.pausedAtBoundary()).toBe(false);
      expect(continueAtRest).not.toHaveBeenCalled();

      inst.unmount();
    });
  });

  describe('a seat saved while the start check runs', () => {
    // The preparation read BUILD on codex; Settings saved claude-code before the screen mounted the run.
    function preparedOnCodex(sessionId: string): PreparedExecution {
      ensureSessionDir(projectDir, sessionId);
      saveState(
        { projectDir, sessionId },
        { ...createInitialState('add auth'), ...RUN_CREW, phase: 'implementing' },
      );
      return preparedExecution({
        projectDir,
        feature: 'add auth',
        sessionId,
        implementer: { kind: 'cli', tool: 'codex', model: 'gpt-5.5' },
      });
    }
    const seatsSaved = {
      planner: { kind: 'agent', command: 'splitbrief-non-existent-planner-x7q9' },
      implementer: { kind: 'cli', tool: 'claude-code' },
    } as const;

    /** The engine runs one brief until the test lets it reach the brief boundary. */
    function briefUntilBoundary() {
      const { promise: reached, resolve: reachBoundary } = Promise.withResolvers<void>();
      let pausedAtBoundary: boolean | undefined;
      const engine: RunWorkflowFn = vi.fn(async (options) => {
        await reached;
        pausedAtBoundary = options.sinks.consumeBoundaryPause?.();
        if (pausedAtBoundary) await options.callbacks.onContinuationNeeded?.('', 'boundary', []);
        return makeSummary();
      });
      return { engine, reachBoundary, pausedAtBoundary: () => pausedAtBoundary };
    }

    it('stops at the first brief boundary and continues on the saved seat', async () => {
      const prepared = preparedOnCodex('2026-10-19-seat-saved-in-check');
      configStore.__testReset({ projectDir, config: makeConfig(seatsSaved) });
      const continueAtRest = vi.fn();
      const brief = briefUntilBoundary();
      const inst = renderHarness({ prepared, continueAtRest, runWorkflow: brief.engine });
      await vi.waitFor(() => {
        expect(brief.engine).toHaveBeenCalledTimes(1);
      });
      lifecycleStore.__testReset({ phase: 'implementing', status: 'running' });

      brief.reachBoundary();
      await vi.waitFor(() => {
        expect(continueAtRest).toHaveBeenCalledTimes(1);
      });

      expect(brief.pausedAtBoundary()).toBe(true);
      inst.unmount();
    });

    it('still stops for it after a later save that changes no seat', async () => {
      const prepared = preparedOnCodex('2026-10-19-seat-saved-in-check-later');
      configStore.__testReset({ projectDir, config: makeConfig(seatsSaved) });
      const continueAtRest = vi.fn();
      const brief = briefUntilBoundary();
      const inst = renderHarness({ prepared, continueAtRest, runWorkflow: brief.engine });
      await vi.waitFor(() => {
        expect(brief.engine).toHaveBeenCalledTimes(1);
      });
      lifecycleStore.__testReset({ phase: 'implementing', status: 'running' });

      configStore.__testReset({
        projectDir,
        config: makeConfig({ ...seatsSaved, workflow: { approve: 'none' } }),
      });
      brief.reachBoundary();
      await vi.waitFor(() => {
        expect(continueAtRest).toHaveBeenCalledTimes(1);
      });

      expect(brief.pausedAtBoundary()).toBe(true);
      inst.unmount();
    });
  });

  it('settles a boundary pause as today when no seat changed', async () => {
    const sessionId = '2026-09-21-boundary-pause';
    ensureSessionDir(projectDir, sessionId);
    saveState(
      { projectDir, sessionId },
      { ...createInitialState('add auth'), ...RUN_CREW, phase: 'implementing' },
    );
    const prepared = preparedExecution({ projectDir, feature: 'add auth', sessionId });
    const continueAtRest = vi.fn();
    const runWorkflowStub: RunWorkflowFn = vi.fn(async (options) => {
      requestBoundaryPause();
      options.sinks.consumeBoundaryPause?.();
      return makeSummary();
    });

    const inst = renderHarness({ prepared, continueAtRest, runWorkflow: runWorkflowStub });
    await vi.waitFor(() => {
      expect(settledRun()).not.toBeNull();
    });

    expect(continueAtRest).not.toHaveBeenCalled();
    expect(stopStore.get().phase).toBe('parked');

    inst.unmount();
  });

  it('keeps the drafted model and effort when the swap opens the picker, and Escape leaves with no change', async () => {
    configStore.__testReset({
      projectDir,
      config: makeConfig({ implementer: { kind: 'cli', tool: 'codex' } }),
    });
    // What the driver does before it opens the overlay: draft the offered candidate's
    // model and effort, then land the picker on that candidate's tool row. The seat's
    // current tool is codex, so the picker opens on a tool that is not the current one.
    pickerViewStore.expand('opus', 'opus', 'high');
    overlayStore.open('implementer-picker', toolRowFocus('claude-code'));
    terminalSizeStore.__testReset({ cols: 120, rows: 40, isSmall: false });

    const ui = render(<ToolModelPicker slot="seat" role="implementer" />);
    await tick(60);

    // The picker's reset runs on unmount, not on the first render, so the draft is still there.
    expect(pickerViewStore.get()).toMatchObject({ expandedModelId: 'opus', effortDraft: 'high' });
    expect(ui.lastFrame()).toContain('tool, model, effort');

    // The drafted row is an expansion, so the first Escape folds it the way it folds any
    // expanded model row, and the second leaves the picker; the seat of record is untouched.
    ui.stdin.write('\u001B');
    await tick(60);
    expect(pickerViewStore.get().expandedModelId).toBeNull();
    expect(overlayStore.get().active).toBe('implementer-picker');
    ui.stdin.write('\u001B');
    await tick(60);
    expect(overlayStore.get().active).toBe('none');
    expect(configStore.get().config?.implementer).toMatchObject({ kind: 'cli', tool: 'codex' });

    ui.unmount();
  });

  it('settles a park in place instead of re-entering the run', async () => {
    const sessionId = '2024-01-01-parked-continue';
    ensureSessionDir(projectDir, sessionId);
    saveState(
      { projectDir, sessionId },
      { ...createInitialState('add auth'), ...RUN_CREW, phase: 'implementing' },
    );

    const captureRunner: HarnessProps['captureRunner'] = { current: null };
    const prepared = preparedExecution({ projectDir, feature: 'add auth', sessionId });
    const runWorkflowStub: RunWorkflowFn = vi.fn(async () => makeSummary());
    const inst = renderHarness({ prepared, captureRunner, runWorkflow: runWorkflowStub });
    await tick(60);
    const runsBefore = (runWorkflowStub as unknown as { mock: { calls: unknown[] } }).mock.calls
      .length;

    const runner = captureRunner.current;
    if (!runner) throw new Error('expected captureRunner.current to be populated');
    const settled = vi.fn();
    stopStore.park('mid-brief', 'T001', settled);
    runner.handleResume(plainUserMessage('use the other adapter'));
    await tick(60);

    expect(settled).toHaveBeenCalledWith(plainUserMessage('use the other adapter'));
    expect((runWorkflowStub as unknown as { mock: { calls: unknown[] } }).mock.calls.length).toBe(
      runsBefore,
    );

    inst.unmount();
  });

  it('cleans up all handlers on unmount so later events do not leak into the suite', async () => {
    const prepared = preparedExecution({ projectDir, feature: 'add auth' });
    const inst = renderHarness({ prepared });
    await tick(60);

    inst.unmount();
    await tick(60);

    expect(abortTurn()).toBe(false);
  });

  it('asks nothing about a halt on a retired cause', async () => {
    const sessionId = '2026-09-21-stale-file-halt';
    ensureSessionDir(projectDir, sessionId);
    const halted = makeImplState([makeTask({ id: 'T001', status: 'failed' })], {
      ...RUN_CREW,
      pendingRecovery: makeRecoveryIssue({
        reason: 'user-edit-conflict',
        files: ['src/reverted.ts'],
        availableActions: ['continue', 'end-run'],
        recommendedAction: 'continue',
      }),
    });
    saveState({ projectDir, sessionId }, halted);
    const prepared = preparedExecution({
      projectDir,
      feature: 'add auth',
      sessionId,
      resumeState: halted,
    });
    // The engine's side of the same rule: init resolves the halt and the run proceeds.
    const runWorkflowStub = vi.fn<RunWorkflowFn>(async () => {
      const current = loadState({ projectDir, sessionId });
      if (current) saveState({ projectDir, sessionId }, { ...current, pendingRecovery: undefined });
      return makeSummary();
    });

    const inst = renderHarness({ prepared, runWorkflow: runWorkflowStub });
    await vi.waitFor(() => {
      expect(settledRun()).not.toBeNull();
    });

    expect(runWorkflowStub).toHaveBeenCalledTimes(1);
    expect(controlsStore.get().inputMode).not.toBe('question');
    expect(runWorkflowStub.mock.calls[0]?.[0]?.savedState?.pendingRecovery).toBeDefined();

    inst.unmount();
  });

  describe('a run started on this screen', () => {
    it('re-enters the engine as the same session when a planning halt is retried', async () => {
      const sessionId = '2026-09-23-start-retry';
      const captureRunner: HarnessProps['captureRunner'] = { current: null };
      const prepared = preparedExecution({
        projectDir,
        feature: 'add auth',
        sessionId,
        planner: {
          kind: 'shell',
          command: 'sh',
          args: ['-c', `cat >/dev/null; echo "You've hit your usage limit." >&2; exit 1`],
        },
        workflow: {},
      });
      const ref = prepared.session.ref;
      const requests: PrepareExecutionInput[] = [];
      const run = recordedEngine();

      const inst = renderHarness({
        prepared,
        captureRunner,
        runWorkflow: run.engine,
        prepareExecution: reprepareSameSession(requests),
      });
      await answerRecoveryPanel(captureRunner, 'retry');
      await vi.waitFor(() => {
        expect(run.returned()).toBe(2);
      });

      expect(run.entered.map((entry) => entry.purpose)).toEqual(['new-workflow', 'resume']);
      expect(run.entered[1]?.session.ref).toEqual(ref);
      expect(run.entered[1]?.config).toEqual(prepared.config);
      expect(requests).toEqual([
        expect.objectContaining({
          existingSession: ref,
          effectiveConfig: prepared.config,
          policy: expect.objectContaining({ purpose: 'resume', interaction: 'interactive' }),
        }),
      ]);
      // The retried call ran and hit the same limit, so the run halts on it again.
      expect(eventsStore.get().events.map((event) => event.type)).toContain('workflow_resumed');
      expect(loadState(ref)?.pendingRecovery?.reason).toBe('runner-usage-limit');
      expect(errorMessages()).not.toContainEqual(
        expect.stringContaining('already holds workflow state'),
      );

      inst.unmount();
    });

    it('re-enters a retried required-checks halt on the validation block saved since the halt', async () => {
      const sessionId = '2026-10-06-start-checks-retry';
      const captureRunner: HarnessProps['captureRunner'] = { current: null };
      const prepared = preparedExecution({ projectDir, feature: 'add auth', sessionId });
      const ref = prepared.session.ref;
      const run = recordedEngine({
        1: async () => {
          saveState(
            ref,
            makeImplState([makeTask({ id: 'T001', status: 'done' })], {
              ...RUN_CREW,
              phase: 'final-review',
              pendingRecovery: buildRequiredChecksUnrunnableRecoveryIssue({
                phase: 'final-review',
                checks: [{ checkId: 'K-render', output: 'validation.render is not set' }],
                createdAt: '2026-10-06T16:58:06.000Z',
              }),
            }),
          );
          // The operator adds the render command while the halt panel is open.
          writeConfig(projectDir, {
            ...prepared.config,
            validation: { ...prepared.config.validation, render: 'true {id} {out}' },
          });
          return makeSummary();
        },
        2: async () => makeSummary(),
      });

      const inst = renderHarness({
        prepared,
        captureRunner,
        runWorkflow: run.engine,
        prepareExecution: reprepareSameSession(),
      });
      await answerRecoveryPanel(captureRunner, 'retry');
      await vi.waitFor(() => {
        expect(run.returned()).toBe(2);
      });

      expect(prepared.config.validation.render).toBeUndefined();
      expect(run.entered[1]?.config.validation.render).toBe('true {id} {out}');
      expect(run.entered[1]?.config.planner).toEqual(prepared.config.planner);

      inst.unmount();
    });

    it('continues a run parked on the required-checks halt with the validation block saved since', async () => {
      const sessionId = '2026-10-06-at-rest-checks-retry';
      const ref = { projectDir, sessionId };
      ensureSessionDir(projectDir, sessionId);
      const halted = makeImplState([makeTask({ id: 'T001', status: 'done' })], {
        ...RUN_CREW,
        phase: 'final-review',
        pendingRecovery: buildRequiredChecksUnrunnableRecoveryIssue({
          phase: 'final-review',
          checks: [{ checkId: 'K-render', output: 'validation.render is not set' }],
          createdAt: '2026-10-06T16:58:06.000Z',
        }),
      });
      saveState(ref, halted);
      writeConfig(projectDir, makeConfig({ validation: { render: 'true {id} {out}' } }));
      const captureRunner: HarnessProps['captureRunner'] = { current: null };
      const prepared = preparedExecution({
        projectDir,
        feature: 'add auth',
        sessionId,
        resumeState: halted,
      });
      const run = recordedEngine({ 1: async () => makeSummary() });

      const inst = renderHarness({ prepared, captureRunner, runWorkflow: run.engine });
      await answerRecoveryPanel(captureRunner, 'retry');
      await vi.waitFor(() => {
        expect(run.returned()).toBe(1);
      });

      expect(prepared.config.validation.render).toBeUndefined();
      expect(run.entered[0]?.config.validation.render).toBe('true {id} {out}');

      inst.unmount();
    });

    it('keeps the required-checks halt and says why when the saved config no longer loads', async () => {
      const sessionId = '2026-10-06-start-checks-retry-broken';
      const captureRunner: HarnessProps['captureRunner'] = { current: null };
      const prepared = preparedExecution({ projectDir, feature: 'add auth', sessionId });
      const ref = prepared.session.ref;
      const run = recordedEngine({
        1: async () => {
          saveState(
            ref,
            makeImplState([makeTask({ id: 'T001', status: 'done' })], {
              ...RUN_CREW,
              phase: 'final-review',
              pendingRecovery: buildRequiredChecksUnrunnableRecoveryIssue({
                phase: 'final-review',
                checks: [{ checkId: 'K-render', output: 'validation.render is not set' }],
                createdAt: '2026-10-06T16:58:06.000Z',
              }),
            }),
          );
          writeFileSync(join(projectDir, '.splitbrief', 'config.yaml'), 'version: 99\n');
          return makeSummary();
        },
      });

      const inst = renderHarness({ prepared, captureRunner, runWorkflow: run.engine });
      await answerRecoveryPanel(captureRunner, 'retry');
      await vi.waitFor(() => {
        expect(errorMessages().some((message) => message.includes('config'))).toBe(true);
      });

      expect(run.entered).toHaveLength(1);
      expect(loadState(ref)?.pendingRecovery?.reason).toBe('required-checks-unrunnable');

      inst.unmount();
    });

    it('re-enters the engine as the same session when a brief halt is skipped', async () => {
      const sessionId = '2026-09-23-start-skip';
      const captureRunner: HarnessProps['captureRunner'] = { current: null };
      const prepared = preparedExecution({ projectDir, feature: 'add auth', sessionId });
      const run = recordedEngine({
        1: async () => {
          saveHaltedRun(sessionId);
          return makeSummary();
        },
      });

      const inst = renderHarness({ prepared, captureRunner, runWorkflow: run.engine });
      await answerRecoveryPanel(captureRunner, 'skip');
      await vi.waitFor(() => {
        expect(run.returned()).toBe(2);
      });

      expect(run.entered.map((entry) => entry.purpose)).toEqual(['new-workflow', 'resume']);
      expect(run.entered[1]?.session.ref).toEqual(prepared.session.ref);
      expect(loadState(prepared.session.ref)?.tasks.map((task) => task.status)).toEqual([
        'skipped',
      ]);
      expect(errorMessages()).toEqual([expect.stringContaining('is not available')]);

      inst.unmount();
    });

    it('moves a halted seat that can no longer be admitted without admitting it again', async () => {
      const sessionId = '2026-09-23-start-switch-seat';
      const captureRunner: HarnessProps['captureRunner'] = { current: null };
      const prepared = preparedExecution({ projectDir, feature: 'add auth', sessionId });
      const ref = prepared.session.ref;
      const requests: PrepareExecutionInput[] = [];
      const admit = reprepareSameSession();
      // The halted build seat is signed out: a preparation that still names it is refused.
      const haltedSeatSignedOut: PrepareExecutionFn = async (input) => {
        requests.push(input);
        const { implementer } = input.effectiveConfig;
        if (implementer.kind === 'cli' && implementer.tool === 'claude-code') return admit(input);
        return { kind: 'blocked', report: { ...prepared.report, status: 'blocked' } };
      };
      const run = recordedEngine({
        1: async () => {
          saveState(
            ref,
            makeImplState([makeTask({ id: 'T001', status: 'failed' })], {
              ...RUN_CREW,
              mode: 'speckit',
              pendingRecovery: makeRecoveryIssue({
                reason: 'runner-usage-limit',
                availableActions: [
                  'retry-same-worker',
                  'switch-seat',
                  'skip-current-task',
                  'end-run',
                ],
                recommendedAction: 'switch-seat',
                switchSeat: { seat: 'build', candidates: [{ tool: 'claude-code' }] },
              }),
            }),
          );
          return makeSummary();
        },
      });

      const inst = renderHarness({
        prepared,
        captureRunner,
        runWorkflow: run.engine,
        prepareExecution: haltedSeatSignedOut,
      });
      await answerRecoveryPanel(captureRunner, 'switch');
      await vi.waitFor(() => {
        expect(overlayStore.get().active).toBe('implementer-picker');
      });
      configStore.__testReset({
        projectDir,
        config: makeConfig({
          planner: { kind: 'agent', command: 'splitbrief-non-existent-planner-x7q9' },
          implementer: { kind: 'cli', tool: 'claude-code' },
        }),
      });
      pickerViewStore.setCommitted(true);
      overlayStore.close();
      await vi.waitFor(() => {
        expect(run.returned()).toBe(2);
      });

      expect(requests).toEqual([
        expect.objectContaining({
          existingSession: ref,
          effectiveConfig: expect.objectContaining({
            implementer: expect.objectContaining({ kind: 'cli', tool: 'claude-code' }),
          }),
          policy: expect.objectContaining({ purpose: 'resume', interaction: 'interactive' }),
        }),
      ]);
      expect(run.entered.map((entry) => entry.purpose)).toEqual(['new-workflow', 'resume']);
      expect(run.entered[1]?.config.implementer).toMatchObject({
        kind: 'cli',
        tool: 'claude-code',
      });
      // The seat change resumes the same run: its saved speckit mode survives and recovery clears.
      expect(loadState(ref)?.mode).toBe('speckit');
      expect(loadState(ref)?.pendingRecovery).toBeUndefined();
      expect(errorMessages()).toEqual([expect.stringContaining('is not available')]);

      inst.unmount();
    });

    it('announces no pause when the halt panel switches the halted seat', async () => {
      const sessionId = '2026-10-19-halt-switch-no-pause';
      const captureRunner: HarnessProps['captureRunner'] = { current: null };
      const prepared = preparedExecution({ projectDir, feature: 'add auth', sessionId });
      configStore.__testReset({ projectDir, config: prepared.config });
      const run = recordedEngine({
        1: async () => {
          saveState(
            prepared.session.ref,
            makeImplState([makeTask({ id: 'T001', status: 'failed' })], {
              ...RUN_CREW,
              pendingRecovery: makeRecoveryIssue({
                reason: 'runner-usage-limit',
                availableActions: [
                  'retry-same-worker',
                  'switch-seat',
                  'skip-current-task',
                  'end-run',
                ],
                recommendedAction: 'switch-seat',
                switchSeat: { seat: 'build', candidates: [{ tool: 'claude-code' }] },
              }),
            }),
          );
          return makeSummary();
        },
      });

      const inst = renderHarness({ prepared, captureRunner, runWorkflow: run.engine });
      await answerRecoveryPanel(captureRunner, 'switch');
      await vi.waitFor(() => {
        expect(overlayStore.get().active).toBe('implementer-picker');
      });
      // A run is `running` while its halt waits on the panel.
      lifecycleStore.__testReset({ phase: 'implementing', status: 'running' });
      const intents: string[] = [];
      const offStop = stopStore.subscribe(() => intents.push(stopStore.get().intent));
      configStore.__testReset({
        projectDir,
        config: makeConfig({
          planner: { kind: 'agent', command: 'splitbrief-non-existent-planner-x7q9' },
          implementer: { kind: 'cli', tool: 'claude-code' },
        }),
      });
      const intentAfterSave = stopStore.get().intent;
      pickerViewStore.setCommitted(true);
      overlayStore.close();
      await vi.waitFor(() => {
        expect(run.returned()).toBe(2);
      });
      offStop();

      expect(intentAfterSave).toBe('none');
      expect(intents).not.toContain('pause-after-brief');
      expect(run.entered[1]?.config.implementer).toMatchObject({
        kind: 'cli',
        tool: 'claude-code',
      });

      inst.unmount();
    });

    it.each([
      ['Try again', 'retry', undefined],
      ['a correction', 'use the new helper', 'use the new helper'],
    ])(
      'runs %s on a seat saved while a Seat down halt waits, with no boundary pause',
      async (_answer, typed, steer) => {
        const sessionId = '2026-10-19-halt-settings-save';
        const captureRunner: HarnessProps['captureRunner'] = { current: null };
        const prepared = preparedExecution({ projectDir, feature: 'add auth', sessionId });
        configStore.__testReset({ projectDir, config: prepared.config });
        const requests: PrepareExecutionInput[] = [];
        const reentry = engineEntryAfterHalt();
        const run = recordedEngine({
          1: async () => {
            saveSeatDownHalt(sessionId);
            return makeSummary();
          },
          2: reentry.engine,
        });

        const inst = renderHarness({
          prepared,
          captureRunner,
          runWorkflow: run.engine,
          prepareExecution: reprepareSameSession(requests),
        });
        await vi.waitFor(() => {
          expect(controlsStore.get().inputMode).toBe('question');
        });
        lifecycleStore.__testReset({ phase: 'implementing', status: 'running' });
        // A save from Settings while the panel is open, not the panel's own swap.
        configStore.__testReset({ projectDir, config: CODEX_SEAT_SAVED });
        await answerRecoveryPanel(captureRunner, typed);
        await vi.waitFor(() => {
          expect(run.returned()).toBe(2);
        });

        expect(requests).toEqual([expect.objectContaining({ effectiveConfig: CODEX_SEAT_SAVED })]);
        expect(run.entered[1]?.config.implementer).toMatchObject({ kind: 'cli', tool: 'codex' });
        expect(reentry.seen()).toEqual({ pausedAtBoundary: false, intent: 'none', steer });

        inst.unmount();
      },
    );

    it('runs Try again on a seat saved under the running brief that then halted, with no boundary pause', async () => {
      const sessionId = '2026-10-19-brief-save-then-halt';
      const captureRunner: HarnessProps['captureRunner'] = { current: null };
      const prepared = preparedExecution({ projectDir, feature: 'add auth', sessionId });
      configStore.__testReset({ projectDir, config: prepared.config });
      const { promise: saved, resolve: savedNow } = Promise.withResolvers<void>();
      const reentry = engineEntryAfterHalt();
      const run = recordedEngine({
        // The brief is running when the seat is saved, then it halts Seat down before its boundary.
        1: async () => {
          await saved;
          saveSeatDownHalt(sessionId);
          return makeSummary();
        },
        2: reentry.engine,
      });

      const inst = renderHarness({ prepared, captureRunner, runWorkflow: run.engine });
      await vi.waitFor(() => {
        expect(run.entered).toHaveLength(1);
      });
      lifecycleStore.__testReset({ phase: 'implementing', status: 'running' });
      configStore.__testReset({ projectDir, config: CODEX_SEAT_SAVED });
      expect(stopStore.get()).toMatchObject({ intent: 'none', seatChange: true });
      savedNow();
      await answerRecoveryPanel(captureRunner, 'retry');
      await vi.waitFor(() => {
        expect(run.returned()).toBe(2);
      });

      expect(run.entered[1]?.config.implementer).toMatchObject({ kind: 'cli', tool: 'codex' });
      expect(reentry.seen()).toMatchObject({ pausedAtBoundary: false, intent: 'none' });

      inst.unmount();
    });

    it('runs Try again on a seat saved while the Seat down halt of a run continued at rest waits', async () => {
      const sessionId = '2026-10-19-at-rest-halt-save';
      ensureSessionDir(projectDir, sessionId);
      const halted = saveSeatDownHalt(sessionId);
      const prepared = preparedExecution({
        projectDir,
        feature: halted.feature,
        sessionId,
        resumeState: halted,
      });
      configStore.__testReset({ projectDir, config: prepared.config });
      const captureRunner: HarnessProps['captureRunner'] = { current: null };
      const requests: PrepareExecutionInput[] = [];
      const reentry = engineEntryAfterHalt();
      const run = recordedEngine({ 1: reentry.engine });

      const inst = renderHarness({
        prepared,
        captureRunner,
        runWorkflow: run.engine,
        prepareExecution: reprepareSameSession(requests),
      });
      await vi.waitFor(() => {
        expect(controlsStore.get().inputMode).toBe('question');
      });
      lifecycleStore.__testReset({ phase: 'implementing', status: 'running' });
      configStore.__testReset({ projectDir, config: CODEX_SEAT_SAVED });
      await answerRecoveryPanel(captureRunner, 'retry');
      await vi.waitFor(() => {
        expect(run.returned()).toBe(1);
      });

      expect(requests).toEqual([
        expect.objectContaining({
          effectiveConfig: CODEX_SEAT_SAVED,
          policy: expect.objectContaining({ purpose: 'resume' }),
        }),
      ]);
      expect(run.entered[0]?.config.implementer).toMatchObject({ kind: 'cli', tool: 'codex' });
      expect(reentry.seen()).toMatchObject({ pausedAtBoundary: false, intent: 'none' });

      inst.unmount();
    });

    it('runs Try again on the seat a hand edit of the file wrote while the Seat down halt waits', async () => {
      const sessionId = '2026-10-23-halt-hand-edit';
      ensureSessionDir(projectDir, sessionId);
      const halted = saveSeatDownHalt(sessionId);
      const prepared = preparedExecution({
        projectDir,
        feature: halted.feature,
        sessionId,
        resumeState: halted,
      });
      writeConfig(projectDir, prepared.config);
      configStore.load(projectDir);
      const captureRunner: HarnessProps['captureRunner'] = { current: null };
      const requests: PrepareExecutionInput[] = [];
      const reentry = engineEntryAfterHalt();
      const run = recordedEngine({ 1: reentry.engine });

      const inst = renderHarness({
        prepared,
        captureRunner,
        runWorkflow: run.engine,
        prepareExecution: reprepareSameSession(requests),
      });
      await vi.waitFor(() => {
        expect(controlsStore.get().inputMode).toBe('question');
      });
      lifecycleStore.__testReset({ phase: 'implementing', status: 'running' });
      writeConfig(projectDir, CODEX_SEAT_SAVED);
      await answerRecoveryPanel(captureRunner, 'retry');
      await vi.waitFor(() => {
        expect(run.returned()).toBe(1);
      });

      expect(requests[0]?.effectiveConfig.implementer).toMatchObject({ tool: 'codex' });
      expect(run.entered[0]?.config.implementer).toMatchObject({ kind: 'cli', tool: 'codex' });

      inst.unmount();
    });

    it('switches the halted seat when the picker takes the tool a save under the halt already chose', async () => {
      const sessionId = '2026-10-19-halt-save-then-switch-same';
      const captureRunner: HarnessProps['captureRunner'] = { current: null };
      const prepared = preparedExecution({ projectDir, feature: 'add auth', sessionId });
      configStore.__testReset({ projectDir, config: prepared.config });
      const reentry = engineEntryAfterHalt();
      const run = recordedEngine({
        1: async () => {
          saveSeatDownHalt(sessionId);
          return makeSummary();
        },
        2: reentry.engine,
      });

      const inst = renderHarness({ prepared, captureRunner, runWorkflow: run.engine });
      await vi.waitFor(() => {
        expect(controlsStore.get().inputMode).toBe('question');
      });
      lifecycleStore.__testReset({ phase: 'implementing', status: 'running' });
      configStore.__testReset({ projectDir, config: CLAUDE_CODE_SEAT_SAVED });
      await answerRecoveryPanel(captureRunner, 'switch');
      await vi.waitFor(() => {
        expect(overlayStore.get().active).toBe('implementer-picker');
      });
      // The picker opens on the offered tool, which the save already chose; taking its row
      // writes the seat again.
      configStore.__testReset({ projectDir, config: CLAUDE_CODE_SEAT_SAVED });
      pickerViewStore.setCommitted(true);
      overlayStore.close();
      await vi.waitFor(() => {
        expect(run.returned()).toBe(2);
      });

      expect(run.entered[1]?.config.implementer).toMatchObject({
        kind: 'cli',
        tool: 'claude-code',
      });
      expect(loadState(prepared.session.ref)?.seatSwitches).toEqual([
        expect.objectContaining({
          seat: 'build',
          toSeat: { tool: 'claude-code' },
          cause: 'runner-usage-limit',
        }),
      ]);

      inst.unmount();
    });

    it.each([
      ['the offered tool', CLAUDE_CODE_SEAT_SAVED, 'claude-code'],
      ['a tool the halt does not offer', CODEX_SEAT_SAVED, 'codex'],
    ])(
      'keeps the halt when the picker closes with no pick after a save of %s under it, and Try again runs on it',
      async (_saved, savedConfig, tool) => {
        const sessionId = '2026-10-19-halt-save-then-picker-escape';
        const captureRunner: HarnessProps['captureRunner'] = { current: null };
        const prepared = preparedExecution({ projectDir, feature: 'add auth', sessionId });
        configStore.__testReset({ projectDir, config: prepared.config });
        const requests: PrepareExecutionInput[] = [];
        const reentry = engineEntryAfterHalt();
        const run = recordedEngine({
          1: async () => {
            saveSeatDownHalt(sessionId);
            return makeSummary();
          },
          2: reentry.engine,
        });

        const inst = renderHarness({
          prepared,
          captureRunner,
          runWorkflow: run.engine,
          prepareExecution: reprepareSameSession(requests),
        });
        await vi.waitFor(() => {
          expect(controlsStore.get().inputMode).toBe('question');
        });
        lifecycleStore.__testReset({ phase: 'implementing', status: 'running' });
        configStore.__testReset({ projectDir, config: savedConfig });
        await answerRecoveryPanel(captureRunner, 'switch');
        await vi.waitFor(() => {
          expect(overlayStore.get().active).toBe('implementer-picker');
        });
        // Escape closes the picker and writes nothing.
        overlayStore.close();
        await answerRecoveryPanel(captureRunner, 'retry');
        await vi.waitFor(() => {
          expect(run.returned()).toBe(2);
        });

        expect(requests).toEqual([expect.objectContaining({ effectiveConfig: savedConfig })]);
        expect(run.entered[1]?.config.implementer).toMatchObject({ kind: 'cli', tool });
        expect(loadState(prepared.session.ref)?.seatSwitches ?? []).toEqual([]);
        expect(
          eventsStore
            .get()
            .events.filter(
              (event) => event.type === 'warning' && event.message.includes('Could not switch'),
            ),
        ).toEqual([]);

        inst.unmount();
      },
    );

    it('switches the halted seat when the picker takes a tool the halt does not offer', async () => {
      const sessionId = '2026-10-21-halt-picker-outside-offer';
      const captureRunner: HarnessProps['captureRunner'] = { current: null };
      const prepared = preparedExecution({ projectDir, feature: 'add auth', sessionId });
      configStore.__testReset({ projectDir, config: prepared.config });
      const reentry = engineEntryAfterHalt();
      const run = recordedEngine({
        1: async () => {
          saveSeatDownHalt(sessionId);
          return makeSummary();
        },
        2: reentry.engine,
      });

      const inst = renderHarness({ prepared, captureRunner, runWorkflow: run.engine });
      await vi.waitFor(() => {
        expect(controlsStore.get().inputMode).toBe('question');
      });
      lifecycleStore.__testReset({ phase: 'implementing', status: 'running' });
      await answerRecoveryPanel(captureRunner, 'switch');
      await vi.waitFor(() => {
        expect(overlayStore.get().active).toBe('implementer-picker');
      });
      // The halt offers Claude Code; the picker takes Codex.
      configStore.__testReset({ projectDir, config: CODEX_SEAT_SAVED });
      pickerViewStore.setCommitted(true);
      overlayStore.close();
      await vi.waitFor(() => {
        expect(run.returned()).toBe(2);
      });

      expect(run.entered[1]?.config.implementer).toMatchObject({ kind: 'cli', tool: 'codex' });
      expect(loadState(prepared.session.ref)?.seatSwitches).toEqual([
        expect.objectContaining({
          seat: 'build',
          toSeat: { tool: 'codex' },
          cause: 'runner-usage-limit',
        }),
      ]);
      const events = eventsStore.get().events;
      expect(events.filter((event) => event.type === 'recovery_action_failed')).toEqual([]);
      expect(
        events.filter(
          (event) => event.type === 'warning' && event.message.includes('Could not switch'),
        ),
      ).toEqual([]);

      inst.unmount();
    });

    it('keeps a REVIEW seat saved under a BUILD halt when Change BUILD tool picks another tool', async () => {
      const sessionId = '2026-10-19-halt-review-save-then-switch';
      const captureRunner: HarnessProps['captureRunner'] = { current: null };
      const prepared = preparedExecution({ projectDir, feature: 'add auth', sessionId });
      configStore.__testReset({ projectDir, config: prepared.config });
      const planner = { kind: 'agent', command: 'splitbrief-non-existent-planner-x7q9' } as const;
      const reviewer = { kind: 'cli', tool: 'codex' } as const;
      const reentry = engineEntryAfterHalt();
      const run = recordedEngine({
        1: async () => {
          saveSeatDownHalt(sessionId);
          return makeSummary();
        },
        2: reentry.engine,
      });

      const inst = renderHarness({ prepared, captureRunner, runWorkflow: run.engine });
      await vi.waitFor(() => {
        expect(controlsStore.get().inputMode).toBe('question');
      });
      lifecycleStore.__testReset({ phase: 'implementing', status: 'running' });
      configStore.__testReset({ projectDir, config: makeConfig({ planner, reviewer }) });
      await answerRecoveryPanel(captureRunner, 'switch');
      await vi.waitFor(() => {
        expect(overlayStore.get().active).toBe('implementer-picker');
      });
      configStore.__testReset({
        projectDir,
        config: makeConfig({
          planner,
          reviewer,
          implementer: { kind: 'cli', tool: 'claude-code' },
        }),
      });
      pickerViewStore.setCommitted(true);
      overlayStore.close();
      await vi.waitFor(() => {
        expect(run.returned()).toBe(2);
      });

      expect(run.entered[1]?.config.implementer).toMatchObject({ tool: 'claude-code' });
      expect(run.entered[1]?.config.reviewer).toMatchObject(reviewer);
      expect(configStore.get().config?.reviewer).toMatchObject(reviewer);

      inst.unmount();
    });

    it.each([
      ['Try again', 'retry'],
      ['Change BUILD tool', 'switch'],
    ])(
      'keeps the pause the operator asked for when %s takes a seat saved under the same brief',
      async (_answer, typed) => {
        const sessionId = '2026-10-19-pause-save-halt';
        const captureRunner: HarnessProps['captureRunner'] = { current: null };
        const prepared = preparedExecution({ projectDir, feature: 'add auth', sessionId });
        configStore.__testReset({ projectDir, config: prepared.config });
        const { promise: saved, resolve: savedNow } = Promise.withResolvers<void>();
        const reentry = engineEntryAfterHalt();
        const run = recordedEngine({
          1: async () => {
            await saved;
            saveSeatDownHalt(sessionId);
            return makeSummary();
          },
          2: reentry.engine,
        });

        const inst = renderHarness({ prepared, captureRunner, runWorkflow: run.engine });
        await vi.waitFor(() => {
          expect(run.entered).toHaveLength(1);
        });
        lifecycleStore.__testReset({ phase: 'implementing', status: 'running' });
        requestBoundaryPause();
        configStore.__testReset({ projectDir, config: CODEX_SEAT_SAVED });
        savedNow();
        await answerRecoveryPanel(captureRunner, typed);
        if (typed === 'switch') {
          await vi.waitFor(() => {
            expect(overlayStore.get().active).toBe('implementer-picker');
          });
          configStore.__testReset({ projectDir, config: CLAUDE_CODE_SEAT_SAVED });
          pickerViewStore.setCommitted(true);
          overlayStore.close();
        }
        await vi.waitFor(() => {
          expect(run.returned()).toBe(2);
        });

        expect(reentry.seen()).toMatchObject({
          intent: 'pause-after-brief',
          pausedAtBoundary: true,
        });

        inst.unmount();
      },
    );

    describe('the halt picker with its keys', () => {
      const planner = { kind: 'agent', command: 'splitbrief-non-existent-planner-x7q9' } as const;
      const claudeWithCustomModels = makeConfig({
        planner,
        implementer: { kind: 'cli', tool: 'claude-code', customModels: ['my-a', 'my-b'] },
      });

      afterEach(() => {
        detectionStore.reset();
        pickerViewStore.reset();
      });

      /** A run whose first pass halts Seat down on BUILD, rendered with the real BUILD picker. */
      function haltWithPicker(sessionId: string, beforeHalt?: Promise<void>) {
        const captureRunner: HarnessProps['captureRunner'] = { current: null };
        const prepared = preparedExecution({ projectDir, feature: 'add auth', sessionId });
        configStore.__testReset({ projectDir, config: prepared.config });
        detectionStore.setDetection({
          cliTools: [cliDetectionFor('ready', 'claude-code')],
          providers: [],
        });
        const reentry = engineEntryAfterHalt();
        const continueAtRest = vi.fn();
        const run = recordedEngine({
          1: async () => {
            await beforeHalt;
            saveSeatDownHalt(sessionId);
            return makeSummary();
          },
          2: reentry.engine,
        });
        const inst = renderHarnessWithPicker({
          prepared,
          captureRunner,
          runWorkflow: run.engine,
          continueAtRest,
        });
        return { captureRunner, prepared, reentry, continueAtRest, run, inst };
      }

      async function openHaltPicker(
        captureRunner: NonNullable<HarnessProps['captureRunner']>,
      ): Promise<void> {
        await answerRecoveryPanel(captureRunner, 'switch');
        await vi.waitFor(() => {
          expect(overlayStore.get().active).toBe('implementer-picker');
        });
        await tick(100);
      }

      function switchWarnings(): string[] {
        return eventsStore
          .get()
          .events.flatMap((event) =>
            event.type === 'warning' && event.message.includes('Could not switch')
              ? [event.message]
              : [],
          );
      }

      it('switches the seat when the picker takes a row and closes', async () => {
        const halt = haltWithPicker('2026-10-19-halt-picker-take');
        await vi.waitFor(() => {
          expect(controlsStore.get().inputMode).toBe('question');
        });
        lifecycleStore.__testReset({ phase: 'implementing', status: 'running' });
        configStore.__testReset({ projectDir, config: CLAUDE_CODE_SEAT_SAVED });
        await openHaltPicker(halt.captureRunner);
        // The picker unmounts when its overlay closes; the take is still read as a take.
        halt.inst.stdin.write('\r');
        await tick(100);
        halt.inst.stdin.write('\r');
        await vi.waitFor(() => {
          expect(halt.run.returned()).toBe(2);
        });

        expect(halt.run.entered[1]?.config.implementer).toMatchObject({ tool: 'claude-code' });
        expect(loadState(halt.prepared.session.ref)?.seatSwitches).toEqual([
          expect.objectContaining({ seat: 'build', cause: 'runner-usage-limit' }),
        ]);

        halt.inst.unmount();
      });

      it('keeps the halt when Escape closes the picker after Ctrl+D deleted a custom model', async () => {
        const halt = haltWithPicker('2026-10-19-halt-picker-delete');
        await vi.waitFor(() => {
          expect(controlsStore.get().inputMode).toBe('question');
        });
        lifecycleStore.__testReset({ phase: 'implementing', status: 'running' });
        configStore.__testReset({ projectDir, config: claudeWithCustomModels });
        await openHaltPicker(halt.captureRunner);
        // Up twice from the focused row lands on the last custom model, My B.
        halt.inst.stdin.write('\u001B[A');
        await tick(60);
        halt.inst.stdin.write('\u001B[A');
        await tick(60);
        halt.inst.stdin.write('\u0004');
        await vi.waitFor(() => {
          expect(configStore.get().config?.implementer).toMatchObject({ customModels: ['my-a'] });
        });
        expect(overlayStore.get().active).toBe('implementer-picker');
        halt.inst.stdin.write('\u001B');
        await vi.waitFor(() => {
          expect(overlayStore.get().active).toBe('none');
        });
        await vi.waitFor(() => {
          expect(controlsStore.get().inputMode).toBe('question');
        });
        await tick(100);

        expect(halt.run.entered).toHaveLength(1);
        expect(loadState(halt.prepared.session.ref)?.seatSwitches ?? []).toEqual([]);
        expect(switchWarnings()).toEqual([]);

        halt.inst.unmount();
      });

      it.each([
        ['BUILD', CODEX_SEAT_SAVED],
        ['REVIEW', makeConfig({ planner, reviewer: { kind: 'cli', tool: 'codex' } })],
      ])(
        'starts the next brief with no pause when a %s seat saved under the brief is taken by the swap',
        async (_seat, savedUnderBrief) => {
          const { promise: saved, resolve: savedNow } = Promise.withResolvers<void>();
          const halt = haltWithPicker('2026-10-19-brief-save-halt-swap', saved);
          await vi.waitFor(() => {
            expect(halt.run.entered).toHaveLength(1);
          });
          lifecycleStore.__testReset({ phase: 'implementing', status: 'running' });
          configStore.__testReset({ projectDir, config: savedUnderBrief });
          expect(stopStore.get()).toMatchObject({ intent: 'none', seatChange: true });
          savedNow();
          await openHaltPicker(halt.captureRunner);
          halt.inst.stdin.write('\r');
          await tick(100);
          halt.inst.stdin.write('\r');
          await vi.waitFor(() => {
            expect(halt.run.returned()).toBe(2);
          });

          expect(halt.run.entered[1]?.config.implementer).toMatchObject({ tool: 'claude-code' });
          expect(halt.run.entered[1]?.config.reviewer).toEqual(savedUnderBrief.reviewer);
          expect(halt.reentry.seen()).toMatchObject({ intent: 'none', pausedAtBoundary: false });
          expect(halt.continueAtRest).not.toHaveBeenCalled();

          halt.inst.unmount();
        },
      );

      describe('a halt on a named BUILD profile', () => {
        const profileConfig = makeConfig({
          planner,
          implementer: { kind: 'cli', tool: 'codex' },
          implementerProfiles: {
            default: 'big',
            profiles: {
              big: { kind: 'cli', tool: 'codex' },
              small: { kind: 'cli', tool: 'opencode' },
            },
          },
        });

        /** A run whose first pass halts Seat down on the `small` profile; its second pass records its state. */
        function haltOnSmall(sessionId: string) {
          const captureRunner: HarnessProps['captureRunner'] = { current: null };
          const prepared = preparedExecution({
            projectDir,
            feature: 'add auth',
            sessionId,
            implementer: profileConfig.implementer,
            implementerProfiles: profileConfig.implementerProfiles,
          });
          configStore.__testReset({ projectDir, config: profileConfig });
          detectionStore.setDetection({
            cliTools: [cliDetectionFor('ready', 'claude-code')],
            providers: [],
          });
          let entryState: WorkflowState | undefined;
          const run = recordedEngine({
            1: async () => {
              const halted = makeImplState([makeTask({ id: 'T001', status: 'failed' })], {
                ...RUN_CREW,
                pendingRecovery: makeRecoveryIssue({
                  reason: 'runner-usage-limit',
                  seat: 'build',
                  selectedImplementerProfile: 'small',
                  availableActions: ['retry-same-worker', 'switch-seat', 'end-run'],
                  recommendedAction: 'switch-seat',
                  switchSeat: { seat: 'build', candidates: [{ tool: 'claude-code' }] },
                }),
              });
              saveState({ projectDir, sessionId }, halted);
              return makeSummary();
            },
            2: async (options) => {
              entryState = options.savedState;
              return makeSummary();
            },
          });
          const inst = renderHarnessWithPicker({
            prepared,
            captureRunner,
            runWorkflow: run.engine,
          });
          return { captureRunner, prepared, run, inst, entryState: () => entryState };
        }

        function savedProfiles() {
          return configStore.get().config?.implementerProfiles;
        }

        it('moves the brief to the picked tool on its own profile, also after a reopen', async () => {
          const halt = haltOnSmall('2026-10-21-halt-on-small-switch');
          await openHaltPicker(halt.captureRunner);
          halt.inst.stdin.write('\r');
          await tick(100);
          halt.inst.stdin.write('\r');
          await vi.waitFor(() => {
            expect(halt.run.returned()).toBe(2);
          });

          expect(savedProfiles()).toMatchObject({
            default: 'big',
            profiles: { big: { tool: 'codex' }, small: { tool: 'claude-code' } },
          });
          const pin = { taskId: 'T001', profile: 'small' };
          expect(halt.entryState()?.retryProfile).toEqual(pin);
          expect(loadState(halt.prepared.session.ref)?.retryProfile).toEqual(pin);

          halt.inst.unmount();
        });

        it('saves /crew build to the halted profile, and Try again runs the brief on it', async () => {
          const halt = haltOnSmall('2026-10-21-halt-on-small-crew');
          await vi.waitFor(() => {
            expect(controlsStore.get().inputMode).toBe('question');
          });
          // `/crew build` opens the BUILD seat's picker while the halt waits.
          overlayStore.open('implementer-picker', toolRowFocus('claude-code'));
          await tick(100);
          halt.inst.stdin.write('\r');
          await tick(100);
          halt.inst.stdin.write('\r');
          await vi.waitFor(() => {
            expect(overlayStore.get().active).toBe('none');
          });

          expect(savedProfiles()).toMatchObject({
            default: 'big',
            profiles: { big: { tool: 'codex' }, small: { tool: 'claude-code' } },
          });

          await answerRecoveryPanel(halt.captureRunner, 'retry');
          await vi.waitFor(() => {
            expect(halt.run.returned()).toBe(2);
          });

          expect(halt.run.entered[1]?.config.implementerProfiles?.profiles.small).toMatchObject({
            tool: 'claude-code',
          });
          expect(halt.entryState()?.retryProfile).toEqual({ taskId: 'T001', profile: 'small' });

          halt.inst.unmount();
        });
      });
    });

    it('requests no pause when Settings saves another key while a halt waits and a seat is on auto', async () => {
      const sessionId = '2026-10-19-unrelated-save-halt';
      const captureRunner: HarnessProps['captureRunner'] = { current: null };
      const onAuto = makeConfig({
        planner: { kind: 'agent', command: 'splitbrief-non-existent-planner-x7q9' },
        implementer: { kind: 'cli', tool: 'codex', model: 'auto' },
      });
      writeConfig(projectDir, onAuto);
      configStore.load(projectDir);
      // Preparation names the model the seat leaves to its tool; the config it read keeps `auto`.
      const prepared = {
        ...preparedExecution({
          projectDir,
          feature: 'add auth',
          sessionId,
          implementer: { kind: 'cli', tool: 'codex', model: 'gpt-5.5' },
        }),
        sourceConfig: parsePreparedConfig(onAuto),
      };
      let pausedAtBoundary: boolean | undefined;
      const run = recordedEngine({
        1: async () => {
          saveHaltedRun(sessionId);
          return makeSummary();
        },
        2: async (options) => {
          pausedAtBoundary = options.sinks.consumeBoundaryPause?.();
          return makeSummary();
        },
      });

      const inst = renderHarness({ prepared, captureRunner, runWorkflow: run.engine });
      await vi.waitFor(() => {
        expect(controlsStore.get().inputMode).toBe('question');
      });
      lifecycleStore.__testReset({ phase: 'implementing', status: 'running' });
      const current = configStore.get().config;
      if (current === null) throw new Error('expected a loaded config');
      const saved = await configStore.save({
        ...current,
        workflow: { ...current.workflow, approve: 'none' },
      });
      await answerRecoveryPanel(captureRunner, 'retry');
      await vi.waitFor(() => {
        expect(run.returned()).toBe(2);
      });

      expect(saved.kind).toBe('saved');
      expect(pausedAtBoundary).toBe(false);
      expect(stopStore.get().intent).toBe('none');

      inst.unmount();
    });

    it('requests no pause on entry when the preparation named the model a seat left to its tool', async () => {
      const sessionId = '2026-10-19-host-model-entry';
      const noModel = makeConfig({
        planner: { kind: 'agent', command: 'splitbrief-non-existent-planner-x7q9' },
        implementer: { kind: 'cli', tool: 'codex' },
      });
      // Preparation writes the tool's own selection into the prepared config of a seat with no model.
      const prepared = {
        ...preparedExecution({
          projectDir,
          feature: 'add auth',
          sessionId,
          implementer: { kind: 'cli', tool: 'codex', model: 'gpt-5.5' },
        }),
        sourceConfig: parsePreparedConfig(noModel),
      };
      configStore.__testReset({ projectDir, config: noModel });
      let pausedAtBoundary: boolean | undefined;
      const run = recordedEngine({
        1: async (options) => {
          pausedAtBoundary = options.sinks.consumeBoundaryPause?.();
          return makeSummary();
        },
      });

      const inst = renderHarness({ prepared, runWorkflow: run.engine });
      await vi.waitFor(() => {
        expect(run.returned()).toBe(1);
      });

      expect(pausedAtBoundary).toBe(false);
      expect(stopStore.get().intent).toBe('none');

      inst.unmount();
    });

    it('releases the receipt its re-entry took when a later halt is answered by ending the run', async () => {
      const sessionId = '2026-09-23-start-end-after-retry';
      const captureRunner: HarnessProps['captureRunner'] = { current: null };
      const prepared = preparedExecution({ projectDir, feature: 'add auth', sessionId });
      const halt: RunWorkflowFn = async () => {
        saveHaltedRun(sessionId);
        return makeSummary();
      };
      const run = recordedEngine({ 1: halt, 2: halt });

      const inst = renderHarness({ prepared, captureRunner, runWorkflow: run.engine });
      await answerRecoveryPanel(captureRunner, 'retry');
      await vi.waitFor(() => {
        expect(run.returned()).toBe(2);
      });
      await vi.waitFor(() => {
        expect(controlsStore.get().inputMode).toBe('question');
      });
      // The retry re-prepared the session, so the receipt on disk is no longer the first one.
      const reprepared = readActiveRecord(projectDir);
      expect(reprepared).toEqual({ kind: 'v1', receipt: expect.objectContaining({ sessionId }) });
      expect(reprepared).not.toEqual({ kind: 'v1', receipt: prepared.session.active });

      expect(requestEndRun()).toBe(true);
      await vi.waitFor(() => {
        expect(settledRun()?.status).toEqual({ kind: 'closed', as: 'ended' });
      });

      expect(readActive(projectDir)).toBeNull();

      inst.unmount();
    });

    it('leaves the run open at rest when its tools are not admitted again', async () => {
      const sessionId = '2026-09-23-start-blocked';
      const captureRunner: HarnessProps['captureRunner'] = { current: null };
      const prepared = preparedExecution({ projectDir, feature: 'add auth', sessionId });
      const run = recordedEngine({
        1: async () => {
          saveHaltedRun(sessionId);
          return makeSummary();
        },
      });
      const blocked: PrepareExecutionFn = async () => ({
        kind: 'blocked',
        report: { ...prepared.report, status: 'blocked' },
      });

      const inst = renderHarness({
        prepared,
        captureRunner,
        runWorkflow: run.engine,
        prepareExecution: blocked,
      });
      await answerRecoveryPanel(captureRunner, 'retry');
      await vi.waitFor(() => {
        expect(settledRun()?.status.kind).toBe('open');
      });

      expect(run.entered).toHaveLength(1);
      expect(errorMessages()).toEqual(['Cannot resume: Readiness blocked.']);

      inst.unmount();
    });

    it('records the stop when the operator stops the run while it is admitted again', async () => {
      const sessionId = '2026-09-23-start-stopped';
      const captureRunner: HarnessProps['captureRunner'] = { current: null };
      const prepared = preparedExecution({ projectDir, feature: 'add auth', sessionId });
      const run = recordedEngine({
        1: async () => {
          saveHaltedRun(sessionId);
          return makeSummary();
        },
      });
      let preparing = false;
      const waitForStop: PrepareExecutionFn = async (input) => {
        preparing = true;
        await new Promise<void>((resolve) => {
          input.signal.addEventListener('abort', () => resolve(), { once: true });
        });
        return { kind: 'aborted' };
      };

      const inst = renderHarness({
        prepared,
        captureRunner,
        runWorkflow: run.engine,
        prepareExecution: waitForStop,
      });
      await answerRecoveryPanel(captureRunner, 'retry');
      await vi.waitFor(() => {
        expect(preparing).toBe(true);
      });
      expect(requestStopNow()).toBe(true);
      await vi.waitFor(() => {
        expect(stopStore.get().phase).toBe('parked');
      });

      expect(run.entered).toHaveLength(1);
      const saved = loadState(prepared.session.ref);
      expect(saved?.interruptedStep?.cut).toBe('mid-step');
      expect(saved?.pendingRecovery).toBeUndefined();
      expect(settledRun()?.status.kind).toBe('open');
      expect(
        (await readRunEvents(prepared.session.ref)).events.filter(
          (event) => event.type === 'turn_interrupted',
        ),
      ).toMatchObject([
        {
          source: 'user',
          at: 'mid-step',
          step: saved?.interruptedStep?.step,
        },
      ]);

      inst.unmount();
    });
  });
});
