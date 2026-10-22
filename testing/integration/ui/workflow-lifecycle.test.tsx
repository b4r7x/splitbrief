import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { flushEffects, renderFeature, tick } from '#testing/helpers/ink.js';
import { makeConfig } from '#testing/helpers/factories/config.js';
import { makeSummary } from '#testing/helpers/factories/summary.js';
import { createTempDir, cleanupTempDir } from '#testing/helpers/temp-dir.js';
import { resetAllStores } from '#testing/helpers/stores.js';
import type { Summary } from '../../../src/core/schemas/summary.js';
import type { RunWorkflowOptions } from '../../../src/engine/orchestrator/run/init.js';
import { WorkflowScreen } from '../../../src/app/screens/workflow.js';
import { prepareWorkflowExecution } from '#testing/helpers/workflow-screen.js';
import { readRunRecord } from '../../../src/core/sessions/run-record-io.js';
import { plainUserMessage } from '../../../src/core/types/user-input.js';
import type { WorkflowState } from '../../../src/core/schemas/workflow.js';
import type { SessionSelectDeps } from '../../../src/stores/navigation/session-select.js';
import { loadOwnerWorkflowState } from '../../../src/core/state/resume-hydration.js';
import { hydrateRun, readRunHistory } from '../../../src/features/workflow/run-history.js';
import { writeConfigYaml } from '#testing/helpers/config-io.js';

const runWorkflow = vi.fn<(opts: RunWorkflowOptions) => Promise<Summary>>();
const workflowDeps = { runWorkflow };

const { configStore } = await import('../../../src/stores/project/config.js');
const { terminalSizeStore } = await import('../../../src/stores/ui/terminal-size.js');
const { routerStore } = await import('../../../src/stores/navigation/router.js');
const { lifecycleStore } = await import('../../../src/stores/workflow/lifecycle.js');
const { createInitialState, transition } = await import('../../../src/core/state/machine.js');
const { saveState } = await import('../../../src/core/state/persistence.js');
const { requestBoundaryPause, requestResume } = await import(
  '../../../src/features/workflow/handlers.js'
);

const ENTER = '\r';

function workflowStateInResearching(feature: string) {
  return transition(createInitialState(feature), { type: 'START' });
}

