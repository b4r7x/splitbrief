import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { makeConfig } from '#testing/helpers/factories/config.js';
import { makeRunRecord } from '#testing/helpers/factories/run-record.js';
import { flushEffects, renderFeature, tick } from '#testing/helpers/ink.js';
import { cleanupTempDir, createTempDir } from '#testing/helpers/temp-dir.js';
import type { ReadinessReport } from '../core/readiness/types.js';
import {
  readActive,
  reactivateExistingSession,
  type ActiveSessionReceipt,
} from '../core/sessions/active-pointer.js';
import { createInitialState } from '../core/state/machine.js';
import type { WorkflowState } from '../core/schemas/workflow.js';
import {
  parsePreparedConfig,
  type PreparationOutcome,
  type PreparedExecution,
} from '../engine/runners/prepared-execution.js';
import { closeApprovalPrompt, openApprovalPrompt } from '../stores/approval-prompt/prompt.js';
import {
  continueRunInPlace,
  sessionSelectStore,
  type SessionSelectDeps,
} from '../stores/navigation/session-select.js';
import { routerStore } from '../stores/navigation/router.js';
import { overlayStore } from '../stores/ui/overlay.js';
import { PROMPT_TYPEAHEAD_GRACE_MS } from '../lib/terminal/typeahead-grace.js';
import { SessionPreparation } from './session-preparation.js';

const ESC = '\u001b';

function readyReport(): ReadinessReport {
  return {
    generatedAt: '2026-08-04T00:00:00.000Z',
    projectDir: '/project',
    status: 'ready',
    counts: { ok: 1, info: 0, warning: 0, blocker: 0 },
    nextAction: { kind: 'continue', label: 'Continue', reason: 'Ready.' },
    sections: [],
    metadata: {},
  };
}

function blockedReport(): ReadinessReport {
  return {
    ...readyReport(),
    status: 'blocked',
    counts: { ok: 0, info: 0, warning: 0, blocker: 1 },
    nextAction: { kind: 'exit', label: 'Exit', reason: 'Fix the configured runner.' },
    sections: [
      {
        id: 'runners',
        title: 'Runners',
        checks: [
          {
            id: 'runners.preparation.planner',
            severity: 'blocker',
            summary: 'The configured runner could not be admitted.',
          },
        ],
      },
    ],
  };
}

function preparedExecution(
  projectDir: string,
  sessionId: string,
  state: WorkflowState,
  active: ActiveSessionReceipt,
): PreparedExecution {
  return {
    purpose: 'resume',
    config: parsePreparedConfig(makeConfig()),
    preparationId: `resume-${sessionId}`,
    report: readyReport(),
    gates: [],
    session: {
      kind: 'existing',
      ref: { projectDir, sessionId },
      active,
    },
    runtime: {
      feature: state.feature,
      resumeState: state,
      allowRepoRunners: false,
      allowHooks: false,
    },
  };
}

/** The run is already on its screen when a continuation prepares its tools. */
function showAtRest(projectDir: string, sessionId: string, feature: string) {
  const record = makeRunRecord({
    ref: { projectDir, sessionId },
    feature,
    status: { kind: 'open', stop: { kind: 'interrupted' }, resumeAt: { kind: 'review', cycle: 0 } },
  });
  routerStore.navigate({ to: 'workflow', run: record, execution: { kind: 'at-rest' } });
  return record;
}

