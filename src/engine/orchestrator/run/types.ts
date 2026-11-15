import type { Summary } from '../../../core/schemas/summary.js';
import type { Task } from '../../../core/schemas/task.js';
import type { WorkflowState } from '../../../core/schemas/workflow/state.js';
import type { SpecMetadata } from '../../../core/sessions/spec-files.js';
import type { SessionRef } from '../../../core/types/session-ref.js';
import type { ProcessLedger, ProcessScope } from '../../../lib/process/registry.js';
import type { PreparedConfig } from '../../runners/prepare-execution/prepared.js';
import type { RunIsolation } from '../isolation/types.js';
import type { PlanningPhaseResult } from '../planning/types.js';
import type { SummaryBase } from '../summary/build.js';
import type { WorkflowContext } from '../types.js';
import type { RunWorkflowOptions } from './init/options.js';

export type RunTasksAndReviewOptions = {
  wctx: WorkflowContext;
  state: WorkflowState;
  planning: PlanningPhaseResult;
  summaryBase: SummaryBase;
  setTrackedState: (s: WorkflowState) => void;
  setCurrentTask: (t: Pick<Task, 'suggestedFiles' | 'action'> | undefined) => void;
};

/**
 * What one run reads and never changes: its options, its identity, and what it holds until its
 * teardown.
 */
export type ScopedRun = {
  opts: RunWorkflowOptions;
  processScope: ProcessScope;
  ref: SessionRef;
  config: PreparedConfig;
  feature: string;
  startTime: number;
  summaryBase: SummaryBase;
  metadata: SpecMetadata;
  isolation: RunIsolation;
  processLedger: ProcessLedger;
  releaseLiveness: () => Promise<void>;
};

/**
 * What the steps of one run share, changed in place: the shutdown handlers, the committed-state
 * follower, the queue handler and the isolation notices read or write it while the run awaits.
 */
export type RunTracker = {
  state: WorkflowState | undefined;
  currentTask: Pick<Task, 'suggestedFiles' | 'action'> | undefined;
  result: Summary | undefined;
  bus: WorkflowContext['bus'] | undefined;
};
