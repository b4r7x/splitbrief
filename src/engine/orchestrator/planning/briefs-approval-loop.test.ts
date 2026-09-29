import { describe, it, expect, vi, afterEach } from 'vitest';
import { existsSync, readFileSync, statSync, utimesSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createInitialState } from '../../../core/state/machine.js';
import { eventPhase } from '../../../core/event-phase.js';
import { makeConfig } from '#testing/helpers/factories/config.js';
import { makeCallbacks, makeBusRecorder } from '#testing/helpers/orchestrator-factories.js';
import { cleanupTempDir } from '#testing/helpers/temp-dir.js';
import {
  BRIEF_QUALITY_FILE,
  BRIEF_READINESS_FILE,
  sessionDir,
  TASKS_FILE,
} from '../../../core/paths.js';
import { writeSpecFile } from '../../../core/paths-io.js';
import type { EngineEvent } from '../../events/types.js';
import { readWorkflowStateHead } from '../state-ops.js';
import { runQualityGateAndReport } from './brief-quality-gate.js';
import { runBriefsApprovalLoop } from './briefs-approval-loop.js';
import { taskId, type Task } from '../../../core/schemas/task.js';
import type { WorkflowState } from '../../../core/schemas/workflow.js';
import type { Config } from '../../../core/schemas/config.js';
import type { OrchestratorCallbacks } from '../types.js';
import type { Planner } from '../../planners/types.js';
import {
  TEST_METADATA,
  setupProject,
  makeBriefQualityFailureTask,
  makePassingTask,
  makePassingPlanner,
  manual,
  runOwnedPlanningPhase,
} from '#testing/helpers/planning-phase.js';
import { formatTasks } from '../../spec/formatter.js';
import { createEventBus } from '../../events/bus.js';
import { readRunEvents } from '../../events/replay.js';
import { createJsonlSink } from '../../events/sinks/jsonl.js';

let dirs: string[] = [];
afterEach(() => {
  vi.useRealTimers();
  for (const d of dirs) cleanupTempDir(d);
  dirs = [];
});

function briefsReviewState(tasks: Task[]): WorkflowState {
  return { ...createInitialState('feature'), phase: 'reviewing-briefs', tasks };
}

function makeOverflowingTask(): Task {
  return {
    ...makePassingTask('T001'),
    description: 'Create a large worker packet',
    implementationSteps: [
      Array.from({ length: 300 }, (_, index) => `implement detail ${index}`).join(' '),
    ],
  };
}

const EDITED_TASKS_MD = `---
id: T900
title: Edited outside the TUI
action: create
file: src/edited.ts
---

### Description

An operator edit that drops the implementation steps.

### Tests

- returns the expected greeting

### Scope

**In bounds:**
- src/edited.ts

**Out of bounds:**
- unrelated files

### Escalation

- Stop if the edit is ambiguous.

### Evidence

- brief-quality.json records the gate verdict
`;

function overflowConfig(): Config {
  return makeConfig({
    implementer: { contextLength: 200 },
    workflow: { mode: 'standard', approve: 'none' },
  });
}

/**
 * A host that approves every time, as headless does. Its fiftieth answer ends the run, so a gate
 * that never halts fails the test instead of hanging it.
 */
function approveEveryTime() {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date('2026-01-01T00:00:00.000Z'));
  let asks = 0;
  return vi.fn<OrchestratorCallbacks['onApprovalNeeded']>(async () => {
    asks += 1;
    vi.setSystemTime(Date.now() + 1000);
    return asks < 50 ? { approved: true } : { approved: false, action: 'end-run' };
  });
}

async function runApprovalLoop(opts: {
  projectDir: string;
  sessionId: string;
  planner: Planner;
  callbacks: OrchestratorCallbacks;
  config: Config;
  tasks: Task[];
  skillsContext?: string;
}): Promise<{
  result: Awaited<ReturnType<typeof runBriefsApprovalLoop>>;
  events: ReturnType<typeof makeBusRecorder>['events'];
}> {
  const { bus, events } = makeBusRecorder();
  const result = await runBriefsApprovalLoop({
    tasks: opts.tasks,
    planner: opts.planner,
    projectDir: opts.projectDir,
    sessionId: opts.sessionId,
    callbacks: opts.callbacks,
    bus,
    state: briefsReviewState(opts.tasks),
    config: opts.config,
    metadata: TEST_METADATA,
    ...(opts.skillsContext !== undefined && { skillsContext: opts.skillsContext }),
  });
  return { result, events };
}

