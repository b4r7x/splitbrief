import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { renderFeature, tick } from '#testing/helpers/ink.js';
import { stripAnsiStyles } from '#testing/helpers/ansi.js';
import { makeConfig } from '#testing/helpers/factories/config.js';
import { makeRunRecord } from '#testing/helpers/factories/run-record.js';
import { makePassingPlanner, makePassingTask } from '#testing/helpers/planning-phase.js';
import { createTempDir, cleanupTempDir } from '#testing/helpers/temp-dir.js';
import { resetAllStores } from '#testing/helpers/stores.js';
import { prepareWorkflowExecution } from '#testing/helpers/workflow-screen.js';
import { TASKS_FILE, sessionDir } from '../../../src/core/paths.js';
import { ensureSessionDir } from '../../../src/core/paths-io.js';
import { readRunRecord } from '../../../src/core/sessions/run-record-io.js';
import { createInitialState, transition } from '../../../src/core/state/machine.js';
import { saveState } from '../../../src/core/state/persistence.js';
import type { WorkflowState } from '../../../src/core/schemas/workflow.js';
import { createEventBus } from '../../../src/engine/events/bus.js';
import { createJsonlSink } from '../../../src/engine/events/sinks/jsonl.js';
import { runWorkflow } from '../../../src/engine/orchestrator/run/workflow.js';
import { formatTasks } from '../../../src/engine/spec/formatter.js';
import { WorkflowScreen } from '../../../src/app/screens/workflow.js';
import { hydrateRun } from '../../../src/features/workflow/run-history.js';
import { PROMPT_TYPEAHEAD_GRACE_MS } from '../../../src/lib/terminal/typeahead-grace.js';
import { routerStore } from '../../../src/stores/navigation/router.js';
import { configStore } from '../../../src/stores/project/config.js';
import { terminalSizeStore } from '../../../src/stores/ui/terminal-size.js';
import type { WorkflowScreenDeps } from '../../../src/features/workflow/hooks/workflow-screen/use-model.js';

const PLAN_APPROVE = 'Approve plan and review the briefs';
const BRIEFS_APPROVE = 'Approve briefs and start the build';
const BRIEF_TITLE = makePassingTask().title;

let projectDir = '';
let ui: ReturnType<typeof renderFeature> | undefined;
let run: Promise<unknown> | undefined;

beforeEach(() => {
  resetAllStores();
  routerStore.init({ screen: 'home' });
  projectDir = createTempDir('briefs-gate-screen');
});

afterEach(async () => {
  ui?.unmount();
  ui = undefined;
  // Unmounting aborts the run; it settles its session before the directory goes.
  await run;
  run = undefined;
  resetAllStores();
  routerStore.init({ screen: 'home' });
  cleanupTempDir(projectDir);
});

function frame(): string {
  return stripAnsiStyles(ui?.lastFrame() ?? '');
}

// The real engine on an injected planner: every gate the screen shows is one the run opened.
const engineDeps: WorkflowScreenDeps = {
  runWorkflow: (options) => {
    const summary = runWorkflow({ ...options, _planner: makePassingPlanner() });
    run = summary;
    return summary;
  },
};

function mountRun(sessionId: string, resumeState?: WorkflowState) {
  const feature = 'guard the login route';
  const config = makeConfig({ workflow: { mode: 'standard', approve: 'all' } });
  const prepared = prepareWorkflowExecution({
    projectDir,
    feature,
    config,
    sessionId,
    resumeState,
  });
  configStore.__testReset({ config, projectDir });
  terminalSizeStore.__testReset({ cols: 120, rows: 40, isSmall: false });
  return { prepared, feature };
}

async function approveGate(label: string): Promise<void> {
  await vi.waitFor(() => expect(frame()).toContain(label), { timeout: 10_000 });
  await tick(PROMPT_TYPEAHEAD_GRACE_MS + 30);
  ui?.stdin.write('y');
  await vi.waitFor(() => expect(frame()).not.toContain(label), { timeout: 10_000 });
}

function expectBriefsGate(): void {
  const screen = frame();
  expect(screen).toContain(BRIEFS_APPROVE);
  expect(screen).not.toContain(PLAN_APPROVE);
  expect(screen).toContain(BRIEF_TITLE);
  expect(screen).toContain('Waiting for your answer · Briefs');
}

describe('the briefs gate on the workflow screen', () => {
  it('reads as the briefs gate once the plan gate is approved in the same process', async () => {
    const { prepared, feature } = mountRun('briefs-gate-live');
    routerStore.navigate({
      to: 'workflow',
      run: makeRunRecord({ ref: prepared.session.ref, feature }),
      execution: { kind: 'local', prepared },
    });
    ui = renderFeature(
      <WorkflowScreen commands={[]} onRuntimeCommand={vi.fn()} deps={engineDeps} />,
    );

    await approveGate('Approve spec and write the plan');
    await approveGate(PLAN_APPROVE);

    await vi.waitFor(expectBriefsGate, { timeout: 10_000 });
  });

  it('reads as the briefs gate when a run parked there is continued from a log that never named it', async () => {
    const sessionId = 'briefs-gate-resume';
    const ref = { projectDir, sessionId };
    const tasks = [makePassingTask()];
    let state = createInitialState('guard the login route');
    for (const action of [
      { type: 'START' },
      { type: 'RESEARCH_DONE' },
      { type: 'SPEC_DONE' },
      { type: 'APPROVE_SPEC' },
      { type: 'PLAN_DONE', tasks },
      { type: 'BRIEF_ADMISSION_OPENED' },
      {
        type: 'INTERRUPT_STEP',
        step: { kind: 'gate', gate: 'briefs' },
        source: 'user',
        cut: 'mid-step',
      },
    ] as const) {
      state = transition(state, action);
    }
    const parked: WorkflowState = { ...state, mode: 'standard', approve: 'all' };
    ensureSessionDir(projectDir, sessionId);
    saveState(ref, parked);
    writeFileSync(join(sessionDir(projectDir, sessionId), TASKS_FILE), formatTasks(tasks), 'utf-8');
    // The history this run left: its last phase-carrying events are the plan gate's, because the
    // briefs gate opened on disk without saying so on the bus.
    const history = createEventBus();
    history.subscribe(createJsonlSink(ref));
    history.publish({
      type: 'planner_status',
      ts: Date.now(),
      phase: 'reviewing-plan',
      status: 'running',
    });
    history.publish({
      type: 'brief_quality_passed',
      ts: Date.now(),
      phase: 'reviewing-plan',
      score: 1,
      warningCount: 0,
    });

    const { prepared } = mountRun(sessionId, parked);
    // What `splitbrief continue` does before it mounts the screen.
    const record = readRunRecord(ref);
    await hydrateRun(record);
    routerStore.init({ screen: 'workflow', run: record, execution: { kind: 'local', prepared } });
    ui = renderFeature(
      <WorkflowScreen commands={[]} onRuntimeCommand={vi.fn()} deps={engineDeps} />,
    );

    await vi.waitFor(expectBriefsGate, { timeout: 10_000 });
  });
});