describe('SessionPreparation', () => {
  let projectDir = '';

  beforeEach(() => {
    projectDir = createTempDir('session-preparation-test');
    sessionSelectStore.reset();
    routerStore.reset();
    overlayStore.reset();
    closeApprovalPrompt();
  });

  afterEach(() => {
    closeApprovalPrompt();
    sessionSelectStore.reset();
    routerStore.reset();
    overlayStore.reset();
    cleanupTempDir(projectDir);
    projectDir = '';
  });

  it('shows generic preparation and Escape cancels the caller signal and restores its picker', async () => {
    const record = showAtRest(projectDir, 'resume-escape', 'resume with escape');
    const state = { ...createInitialState(record.feature), phase: 'implementing' as const };
    const pending = Promise.withResolvers<PreparationOutcome>();
    let signal: AbortSignal | undefined;
    const deps: SessionSelectDeps = {
      hydrateRun: async () => {},
      loadResumeState: () => ({ kind: 'loaded', state }),
      prepareResume: (_input, attemptSignal) => {
        signal = attemptSignal;
        return pending.promise;
      },
    };
    const ui = renderFeature(<SessionPreparation />);
    overlayStore.open('sessions');

    const selection = continueRunInPlace({ record, state, deps });
    await flushEffects();
    expect(ui.lastFrame() ?? '').toContain('Preparing your tools…');
    expect(ui.lastFrame() ?? '').toContain('Checking your configured runners');
    expect(overlayStore.get().active).toBe('none');

    ui.stdin.write(ESC);
    await flushEffects();
    expect(signal?.aborted).toBe(true);
    expect(sessionSelectStore.get().preparation.kind).toBe('idle');
    expect(overlayStore.get().active).toBe('sessions');

    pending.resolve({ kind: 'aborted' });
    await selection;
    ui.unmount();
  });

  it('closes the originating overlay before a tiered approval owns input', async () => {
    const record = showAtRest(projectDir, 'resume-approval', 'resume with approval');
    const state = { ...createInitialState(record.feature), phase: 'implementing' as const };
    let approvalSettled = false;
    const deps: SessionSelectDeps = {
      hydrateRun: async () => {},
      loadResumeState: () => ({ kind: 'loaded', state }),
      prepareResume: async () => {
        await openApprovalPrompt({
          tier: 'confirm',
          actionClass: 'network',
          actionDescription: 'Approve the configured runner for this resume',
          phase: 'implementing',
        });
        approvalSettled = true;
        return { kind: 'blocked', report: blockedReport() };
      },
      cancelPendingApproval: closeApprovalPrompt,
    };
    const ui = renderFeature(<SessionPreparation />);
    overlayStore.open('sessions');

    const selection = continueRunInPlace({ record, state, deps });
    await vi.waitFor(() => {
      expect(ui.lastFrame() ?? '').toContain('Approve the configured runner for this resume');
    });
    expect(overlayStore.get().active).toBe('none');
    expect(ui.lastFrame() ?? '').not.toContain('Sessions');

    await tick(PROMPT_TYPEAHEAD_GRACE_MS + 30);
    closeApprovalPrompt();
    await selection;
    expect(approvalSettled).toBe(true);
    expect(ui.lastFrame() ?? '').toContain('Tool preparation');
    ui.unmount();
  });

  it('unmount cancels the attempt and exact-clears a prepared result that arrives later', async () => {
    const record = showAtRest(projectDir, 'resume-unmount', 'resume then unmount');
    const state = { ...createInitialState(record.feature), phase: 'implementing' as const };
    const pending = Promise.withResolvers<PreparationOutcome>();
    let signal: AbortSignal | undefined;
    const ui = renderFeature(<SessionPreparation />);
    const selection = continueRunInPlace({
      record,
      state,
      deps: {
        hydrateRun: async () => {},
        loadResumeState: () => ({ kind: 'loaded', state }),
        prepareResume: (_input, attemptSignal) => {
          signal = attemptSignal;
          return pending.promise;
        },
      },
    });
    await flushEffects();

    ui.unmount();
    expect(signal?.aborted).toBe(true);

    const active = reactivateExistingSession({ projectDir, sessionId: record.ref.sessionId });
    pending.resolve({
      kind: 'prepared',
      execution: preparedExecution(projectDir, record.ref.sessionId, state, active),
    });
    await selection;

    // The abandoned attempt releases the session it claimed, and the run stays the resting one
    // it already was rather than becoming the run this process drives.
    expect(readActive(projectDir)).toBeNull();
    const route = routerStore.get();
    expect(route.screen).toBe('workflow');
    if (route.screen !== 'workflow') throw new Error('expected the workflow route');
    expect(route.execution.kind).toBe('at-rest');
  });

  it('Retry starts a fresh attempt and routes only its exact prepared result', async () => {
    const record = showAtRest(projectDir, 'resume-retry', 'resume after retry');
    const state = { ...createInitialState(record.feature), phase: 'implementing' as const };
    const sessionId = record.ref.sessionId;
    let calls = 0;
    const prepareResume = vi.fn<SessionSelectDeps['prepareResume']>(async () => {
      calls += 1;
      if (calls === 1) return { kind: 'blocked', report: blockedReport() };
      const active = reactivateExistingSession({ projectDir, sessionId });
      return {
        kind: 'prepared',
        execution: preparedExecution(projectDir, sessionId, state, active),
      };
    });
    const ui = renderFeature(<SessionPreparation />);

    await continueRunInPlace({
      record,
      state,
      deps: {
        hydrateRun: async () => {},
        loadResumeState: () => ({ kind: 'loaded', state }),
        prepareResume,
      },
    });
    await flushEffects();
    expect(ui.lastFrame() ?? '').toContain('r retry');

    ui.stdin.write('r');
    await vi.waitFor(() => {
      const current = routerStore.get();
      expect(current.screen === 'workflow' && current.execution.kind === 'local').toBe(true);
    });
    expect(prepareResume).toHaveBeenCalledTimes(2);
    const route = routerStore.get();
    if (route.screen !== 'workflow') throw new Error('expected the workflow route');
    if (route.execution.kind !== 'local') throw new Error('expected a local execution');
    expect(route.execution.prepared.preparationId).toBe(`resume-${sessionId}`);
    ui.unmount();
  });
});
