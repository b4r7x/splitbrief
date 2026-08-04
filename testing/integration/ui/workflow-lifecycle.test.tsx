import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { flushEffects, renderFeature, tick } from '#testing/helpers/ink.js';
import { makeConfig } from '#testing/helpers/factories/config.js';
import { makeSummary } from '#testing/helpers/factories/summary.js';
import { createTempDir, cleanupTempDir } from '#testing/helpers/temp-dir.js';
import { resetAllStores } from '#testing/helpers/stores.js';
import type { Summary } from '../../../src/core/schemas/summary.js';
import type { RunWorkflowOptions } from '../../../src/engine/orchestrator/run/init.js';
import type { IpcServer } from '../../../src/engine/ipc/server.js';
import { WorkflowScreen } from '../../../src/app/screens/workflow.js';
import { prepareWorkflowExecution } from '#testing/helpers/workflow-screen.js';

const runWorkflow = vi.fn<(opts: RunWorkflowOptions) => Promise<Summary>>();
const workflowDeps = { runWorkflow };

const { configStore } = await import('../../../src/stores/project/config.js');
const { terminalSizeStore } = await import('../../../src/stores/ui/terminal-size.js');
const { routerStore } = await import('../../../src/stores/navigation/router.js');
const { lifecycleStore } = await import('../../../src/stores/workflow/lifecycle.js');
const { createInitialState, transition } = await import('../../../src/core/state/machine.js');
const { saveState } = await import('../../../src/core/state/persistence.js');

const ENTER = '\r';

const ipcServers: IpcServer[] = [];
const ipcTempDirs: string[] = [];

function workflowStateInResearching(feature: string) {
  return transition(createInitialState(feature), { type: 'START' });
}

function workflowStateInPlanning(feature: string) {
  let state = workflowStateInResearching(feature);
  state = transition(state, { type: 'RESEARCH_DONE' });
  state = transition(state, { type: 'SPEC_DONE' });
  return transition(state, { type: 'APPROVE_SPEC' });
}

describe('WorkflowScreen lifecycle', () => {
  beforeEach(() => {
    resetAllStores();
    routerStore.init({ screen: 'home' });
    runWorkflow.mockReset();
    runWorkflow.mockReturnValue(new Promise<never>(() => {}));
  });

  afterEach(async () => {
    vi.unstubAllEnvs();
    for (const server of ipcServers.splice(0)) {
      await server.close().catch(() => undefined);
    }
    for (const dir of ipcTempDirs.splice(0)) cleanupTempDir(dir);
    resetAllStores();
    routerStore.init({ screen: 'home' });
  });

  it('routes completion with the prepared session id without reading ambient session state', async () => {
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
        execution: { kind: 'local', prepared },
      });

      const ui = renderFeature(
        <WorkflowScreen commands={[]} onRuntimeCommand={vi.fn()} deps={workflowDeps} />,
      );

      await vi.waitFor(() => {
        expect(routerStore.get().screen).toBe('summary');
      });

      const firstCall = runWorkflow.mock.calls[0];
      if (!firstCall) throw new Error('expected runWorkflow to be called');
      const route = routerStore.get();
      expect(firstCall[0].prepared).toBe(prepared);
      if (route.screen === 'summary') {
        expect(route.summary).toEqual(summary);
        expect(route.sessionId).toBe(prepared.session.ref.sessionId);
        expect(route.status).toBe('complete');
      }

      ui.unmount();
    } finally {
      cleanupTempDir(projectDir);
    }
  });

  it('routes final-review failures as interrupted summaries instead of defaulting to complete', async () => {
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
        execution: { kind: 'local', prepared },
      });

      const ui = renderFeature(
        <WorkflowScreen commands={[]} onRuntimeCommand={vi.fn()} deps={workflowDeps} />,
      );

      await vi.waitFor(() => {
        expect(routerStore.get().screen).toBe('summary');
      });

      const route = routerStore.get();
      if (route.screen === 'summary') {
        expect(route.summary).toEqual(summary);
        expect(route.status).toBe('interrupted');
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

  it('keeps Enter resume available for a cancelled state that is resumable for this session', async () => {
    const projectDir = createTempDir('workflow-screen-cancel-resumable');
    try {
      const sessionId = 'cancelled-planning';
      const saved = workflowStateInPlanning('cancel during planning');
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

      ui.stdin.write(ENTER);

      await vi.waitFor(() => {
        expect(runWorkflow).toHaveBeenCalledTimes(2);
      });
      ui.unmount();
    } finally {
      cleanupTempDir(projectDir);
    }
  });
});
