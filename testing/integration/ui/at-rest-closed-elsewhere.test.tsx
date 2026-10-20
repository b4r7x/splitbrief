import { Text } from 'ink';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { renderFeature } from '#testing/helpers/ink.js';
import { stripAnsiStyles } from '#testing/helpers/ansi.js';
import { makeConfig } from '#testing/helpers/factories/config.js';
import { makeSession } from '#testing/helpers/factories/session.js';
import { makePreparedExecution } from '#testing/helpers/factories/prepared-execution.js';
import { makeRunRecord } from '#testing/helpers/factories/run-record.js';
import { createTempDir, cleanupTempDir } from '#testing/helpers/temp-dir.js';
import { resetAllStores } from '#testing/helpers/stores.js';
import { WorkflowScreen } from '../../../src/app/screens/workflow.js';
import type { WorkflowScreenDeps } from '../../../src/features/workflow/hooks/workflow-screen/use-model.js';
import type { SessionSelectDeps } from '../../../src/stores/navigation/session-select.js';
import { handleSessionSelect } from '../../../src/stores/navigation/session-select.js';
import { loadOwnerWorkflowState } from '../../../src/core/state/resume-hydration.js';
import { hydrateRun, readRunHistory } from '../../../src/features/workflow/run-history.js';
import { createInitialState } from '../../../src/core/state/machine.js';
import { saveState } from '../../../src/core/state/persistence.js';
import { endRunAtRest } from '../../../src/engine/orchestrator/run/close.js';
import { createRecoveryBus } from '../../../src/engine/orchestrator/recovery/bus.js';
import { routerStore } from '../../../src/stores/navigation/router.js';
import { configStore } from '../../../src/stores/project/config.js';
import { sessionsStore } from '../../../src/stores/project/sessions.js';
import { terminalSizeStore } from '../../../src/stores/ui/terminal-size.js';
import { stopStore } from '../../../src/stores/workflow/stop.js';
import { overlayStore } from '../../../src/stores/ui/overlay.js';
import { feedbackStore } from '../../../src/stores/ui/feedback.js';
import { eventsStore } from '../../../src/stores/workflow/events.js';
import { addEvent } from '../../../src/stores/workflow/actions/event.js';
import { useInputMode } from '../../../src/features/workflow/hooks/use-input-mode.js';
import {
  useRunContinue,
  type UseRunContinueResult,
} from '../../../src/features/workflow/hooks/use-run-continue.js';
import type { PreparedExecution } from '../../../src/engine/runners/prepared-execution.js';

const VIEWPORT = { cols: 120, rows: 40 } as const;

let projectDir = '';
let ui: ReturnType<typeof renderFeature> | undefined;

beforeEach(() => {
  resetAllStores();
  routerStore.init({ screen: 'home' });
  projectDir = createTempDir('at-rest-closed-elsewhere');
});

afterEach(() => {
  ui?.unmount();
  ui = undefined;
  resetAllStores();
  routerStore.init({ screen: 'home' });
  cleanupTempDir(projectDir);
});

