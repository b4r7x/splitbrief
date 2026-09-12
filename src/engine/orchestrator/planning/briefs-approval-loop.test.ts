import { describe, it, expect, vi, afterEach } from 'vitest';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createInitialState } from '../../../core/state/machine.js';
import { makeConfig } from '#testing/helpers/factories/config.js';
import { makeCallbacks, makeBusRecorder } from '#testing/helpers/orchestrator-factories.js';
import { cleanupTempDir } from '#testing/helpers/temp-dir.js';
import { BRIEF_QUALITY_FILE, sessionDir, TASKS_FILE } from '../../../core/paths.js';
import { readWorkflowStateHead } from '../state-ops.js';
import { runBriefsApprovalLoop } from './briefs-approval-loop.js';
import { taskId, type Task } from '../../../core/schemas/task.js';
import type { WorkflowState } from '../../../core/schemas/workflow.js';
import type { Config } from '../../../core/schemas/config.js';
import type { OrchestratorCallbacks } from '../types.js';
import type { Planner } from '../../planners/types.js';
import {
  TEST_METADATA,
  setupProject,
  makePassingTask,
  makePassingPlanner,
} from '#testing/helpers/planning-phase.js';
import { formatTasks } from '../../spec/formatter.js';

let dirs: string[] = [];
afterEach(() => {
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

async function runApprovalLoop(opts: {
  projectDir: string;
  sessionId: string;
  planner: Planner;
  callbacks: OrchestratorCallbacks;
  config: Config;
  tasks: Task[];
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
      .mockResolvedValueOnce({ approved: false });
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
    expect(result).toMatchObject({ outcome: 'rejected' });
  });

  it('not approved rejects', async () => {
    const { projectDir, sessionId } = setupProject(dirs);
    const onApprovalNeeded = vi
      .fn<OrchestratorCallbacks['onApprovalNeeded']>()
      .mockResolvedValue({ approved: false });
    const { callbacks } = makeCallbacks({ onApprovalNeeded });

    const { result } = await runApprovalLoop({
      projectDir,
      sessionId,
      planner: makePassingPlanner(),
      callbacks,
      config: makeConfig({ workflow: { mode: 'standard', approve: 'none' } }),
      tasks: [makePassingTask()],
    });

    expect(onApprovalNeeded).toHaveBeenCalledTimes(1);
    expect(result).toMatchObject({ outcome: 'rejected' });
    expect(result.state.phase).toBe('idle');
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
      .mockResolvedValueOnce({ approved: false });
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
    expect(result).toMatchObject({ outcome: 'rejected' });
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
  });

  it('twenty identical unproductive attempts reject the briefs', async () => {
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
    expect(result).toMatchObject({ outcome: 'rejected' });
    expect(result.state.phase).toBe('idle');
    expect(
      events.some((event) => event.type === 'error' && event.code === 'brief_review_no_progress'),
    ).toBe(true);
  });
});