describe('runBriefsApprovalLoop', () => {
  it('approve accepts after readiness override', async () => {
    const { projectDir, sessionId } = setupProject(dirs);
    const onApprovalNeeded = vi
      .fn<OrchestratorCallbacks['onApprovalNeeded']>()
      .mockResolvedValueOnce({ approved: true })
      .mockResolvedValueOnce({ approved: true });
    const { callbacks } = makeCallbacks({ onApprovalNeeded });

    const { result, events } = await runApprovalLoop({
      projectDir,
      sessionId,
      planner: makePassingPlanner(),
      callbacks,
      config: overflowConfig(),
      tasks: [makeOverflowingTask()],
    });

    expect(onApprovalNeeded).toHaveBeenCalledTimes(2);
    expect(
      events.some(
        (event) =>
          event.type === 'warning' &&
          event.message.includes('Approve again without editing tasks.md to proceed anyway.'),
      ),
    ).toBe(true);
    expect(result).toMatchObject({ outcome: 'accepted' });
    expect(result.state.phase).toBe('implementing');
    expect(existsSync(join(sessionDir(projectDir, sessionId), TASKS_FILE))).toBe(true);
    expect(readWorkflowStateHead({ projectDir, sessionId })?.state.phase).toBe('implementing');
    expect(events.filter((event) => event.type === 'briefs_approved')).toHaveLength(1);
  });

  it('records the briefs gate approval in session.jsonl before the build begins', async () => {
    const { projectDir, sessionId } = setupProject(dirs);
    const { callbacks } = makeCallbacks({
      onApprovalNeeded: vi
        .fn<OrchestratorCallbacks['onApprovalNeeded']>()
        .mockResolvedValue({ approved: true }),
    });
    const bus = createEventBus();
    bus.subscribe(createJsonlSink({ projectDir, sessionId }));
    const tasks = [makePassingTask()];

    const result = await runBriefsApprovalLoop({
      tasks,
      planner: makePassingPlanner(),
      projectDir,
      sessionId,
      callbacks,
      bus,
      state: briefsReviewState(tasks),
      config: makeConfig({ workflow: { mode: 'standard', approve: 'none' } }),
      metadata: TEST_METADATA,
    });

    expect(result).toMatchObject({ outcome: 'accepted' });
    const { events } = await readRunEvents({ projectDir, sessionId });
    expect(events.filter((event) => event.type === 'briefs_approved')).toEqual([
      { type: 'briefs_approved', ts: expect.any(Number), phase: 'reviewing-briefs' },
    ]);
  });

  it('revise feeds the targeted comment to regeneration', async () => {
    const { projectDir, sessionId } = setupProject(dirs);
    const reviewPrompts: string[] = [];
    const planner = makePassingPlanner({
      review: vi.fn().mockImplementation(async (prompt: string) => {
        reviewPrompts.push(prompt);
        return { text: formatTasks([makePassingTask('T001')]), usage: null };
      }),
    });
    const onApprovalNeeded = vi
      .fn<OrchestratorCallbacks['onApprovalNeeded']>()
      .mockResolvedValueOnce({
        approved: false,
        action: 'revise',
        comment: 'narrow the scope',
        taskIds: [taskId('T001')],
      })
      .mockResolvedValueOnce({ approved: false, action: 'end-run' });
    const { callbacks } = makeCallbacks({ onApprovalNeeded });

    const { result } = await runApprovalLoop({
      projectDir,
      sessionId,
      planner,
      callbacks,
      config: makeConfig({ workflow: { mode: 'standard', approve: 'none' } }),
      tasks: [makePassingTask('T001')],
    });

    expect(onApprovalNeeded).toHaveBeenCalledTimes(2);
    expect(reviewPrompts).toEqual([expect.stringContaining('narrow the scope')]);
    expect(result).toMatchObject({ outcome: 'closed' });
  });

  it("carries the run's skills context into the revision and the readiness preview", async () => {
    const { projectDir, sessionId } = setupProject(dirs);
    const skillsContext = `## Active Project Skills\n\n### AuthSkill\n${'s'.repeat(16_000)}`;
    const reviewPrompts: string[] = [];
    const planner = makePassingPlanner({
      review: vi.fn().mockImplementation(async (prompt: string) => {
        reviewPrompts.push(prompt);
        return { text: formatTasks([makePassingTask('T001')]), usage: null };
      }),
    });
    const onApprovalNeeded = vi
      .fn<OrchestratorCallbacks['onApprovalNeeded']>()
      .mockResolvedValueOnce({ approved: false, action: 'revise', comment: 'narrow the scope' })
      .mockResolvedValue({ approved: true });
    const { callbacks } = makeCallbacks({ onApprovalNeeded });

    const { result } = await runApprovalLoop({
      projectDir,
      sessionId,
      planner,
      callbacks,
      config: makeConfig({ workflow: { mode: 'standard', approve: 'none' } }),
      tasks: [makePassingTask('T001')],
      skillsContext,
    });

    expect(result).toMatchObject({ outcome: 'accepted' });
    expect(reviewPrompts).toEqual([expect.stringContaining(skillsContext)]);
    const readiness = JSON.parse(
      readFileSync(join(sessionDir(projectDir, sessionId), BRIEF_READINESS_FILE), 'utf8'),
    ) as { metadata: { estimatedTokens: number }[] };
    expect(readiness.metadata[0]?.estimatedTokens).toBeGreaterThan(4_000);
  });

  it('announces the briefs gate before it asks, when the run arrives from the plan gate', async () => {
    const { projectDir, sessionId } = setupProject(dirs);
    const { bus, events } = makeBusRecorder();
    const announcedPhases: (string | undefined)[] = [];
    const onApprovalNeeded = vi
      .fn<OrchestratorCallbacks['onApprovalNeeded']>()
      .mockImplementation(async () => {
        announcedPhases.push(events.map(eventPhase).findLast((phase) => phase !== undefined));
        return { approved: false, action: 'end-run' };
      });
    const { callbacks } = makeCallbacks({ onApprovalNeeded });
    const tasks = [makePassingTask()];

    await runBriefsApprovalLoop({
      tasks,
      planner: makePassingPlanner(),
      projectDir,
      sessionId,
      callbacks,
      bus,
      state: { ...createInitialState('feature'), phase: 'reviewing-plan', tasks },
      config: makeConfig({ workflow: { mode: 'standard', approve: 'all' } }),
      metadata: TEST_METADATA,
    });

    expect(announcedPhases).toEqual(['reviewing-briefs']);
  });

  it('end run closes the run and leaves the gate phase alone', async () => {
    const { projectDir, sessionId } = setupProject(dirs);
    const onApprovalNeeded = vi
      .fn<OrchestratorCallbacks['onApprovalNeeded']>()
      .mockResolvedValue({ approved: false, action: 'end-run' });
    const { callbacks } = makeCallbacks({ onApprovalNeeded });

    const { result, events } = await runApprovalLoop({
      projectDir,
      sessionId,
      planner: makePassingPlanner(),
      callbacks,
      config: makeConfig({ workflow: { mode: 'standard', approve: 'none' } }),
      tasks: [makePassingTask()],
    });

    expect(onApprovalNeeded).toHaveBeenCalledTimes(1);
    expect(result).toMatchObject({ outcome: 'closed' });
    expect(result.state.phase).toBe('reviewing-briefs');
    expect(result.state.closed?.as).toBe('ended');
    expect(events.filter((event) => event.type === 'briefs_rejected')).toEqual([
      { type: 'briefs_rejected', ts: expect.any(Number), phase: 'reviewing-briefs' },
    ]);
    expect(events.some((event) => event.type === 'briefs_approved')).toBe(false);
  });

  it('an answer that is not a decision re-opens the gate instead of ending the run', async () => {
    const { projectDir, sessionId } = setupProject(dirs);
    const onApprovalNeeded = vi
      .fn<OrchestratorCallbacks['onApprovalNeeded']>()
      .mockResolvedValueOnce({ approved: false })
      .mockResolvedValueOnce({ approved: false })
      .mockResolvedValue({ approved: false, action: 'end-run' });
    const { callbacks } = makeCallbacks({ onApprovalNeeded });

    const { result } = await runApprovalLoop({
      projectDir,
      sessionId,
      planner: makePassingPlanner(),
      callbacks,
      config: makeConfig({ workflow: { mode: 'standard', approve: 'none' } }),
      tasks: [makePassingTask()],
    });

    expect(onApprovalNeeded).toHaveBeenCalledTimes(3);
    expect(result).toMatchObject({ outcome: 'closed' });
  });

  it('approving briefs edited on disk re-runs the quality gate and refuses the errors', async () => {
    const { projectDir, sessionId } = setupProject(dirs);
    const tasksPath = join(sessionDir(projectDir, sessionId), TASKS_FILE);
    const onApprovalNeeded = vi
      .fn<OrchestratorCallbacks['onApprovalNeeded']>()
      .mockImplementationOnce(async () => {
        writeFileSync(tasksPath, EDITED_TASKS_MD, 'utf8');
        return { approved: true };
      })
      .mockResolvedValueOnce({ approved: false, action: 'end-run' });
    const { callbacks } = makeCallbacks({ onApprovalNeeded });

    const { result, events } = await runApprovalLoop({
      projectDir,
      sessionId,
      planner: makePassingPlanner(),
      callbacks,
      config: makeConfig({ workflow: { mode: 'standard', approve: 'none' } }),
      tasks: [makePassingTask('T001')],
    });

    expect(onApprovalNeeded).toHaveBeenCalledTimes(2);
    expect(result).toMatchObject({ outcome: 'closed' });
    expect(result.state.phase).not.toBe('implementing');
    const report = JSON.parse(
      readFileSync(join(sessionDir(projectDir, sessionId), BRIEF_QUALITY_FILE), 'utf-8'),
    );
    expect(report.passed).toBe(false);
    expect(report.issues).toEqual(
      expect.arrayContaining([expect.objectContaining({ taskId: 'T900' })]),
    );
    expect(
      events.some(
        (event) =>
          event.type === 'error' && event.message.includes('Task Brief quality gate failed'),
      ),
    ).toBe(true);
    expect(events.some((event) => event.type === 'briefs_approved')).toBe(false);
  });

  it('twenty identical unproductive attempts halt the run for a decision', async () => {
    const { projectDir, sessionId } = setupProject(dirs);
    const tasksPath = join(sessionDir(projectDir, sessionId), TASKS_FILE);
    const overflowingTasks = formatTasks([makeOverflowingTask()]);
    const onApprovalNeeded = vi
      .fn<OrchestratorCallbacks['onApprovalNeeded']>()
      .mockImplementation(async () => {
        writeFileSync(tasksPath, overflowingTasks, 'utf8');
        return { approved: false, action: 'edit' };
      });
    const { callbacks } = makeCallbacks({ onApprovalNeeded });

    const { result, events } = await runApprovalLoop({
      projectDir,
      sessionId,
      planner: makePassingPlanner(),
      callbacks,
      config: overflowConfig(),
      tasks: [makePassingTask('T001')],
    });

    expect(onApprovalNeeded).toHaveBeenCalledTimes(20);
    expect(result).toMatchObject({ outcome: 'halted' });
    expect(result.state.phase).toBe('reviewing-briefs');
    expect(result.state.pendingRecovery).toMatchObject({
      reason: 'brief-review-no-progress',
      availableActions: ['revise', 'end-run'],
      recommendedAction: 'revise',
    });
    expect(
      events.some((event) => event.type === 'error' && event.code === 'brief_review_no_progress'),
    ).toBe(true);
  });

  it('approving briefs that keep failing quality halts the run for a decision', async () => {
    const { projectDir, sessionId } = setupProject(dirs);
    const onApprovalNeeded = approveEveryTime();
    const planner = makePassingPlanner();
    const artifacts = ['research.md', 'spec.md', 'plan.md'];
    for (const filename of artifacts) {
      writeFileSync(join(sessionDir(projectDir, sessionId), filename), `# Saved ${filename}\n`);
    }

    const { result, events } = await runApprovalLoop({
      projectDir,
      sessionId,
      planner,
      callbacks: makeCallbacks({ onApprovalNeeded }).callbacks,
      config: makeConfig({ workflow: { mode: 'standard', approve: 'none' } }),
      tasks: [{ ...makePassingTask('T001'), evidence: [] }],
    });

    // Each approval writes tasks.md again under a new created_at; the briefs stay the same.
    expect(onApprovalNeeded).toHaveBeenCalledTimes(20);
    expect(result).toMatchObject({ outcome: 'halted' });
    expect(readWorkflowStateHead({ projectDir, sessionId })?.state).toMatchObject({
      phase: 'reviewing-briefs',
      pendingRecovery: { reason: 'brief-review-no-progress' },
    });
    expect(events.some((event) => event.type === 'briefs_approved')).toBe(false);
    expect(planner.runPhase).not.toHaveBeenCalled();
    for (const filename of artifacts) {
      expect(readFileSync(join(sessionDir(projectDir, sessionId), filename), 'utf8')).toBe(
        `# Saved ${filename}\n`,
      );
    }
  });

  it('approving hand-edited briefs that stay blocked and fail quality halts the run for a decision', async () => {
    const { projectDir, sessionId } = setupProject(dirs);
    writeFileSync(join(sessionDir(projectDir, sessionId), TASKS_FILE), EDITED_TASKS_MD, 'utf8');
    const onApprovalNeeded = approveEveryTime();
    const planner = makePassingPlanner();

    const { result, events } = await runApprovalLoop({
      projectDir,
      sessionId,
      planner,
      callbacks: makeCallbacks({ onApprovalNeeded }).callbacks,
      config: overflowConfig(),
      tasks: [makePassingTask('T001')],
    });

    // The first approval offers the readiness override. The next twenty take it and fail quality
    // alike, though the first of them rewrote the hand-edited file in canonical form.
    expect(onApprovalNeeded).toHaveBeenCalledTimes(21);
    expect(result).toMatchObject({ outcome: 'halted' });
    expect(result.tasks.map((task) => task.id)).toEqual(['T900']);
    expect(readWorkflowStateHead({ projectDir, sessionId })?.state).toMatchObject({
      phase: 'reviewing-briefs',
      pendingRecovery: { reason: 'brief-review-no-progress' },
    });
    expect(events.some((event) => event.type === 'briefs_approved')).toBe(false);
    expect(planner.runPhase).not.toHaveBeenCalled();
    expect(
      events.filter((event) => event.type === 'warning' && event.code === 'brief_readiness_block'),
    ).toHaveLength(1);
  });

  it('requires a new readiness override when the operator changes the brief', async () => {
    const { projectDir, sessionId } = setupProject(dirs);
    const edited = { ...makeOverflowingTask(), description: 'Create a different worker packet' };
    const onApprovalNeeded = vi
      .fn<OrchestratorCallbacks['onApprovalNeeded']>()
      .mockResolvedValueOnce({ approved: true })
      .mockImplementationOnce(async () => {
        writeFileSync(join(sessionDir(projectDir, sessionId), TASKS_FILE), formatTasks([edited]));
        return { approved: true };
      })
      .mockResolvedValue({ approved: true });

    const { result, events } = await runApprovalLoop({
      projectDir,
      sessionId,
      planner: makePassingPlanner(),
      callbacks: makeCallbacks({ onApprovalNeeded }).callbacks,
      config: overflowConfig(),
      tasks: [makeOverflowingTask()],
    });

    expect(result).toMatchObject({
      outcome: 'accepted',
      tasks: [{ id: edited.id, description: edited.description }],
    });
    expect(onApprovalNeeded).toHaveBeenCalledTimes(3);
    expect(
      events.filter((event) => event.type === 'warning' && event.code === 'brief_readiness_block'),
    ).toHaveLength(2);
  });
});

