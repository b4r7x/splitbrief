import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { makeConfig } from '#testing/helpers/factories/config.js';
import { makeSession } from '#testing/helpers/factories/session.js';
import { flushEffects, renderFeature, tick } from '#testing/helpers/ink.js';
import { cleanupTempDir, createTempDir } from '#testing/helpers/temp-dir.js';
import type { ReadinessReport } from '../core/readiness/types.js';
import {
  readActive,
  reactivateExistingSession,
  type ActiveSessionReceipt,
} from '../core/sessions/lifecycle.js';
import { createInitialState } from '../core/state/machine.js';
import type { WorkflowState } from '../core/schemas/workflow.js';
import {
  parsePreparedConfig,
  type PreparationOutcome,
  type PreparedExecution,
} from '../engine/runners/prepared-execution.js';
import { closeApprovalPrompt, openApprovalPrompt } from '../stores/approval-prompt/prompt.js';
import {
  handleSessionSelect,
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
    const session = makeSession({
      id: 'resume-escape',
      feature: 'resume with escape',
      status: 'interrupted',
      summary: null,
    });
    const state = { ...createInitialState(session.feature), phase: 'implementing' as const };
    const pending = Promise.withResolvers<PreparationOutcome>();
    let signal: AbortSignal | undefined;
    const deps: SessionSelectDeps = {
      loadState: () => state,
      prepareResume: (_input, attemptSignal) => {
        signal = attemptSignal;
        return pending.promise;
      },
    };
    const ui = renderFeature(<SessionPreparation />);
    overlayStore.open('sessions');

    const selection = handleSessionSelect(session, projectDir, deps);
    await flushEffects();
    expect(ui.lastFrame() ?? '').toContain('Preparing your tools…');
    expect(ui.lastFrame() ?? '').toContain('before continuing');
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
    const session = makeSession({
      id: 'resume-approval',
      feature: 'resume with approval',
      status: 'interrupted',
      summary: null,
    });
    const state = { ...createInitialState(session.feature), phase: 'implementing' as const };
    let approvalSettled = false;
    const deps: SessionSelectDeps = {
      loadState: () => state,
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

    const selection = handleSessionSelect(session, projectDir, deps);
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
    const session = makeSession({
      id: 'resume-unmount',
      feature: 'resume then unmount',
      status: 'interrupted',
      summary: null,
    });
    const state = { ...createInitialState(session.feature), phase: 'implementing' as const };
    const pending = Promise.withResolvers<PreparationOutcome>();
    let signal: AbortSignal | undefined;
    const ui = renderFeature(<SessionPreparation />);
    const selection = handleSessionSelect(session, projectDir, {
      loadState: () => state,
      prepareResume: (_input, attemptSignal) => {
        signal = attemptSignal;
        return pending.promise;
      },
    });
    await flushEffects();

    ui.unmount();
    expect(signal?.aborted).toBe(true);

    const active = reactivateExistingSession({ projectDir, sessionId: session.id });
    pending.resolve({
      kind: 'prepared',
      execution: preparedExecution(projectDir, session.id, state, active),
    });
    await selection;

    expect(readActive(projectDir)).toBeNull();
    expect(routerStore.get().screen).toBe('home');
  });

  it('Retry starts a fresh attempt and routes only its exact prepared result', async () => {
    const session = makeSession({
      id: 'resume-retry',
      feature: 'resume after retry',
      status: 'interrupted',
      summary: null,
    });
    const state = { ...createInitialState(session.feature), phase: 'implementing' as const };
    let calls = 0;
    const prepareResume = vi.fn<SessionSelectDeps['prepareResume']>(async () => {
      calls += 1;
      if (calls === 1) return { kind: 'blocked', report: blockedReport() };
      const active = reactivateExistingSession({ projectDir, sessionId: session.id });
      return {
        kind: 'prepared',
        execution: preparedExecution(projectDir, session.id, state, active),
      };
    });
    const ui = renderFeature(<SessionPreparation />);

    await handleSessionSelect(session, projectDir, {
      loadState: () => state,
      prepareResume,
    });
    await flushEffects();
    expect(ui.lastFrame() ?? '').toContain('r retry');

    ui.stdin.write('r');
    await vi.waitFor(() => expect(routerStore.get().screen).toBe('workflow'));
    expect(prepareResume).toHaveBeenCalledTimes(2);
    const route = routerStore.get();
    if (route.screen === 'workflow' && route.execution.kind === 'local') {
      expect(route.execution.prepared.preparationId).toBe(`resume-${session.id}`);
    }
    ui.unmount();
  });
});