describe('a run at rest that another process closes', () => {
  it.each(['hydrateRun', 'readRunHistory'] as const)(
    'clears the previous local stop when opening a run through %s',
    async (history) => {
      const sessionId = 'another-run';
      saveState({ projectDir, sessionId }, createInitialState('Another run'));
      stopStore.request('pause-after-brief');
      stopStore.markSeatChange(true);
      stopStore.park('boundary', null, () => {});

      await handleSessionSelect(makeSession({ id: sessionId }), projectDir, {
        applying: () => false,
        loadResumeState: loadOwnerWorkflowState,
        prepareResume: vi.fn(),
        hydrateRun,
        ...(history === 'readRunHistory' && { readRunHistory }),
      });

      expect(stopStore.get()).toEqual({
        intent: 'none',
        phase: 'idle',
        requestedAt: null,
        parked: null,
        seatChange: false,
      });
    },
  );

  it('refreshes a changed session log without resetting the local stop', async () => {
    const ref = { projectDir, sessionId: 'parked-log-refresh' };
    saveState(ref, { ...createInitialState('Keep the local stop'), phase: 'planning' });
    const config = makeConfig();
    configStore.__testReset({ config, projectDir });
    terminalSizeStore.__testReset({ ...VIEWPORT, isSmall: false });
    routerStore.init({
      screen: 'workflow',
      run: makeRunRecord({ ref }),
      execution: { kind: 'at-rest' },
    });
    ui = renderFeature(
      <WorkflowScreen commands={[]} onRuntimeCommand={vi.fn()} deps={{ runWorkflow: vi.fn() }} />,
      VIEWPORT,
    );
    await vi.waitFor(() => {
      expect(eventsStore.get().events.some((event) => event.type === 'replay_complete')).toBe(true);
    });
    stopStore.request('stop-now');
    stopStore.park('mid-brief', null, null);
    overlayStore.open('stop-sheet');
    const stop = stopStore.get();

    createRecoveryBus({ ...ref, sink: () => {} }).publish({
      type: 'planner_text',
      ts: Date.now(),
      phase: 'planning',
      role: 'planner',
      content: 'plain',
      text: 'New session history.',
    });

    await vi.waitFor(() => {
      expect(eventsStore.get().events).toContainEqual(
        expect.objectContaining({ type: 'planner_text', text: 'New session history.' }),
      );
    });
    expect(stopStore.get()).toBe(stop);
    expect(overlayStore.get().active).toBe('stop-sheet');
    expect(stripAnsiStyles(ui.lastFrame() ?? '')).toContain('Resume');
  });

  it('paints closed without input, drops its stop options and lists it as ended', async () => {
    const sessionId = 'closed-elsewhere-session';
    const feature = 'add a word counter';
    const savedState = { ...createInitialState(feature), phase: 'planning' as const };
    saveState({ projectDir, sessionId }, savedState);
    const config = makeConfig();

    const runWorkflow = vi.fn();
    const sessionSelect: SessionSelectDeps = {
      applying: () => false,
      loadResumeState: loadOwnerWorkflowState,
      prepareResume: vi.fn(),
      hydrateRun,
      readRunHistory,
    };
    const deps: WorkflowScreenDeps = { runWorkflow, sessionSelect };

    configStore.__testReset({ config, projectDir });
    terminalSizeStore.__testReset({ ...VIEWPORT, isSmall: false });
    sessionsStore.load(projectDir);
    await handleSessionSelect(
      makeSession({ id: sessionId, feature, status: 'open' }),
      projectDir,
      sessionSelect,
    );
    // The screen still offers the stop menu of a run it stopped itself.
    stopStore.park('mid-brief', null, null);
    overlayStore.open('stop-sheet');

    ui = renderFeature(
      <WorkflowScreen commands={[]} onRuntimeCommand={vi.fn()} deps={deps} />,
      VIEWPORT,
    );
    await vi.waitFor(() => {
      expect(stripAnsiStyles(ui?.lastFrame() ?? '')).toContain('Resume');
    });
    expect(sessionsStore.get().sessions[0]).toMatchObject({ id: sessionId, status: 'open' });

    // Another process ends the run, as `splitbrief continue --action end-run` does.
    await endRunAtRest(
      { projectDir, sessionId, bus: createRecoveryBus({ projectDir, sessionId, sink: () => {} }) },
      savedState,
      config,
    );

    await vi.waitFor(() => {
      const route = routerStore.get();
      expect(route.screen === 'workflow' && route.run.status).toEqual({
        kind: 'closed',
        as: 'ended',
      });
    });
    await vi.waitFor(() => {
      expect(stripAnsiStyles(ui?.lastFrame() ?? '')).toContain('Closed');
    });
    const frame = stripAnsiStyles(ui.lastFrame() ?? '');
    expect(frame).not.toContain('Resume ·');
    expect(frame).not.toContain('⏎ resume');
    expect(overlayStore.get().active).toBe('none');
    expect(stopStore.get().phase).toBe('idle');
    expect(sessionsStore.get().sessions[0]).toMatchObject({ id: sessionId, status: 'ended' });
    expect(runWorkflow).not.toHaveBeenCalled();
  });

  it('shows a run this screen drives, closed elsewhere, as it stands now and keeps its transcript', async () => {
    const sessionId = 'closed-elsewhere-local';
    const ref = { projectDir, sessionId };
    const savedState = { ...createInitialState('add a word counter'), phase: 'planning' as const };
    saveState(ref, savedState);
    const config = makeConfig();
    const prepared = makePreparedExecution({
      projectDir,
      sessionId,
      feature: savedState.feature,
      resumeState: savedState,
      config,
    });
    routerStore.init({
      screen: 'workflow',
      run: makeRunRecord({ ref }),
      execution: { kind: 'local', prepared },
    });
    createRecoveryBus({ ...ref, sink: addEvent }).publish({
      type: 'workflow_started',
      ts: 1_000,
      phase: 'planning',
      feature: savedState.feature,
    });
    let continuation: UseRunContinueResult | undefined;
    function Harness({ prepared }: { prepared: PreparedExecution }) {
      continuation = useRunContinue({ prepared, inputMode: useInputMode() });
      return <Text>harness</Text>;
    }
    ui = renderFeature(<Harness prepared={prepared} />, VIEWPORT);

    await endRunAtRest(
      { projectDir, sessionId, bus: createRecoveryBus({ projectDir, sessionId, sink: () => {} }) },
      savedState,
      config,
    );
    continuation?.handleResume();

    await vi.waitFor(() => {
      const route = routerStore.get();
      expect(route.screen === 'workflow' && route.execution.kind).toBe('at-rest');
    });

    const route = routerStore.get();
    expect(route.screen === 'workflow' && route.execution.kind).toBe('at-rest');
    expect(route.screen === 'workflow' && route.run.status).toEqual({
      kind: 'closed',
      as: 'ended',
    });
    expect(feedbackStore.get()).toEqual({
      message: 'Cannot continue: this run was ended; start a new one.',
      isError: true,
    });
    expect(eventsStore.get().events.map((event) => event.type)).toContain('workflow_started');
  });
});