describe('WorkflowScreen lifecycle', () => {
  beforeEach(() => {
    resetAllStores();
    routerStore.init({ screen: 'home' });
    runWorkflow.mockReset();
    runWorkflow.mockReturnValue(new Promise<never>(() => {}));
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    resetAllStores();
    routerStore.init({ screen: 'home' });
  });

  it('settles the finished run in place, on the screen it never left', async () => {
    const projectDir = createTempDir('workflow-screen-complete');
    try {
      const summary = makeSummary({ feature: 'generated completion id' });
      runWorkflow.mockImplementation(async (opts) => {
        opts.callbacks.onComplete(summary);
        return summary;
      });

      const config = makeConfig();
      const prepared = prepareWorkflowExecution({
        projectDir,
        feature: 'generated completion id',
        config,
        sessionId: 'prepared-completion-id',
      });
      configStore.__testReset({ config, projectDir });
      terminalSizeStore.__testReset({ cols: 120, rows: 60, isSmall: false });
      routerStore.navigate({
        to: 'workflow',
        run: readRunRecord(prepared.session.ref),
        execution: { kind: 'local', prepared },
      });

      const ui = renderFeature(
        <WorkflowScreen commands={[]} onRuntimeCommand={vi.fn()} deps={workflowDeps} />,
      );

      await vi.waitFor(() => {
        const settled = routerStore.get();
        expect(settled.screen === 'workflow' && settled.execution.kind).toBe('at-rest');
      });

      const firstCall = runWorkflow.mock.calls[0];
      if (!firstCall) throw new Error('expected runWorkflow to be called');
      const route = routerStore.get();
      expect(firstCall[0].prepared).toBe(prepared);
      if (route.screen === 'workflow') {
        expect(route.run.ref.sessionId).toBe(prepared.session.ref.sessionId);
      }

      ui.unmount();
    } finally {
      cleanupTempDir(projectDir);
    }
  });

  it('settles a failed final review at rest rather than leaving a live-looking screen', async () => {
    const projectDir = createTempDir('workflow-screen-final-review-failed');
    try {
      const summary = makeSummary({ feature: 'final review failure' });
      runWorkflow.mockImplementation(async (opts) => {
        const sessionId = opts.prepared.session.ref.sessionId;
        saveState(
          { projectDir, sessionId },
          { ...createInitialState('final review failure'), phase: 'final-review' },
        );
        return summary;
      });
      const config = makeConfig();
      const prepared = prepareWorkflowExecution({
        projectDir,
        feature: 'final review failure',
        config,
        sessionId: 'final-review-failure',
      });
      configStore.__testReset({ config, projectDir });
      terminalSizeStore.__testReset({ cols: 120, rows: 60, isSmall: false });
      routerStore.navigate({
        to: 'workflow',
        run: readRunRecord(prepared.session.ref),
        execution: { kind: 'local', prepared },
      });

      const ui = renderFeature(
        <WorkflowScreen commands={[]} onRuntimeCommand={vi.fn()} deps={workflowDeps} />,
      );

      await vi.waitFor(() => {
        const settled = routerStore.get();
        expect(settled.screen === 'workflow' && settled.execution.kind).toBe('at-rest');
      });

      const route = routerStore.get();
      if (route.screen === 'workflow') {
        expect(route.run.status.kind).toBe('open');
      }

      ui.unmount();
    } finally {
      cleanupTempDir(projectDir);
    }
  });

  it('does not promise or attempt resume after a non-resumable cancelled state', async () => {
    const projectDir = createTempDir('workflow-screen-cancel-non-resumable');
    try {
      const sessionId = 'cancelled-researching';
      const saved = workflowStateInResearching('cancel before planning');
      saveState({ projectDir, sessionId }, saved);
      const config = makeConfig();
      const prepared = prepareWorkflowExecution({
        projectDir,
        feature: saved.feature,
        config,
        sessionId,
        resumeState: saved,
      });
      configStore.__testReset({ config, projectDir });
      terminalSizeStore.__testReset({ cols: 120, rows: 60, isSmall: false });
      routerStore.navigate({
        to: 'workflow',
        run: readRunRecord(prepared.session.ref),
        execution: { kind: 'local', prepared },
      });

      const ui = renderFeature(
        <WorkflowScreen commands={[]} onRuntimeCommand={vi.fn()} deps={workflowDeps} />,
      );
      await tick(20);
      expect(runWorkflow).toHaveBeenCalledTimes(1);

      lifecycleStore.__testReset({
        phase: 'researching',
        status: 'cancelled',
        cancelled: true,
        reason: 'user_cancelled',
      });
      await tick(20);

      expect(ui.lastFrame() ?? '').not.toContain('enter to resume');

      await flushEffects();
      ui.stdin.write(ENTER);
      await tick(40);

      expect(runWorkflow).toHaveBeenCalledTimes(1);
      ui.unmount();
    } finally {
      cleanupTempDir(projectDir);
    }
  });

  it('runs the next brief on the BUILD seat saved while the run waits paused at a brief boundary, with the words typed to continue it', async () => {
    const projectDir = createTempDir('workflow-screen-boundary-seat');
    try {
      const sessionId = 'boundary-seat-saved';
      const saved = { ...createInitialState('add auth'), phase: 'implementing' as const };
      saveState({ projectDir, sessionId }, saved);
      writeConfigYaml(projectDir, {
        planner: { kind: 'cli', tool: 'claude-code' },
        implementer: { kind: 'cli', tool: 'claude-code', model: 'haiku' },
      });
      configStore.load(projectDir);
      const preparedOn = (state: WorkflowState) => {
        const { config } = configStore.get();
        if (config === null) throw new Error('expected a loaded config');
        return prepareWorkflowExecution({
          projectDir,
          feature: state.feature,
          config,
          sessionId,
          resumeState: state,
        });
      };
      const prepared = preparedOn(saved);

      // The engine pass by pass: the first parks at the boundary after its brief when a pause
      // was asked for, the way the engine does; the second records what it runs on.
      const firstPass = Promise.withResolvers<void>();
      const briefDone = Promise.withResolvers<void>();
      const parked = Promise.withResolvers<void>();
      const secondPass = Promise.withResolvers<RunWorkflowOptions>();
      runWorkflow.mockImplementation(async (opts) => {
        if (runWorkflow.mock.calls.length > 1) {
          secondPass.resolve(opts);
          return new Promise<never>(() => {});
        }
        firstPass.resolve();
        await briefDone.promise;
        if (opts.sinks.consumeBoundaryPause?.() === true) {
          const park = opts.callbacks.onContinuationNeeded?.('', 'boundary', []);
          parked.resolve();
          await park;
        }
        if (opts.signal?.aborted !== true)
          secondPass.reject(new Error('the park continued in place on the replaced seat'));
        return makeSummary({ feature: 'add auth' });
      });
      const sessionSelect: SessionSelectDeps = {
        applying: () => false,
        loadResumeState: loadOwnerWorkflowState,
        prepareResume: async ({ state }) => ({ kind: 'prepared', execution: preparedOn(state) }),
        hydrateRun,
        readRunHistory,
      };

      terminalSizeStore.__testReset({ cols: 120, rows: 60, isSmall: false });
      routerStore.navigate({
        to: 'workflow',
        run: readRunRecord(prepared.session.ref),
        execution: { kind: 'local', prepared },
      });
      const ui = renderFeature(
        <WorkflowScreen
          commands={[]}
          onRuntimeCommand={vi.fn()}
          deps={{ runWorkflow, sessionSelect }}
        />,
      );

      await firstPass.promise;
      requestBoundaryPause();
      briefDone.resolve();
      await parked.promise;
      await flushEffects();

      const seatSaved = await configStore.save({
        ...prepared.sourceConfig,
        implementer: makeConfig({ implementer: { kind: 'cli', tool: 'codex' } }).implementer,
      });
      expect(seatSaved.kind).toBe('saved');
      ui.stdin.write('carry on');
      await flushEffects();
      ui.stdin.write(ENTER);

      const next = await secondPass.promise;
      expect(prepared.config.implementer).toMatchObject({ tool: 'claude-code', model: 'haiku' });
      expect(next.prepared.config.implementer).toMatchObject({ tool: 'codex' });
      expect(next.steer?.text).toBe('carry on');

      ui.unmount();
    } finally {
      cleanupTempDir(projectDir);
    }
  });

  it('resumes a cancelled resumable session through /resume, never a blank Enter', async () => {
    const projectDir = createTempDir('workflow-screen-cancel-resumable');
    try {
      const sessionId = 'cancelled-planning';
      const saved = workflowStateInResearching('cancel during planning');
      saveState({ projectDir, sessionId }, saved);
      const config = makeConfig();
      const prepared = prepareWorkflowExecution({
        projectDir,
        feature: saved.feature,
        config,
        sessionId,
        resumeState: saved,
      });
      configStore.__testReset({ config, projectDir });
      terminalSizeStore.__testReset({ cols: 120, rows: 60, isSmall: false });
      routerStore.navigate({
        to: 'workflow',
        run: readRunRecord(prepared.session.ref),
        execution: { kind: 'local', prepared },
      });

      const ui = renderFeature(
        <WorkflowScreen commands={[]} onRuntimeCommand={vi.fn()} deps={workflowDeps} />,
      );
      await tick(20);
      expect(runWorkflow).toHaveBeenCalledTimes(1);

      lifecycleStore.__testReset({
        phase: 'planning',
        status: 'cancelled',
        cancelled: true,
        reason: 'user_cancelled',
      });
      await flushEffects();

      // Blank Enter never restarts a run: the keystroke the composer takes by accident must not
      // be the one that starts work.
      ui.stdin.write(ENTER);
      await tick(20);
      expect(runWorkflow).toHaveBeenCalledTimes(1);

      requestResume(plainUserMessage(''));

      await vi.waitFor(() => {
        expect(runWorkflow).toHaveBeenCalledTimes(2);
      });
      ui.unmount();
    } finally {
      cleanupTempDir(projectDir);
    }
  });
});