/** The outline of every tasks.md card the gate announced, in order. */
function briefCards(events: readonly EngineEvent[]): string[] {
  return events.flatMap((event) =>
    event.type === 'artifact_written' && event.filename === TASKS_FILE
      ? [event.excerpt.join('\n')]
      : [],
  );
}

describe('runBriefsApprovalLoop — the Task Brief card', () => {
  const config = makeConfig({ workflow: { mode: 'standard', approve: 'none' } });

  /** A gate opens on briefs the run already wrote and announced. */
  function openGate(tasks: Task[]): { projectDir: string; sessionId: string; tasksPath: string } {
    const project = setupProject(dirs);
    writeSpecFile(project, TASKS_FILE, formatTasks(tasks), TEST_METADATA);
    return {
      ...project,
      tasksPath: join(sessionDir(project.projectDir, project.sessionId), TASKS_FILE),
    };
  }

  function editedBriefs(title: string): string {
    return formatTasks([{ ...makePassingTask('T002'), title }]);
  }

  it('approving the briefs the gate opened on announces no card', async () => {
    const tasks = [makePassingTask('T001')];
    const { projectDir, sessionId, tasksPath } = openGate(tasks);

    const { result, events } = await runApprovalLoop({
      projectDir,
      sessionId,
      planner: makePassingPlanner(),
      callbacks: makeCallbacks().callbacks,
      config,
      tasks,
    });

    expect(result).toMatchObject({ outcome: 'accepted' });
    expect(briefCards(events)).toEqual([]);
    expect(readFileSync(tasksPath, 'utf8')).toContain(formatTasks(tasks));
  });

  it('approving briefs edited outside the TUI announces them once', async () => {
    const tasks = [makePassingTask('T001')];
    const { projectDir, sessionId, tasksPath } = openGate(tasks);
    const onApprovalNeeded = vi
      .fn<OrchestratorCallbacks['onApprovalNeeded']>()
      .mockImplementationOnce(async () => {
        writeFileSync(tasksPath, editedBriefs('Edited outside the TUI'), 'utf8');
        return { approved: true };
      });

    const { result, events } = await runApprovalLoop({
      projectDir,
      sessionId,
      planner: makePassingPlanner(),
      callbacks: makeCallbacks({ onApprovalNeeded }).callbacks,
      config,
      tasks,
    });

    expect(result).toMatchObject({ outcome: 'accepted', tasks: [{ id: 'T002' }] });
    expect(briefCards(events)).toEqual([expect.stringContaining('Edited outside the TUI')]);
  });

  it('announces an edit when it lands, not again when it is approved', async () => {
    const tasks = [makePassingTask('T001')];
    const { projectDir, sessionId, tasksPath } = openGate(tasks);
    const onApprovalNeeded = vi
      .fn<OrchestratorCallbacks['onApprovalNeeded']>()
      .mockImplementationOnce(async () => {
        writeFileSync(tasksPath, editedBriefs('Edited in the editor'), 'utf8');
        return { approved: false, action: 'edit' };
      })
      .mockResolvedValueOnce({ approved: true });

    const { result, events } = await runApprovalLoop({
      projectDir,
      sessionId,
      planner: makePassingPlanner(),
      callbacks: makeCallbacks({ onApprovalNeeded }).callbacks,
      config,
      tasks,
    });

    expect(result).toMatchObject({ outcome: 'accepted', tasks: [{ id: 'T002' }] });
    expect(briefCards(events)).toEqual([expect.stringContaining('Edited in the editor')]);
  });

  it('an unknown-ID revision after an external edit still announces the disk briefs on approval', async () => {
    const tasks = [makePassingTask('T001')];
    const { projectDir, sessionId, tasksPath } = openGate(tasks);
    const planner = makePassingPlanner();
    const { bus, events } = makeBusRecorder();
    let cardsBeforeApproval: string[] = [];
    const onApprovalNeeded = vi
      .fn<OrchestratorCallbacks['onApprovalNeeded']>()
      .mockImplementationOnce(async () => {
        writeFileSync(tasksPath, editedBriefs('Edited outside the TUI'), 'utf8');
        return {
          approved: false,
          action: 'revise',
          comment: 'tighten the scope',
          taskIds: [taskId('T001')],
        };
      })
      .mockImplementationOnce(async () => {
        cardsBeforeApproval = briefCards(events);
        return { approved: true };
      });

    const result = await runBriefsApprovalLoop({
      tasks,
      planner,
      projectDir,
      sessionId,
      callbacks: makeCallbacks({ onApprovalNeeded }).callbacks,
      bus,
      state: briefsReviewState(tasks),
      config,
      metadata: TEST_METADATA,
    });

    expect(
      events.some(
        (event) =>
          event.type === 'error' &&
          event.message === 'Unknown Task Brief ID for targeted revision: T001',
      ),
    ).toBe(true);
    expect(cardsBeforeApproval).toEqual([]);
    expect(planner.review).not.toHaveBeenCalled();
    expect(result).toMatchObject({ outcome: 'accepted', tasks: [{ id: 'T002' }] });
    expect(briefCards(events)).toEqual([expect.stringContaining('Edited outside the TUI')]);
  });

  it('a valid revision announces one card that its approval does not announce again', async () => {
    const tasks = [makePassingTask('T001')];
    const { projectDir, sessionId } = openGate(tasks);
    const planner = makePassingPlanner({
      review: vi.fn().mockResolvedValue({ text: editedBriefs('Regenerated brief'), usage: null }),
    });
    const onApprovalNeeded = vi
      .fn<OrchestratorCallbacks['onApprovalNeeded']>()
      .mockResolvedValueOnce({
        approved: false,
        action: 'revise',
        comment: 'split the task',
        taskIds: [taskId('T001')],
      })
      .mockResolvedValueOnce({ approved: true });

    const { result, events } = await runApprovalLoop({
      projectDir,
      sessionId,
      planner,
      callbacks: makeCallbacks({ onApprovalNeeded }).callbacks,
      config,
      tasks,
    });

    expect(planner.review).toHaveBeenCalledTimes(1);
    expect(result).toMatchObject({ outcome: 'accepted', tasks: [{ id: 'T002' }] });
    expect(briefCards(events)).toEqual([expect.stringContaining('Regenerated brief')]);
  });

  it('an unknown-ID revise followed by a valid revise announces the regenerated brief once', async () => {
    const tasks = [makePassingTask('T001')];
    const { projectDir, sessionId, tasksPath } = openGate(tasks);
    const regenerated = formatTasks([
      { ...makePassingTask('T003'), title: 'Regenerated T003 brief' },
    ]);
    const reviewPrompts: string[] = [];
    const planner = makePassingPlanner({
      review: vi.fn().mockImplementation(async (prompt: string) => {
        reviewPrompts.push(prompt);
        return { text: regenerated, usage: null };
      }),
    });
    const { bus, events } = makeBusRecorder();
    let cardsAfterUnknownId: string[] = [];
    let cardsBeforeApproval: string[] = [];
    const onApprovalNeeded = vi
      .fn<OrchestratorCallbacks['onApprovalNeeded']>()
      .mockImplementationOnce(async () => {
        writeFileSync(tasksPath, editedBriefs('Edited outside the TUI'), 'utf8');
        return {
          approved: false,
          action: 'revise',
          comment: 'tighten the scope',
          taskIds: [taskId('T001')],
        };
      })
      .mockImplementationOnce(async () => {
        cardsAfterUnknownId = briefCards(events);
        return {
          approved: false,
          action: 'revise',
          comment: 'split the task',
          taskIds: [taskId('T002')],
        };
      })
      .mockImplementationOnce(async () => {
        cardsBeforeApproval = briefCards(events);
        return { approved: true };
      });

    const result = await runBriefsApprovalLoop({
      tasks,
      planner,
      projectDir,
      sessionId,
      callbacks: makeCallbacks({ onApprovalNeeded }).callbacks,
      bus,
      state: briefsReviewState(tasks),
      config,
      metadata: TEST_METADATA,
    });

    expect(onApprovalNeeded).toHaveBeenCalledTimes(3);
    expect(
      events.some(
        (event) =>
          event.type === 'error' &&
          event.message === 'Unknown Task Brief ID for targeted revision: T001',
      ),
    ).toBe(true);
    expect(cardsAfterUnknownId).toEqual([]);
    expect(planner.review).toHaveBeenCalledTimes(1);
    expect(reviewPrompts).toEqual([expect.stringContaining('User reason: split the task')]);
    expect(cardsBeforeApproval).toEqual([expect.stringContaining('Regenerated T003 brief')]);
    expect(result).toMatchObject({ outcome: 'accepted', tasks: [{ id: 'T003' }] });
    expect(briefCards(events)).toEqual([expect.stringContaining('Regenerated T003 brief')]);
  });
});

/** Every brief quality verdict the run published, with the phase it was published in. */
function qualityRows(events: readonly EngineEvent[]): string[] {
  return events.flatMap((event) =>
    event.type === 'brief_quality_passed' || event.type === 'brief_quality_failed'
      ? [`${event.type} ${event.phase}`]
      : [],
  );
}

describe('runBriefsApprovalLoop — the brief quality verdict', () => {
  const config = makeConfig({ workflow: { mode: 'standard', approve: 'none' } });

  /** A gate opens on briefs the quality pass measured and announced before it. */
  function openMeasuredGate(tasks: Task[]): {
    projectDir: string;
    sessionId: string;
    tasksPath: string;
  } {
    const project = setupProject(dirs);
    writeSpecFile(project, TASKS_FILE, formatTasks(tasks), TEST_METADATA);
    runQualityGateAndReport({
      ...project,
      tasks,
      bus: makeBusRecorder().bus,
      phase: 'planning',
    });
    return {
      ...project,
      tasksPath: join(sessionDir(project.projectDir, project.sessionId), TASKS_FILE),
    };
  }

  it('a plain approval after the quality pass shows the verdict once', async () => {
    const project = setupProject(dirs);
    const qualityPath = join(sessionDir(project.projectDir, project.sessionId), BRIEF_QUALITY_FILE);
    const onApprovalNeeded = vi
      .fn<OrchestratorCallbacks['onApprovalNeeded']>()
      .mockImplementation(async (gate) => {
        // Age the verdict the quality pass recorded, so the approval's own write shows.
        if (gate === 'briefs') utimesSync(qualityPath, 0, 0);
        return { approved: true };
      });

    const { result, events } = await runOwnedPlanningPhase(dirs, {
      project,
      callbacks: makeCallbacks({ onApprovalNeeded }).callbacks,
      config: makeConfig({ workflow: manual('standard') }),
    });

    expect(result.state.phase).toBe('implementing');
    expect(statSync(qualityPath).mtimeMs).toBeGreaterThan(0);
    expect(qualityRows(events)).toEqual(['brief_quality_passed planning']);
  });

  it('approving the briefs their own report measured announces no second pass', async () => {
    const tasks = [makePassingTask('T001')];
    const { projectDir, sessionId } = openMeasuredGate(tasks);

    const { result, events } = await runApprovalLoop({
      projectDir,
      sessionId,
      planner: makePassingPlanner(),
      callbacks: makeCallbacks().callbacks,
      config,
      tasks,
    });

    expect(result).toMatchObject({ outcome: 'accepted' });
    expect(qualityRows(events)).toEqual([]);
  });

  it('approving rewritten briefs whose stale report holds the same issues announces their pass', async () => {
    const measured = [makePassingTask('T001')];
    const approved = [{ ...makePassingTask('T001'), title: 'Rewritten but complete brief' }];
    const { projectDir, sessionId, tasksPath } = openMeasuredGate(measured);
    writeFileSync(tasksPath, formatTasks(approved), 'utf8');

    const { result, events } = await runApprovalLoop({
      projectDir,
      sessionId,
      planner: makePassingPlanner(),
      callbacks: makeCallbacks().callbacks,
      config,
      tasks: approved,
    });

    expect(result).toMatchObject({
      outcome: 'accepted',
      tasks: [{ title: 'Rewritten but complete brief' }],
    });
    expect(qualityRows(events)).toEqual(['brief_quality_passed reviewing-briefs']);
  });

  it('approving briefs edited outside the TUI announces their verdict', async () => {
    const tasks = [makePassingTask('T001')];
    const { projectDir, sessionId, tasksPath } = openMeasuredGate(tasks);
    const edited = formatTasks([{ ...makePassingTask('T002'), title: 'Edited outside the TUI' }]);
    const onApprovalNeeded = vi
      .fn<OrchestratorCallbacks['onApprovalNeeded']>()
      .mockImplementationOnce(async () => {
        writeFileSync(tasksPath, edited, 'utf8');
        return { approved: true };
      });

    const { result, events } = await runApprovalLoop({
      projectDir,
      sessionId,
      planner: makePassingPlanner(),
      callbacks: makeCallbacks({ onApprovalNeeded }).callbacks,
      config,
      tasks,
    });

    expect(result).toMatchObject({ outcome: 'accepted', tasks: [{ id: 'T002' }] });
    expect(qualityRows(events)).toEqual(['brief_quality_passed reviewing-briefs']);
  });

  it('approving briefs no quality pass measured announces their verdict', async () => {
    // A gate that opens with no report on disk: nothing measured these briefs before it.
    const tasks = [makePassingTask('T001')];
    const project = setupProject(dirs);
    writeSpecFile(project, TASKS_FILE, formatTasks(tasks), TEST_METADATA);

    const { result, events } = await runApprovalLoop({
      ...project,
      planner: makePassingPlanner(),
      callbacks: makeCallbacks().callbacks,
      config,
      tasks,
    });

    expect(result).toMatchObject({ outcome: 'accepted' });
    expect(qualityRows(events)).toEqual(['brief_quality_passed reviewing-briefs']);
  });

  it('approving unchanged briefs that fail announces the failure again', async () => {
    const tasks = [makeBriefQualityFailureTask()];
    const { projectDir, sessionId } = openMeasuredGate(tasks);
    const onApprovalNeeded = vi
      .fn<OrchestratorCallbacks['onApprovalNeeded']>()
      .mockResolvedValueOnce({ approved: true })
      .mockResolvedValueOnce({ approved: false, action: 'end-run' });

    const { result, events } = await runApprovalLoop({
      projectDir,
      sessionId,
      planner: makePassingPlanner(),
      callbacks: makeCallbacks({ onApprovalNeeded }).callbacks,
      config,
      tasks,
    });

    expect(result).toMatchObject({ outcome: 'closed' });
    expect(qualityRows(events)).toEqual(['brief_quality_failed reviewing-briefs']);
  });
});
