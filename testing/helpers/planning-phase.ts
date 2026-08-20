import { vi } from 'vitest';
import type { WorkflowState } from '../../src/core/schemas/workflow.js';
import { createInitialState, transition } from '../../src/core/state/machine.js';
import { readWorkflowStateHead } from '../../src/engine/orchestrator/state-ops.js';
import { makeConfig } from './factories/config.js';
import { makeTask } from './factories/task.js';
import {
  makeCallbacks,
  makePlanner,
  makeBusRecorder,
  makeWctx,
  TEST_METADATA,
} from './orchestrator-factories.js';
import { createTempDir } from './temp-dir.js';
import { ensureSessionDir } from '../../src/core/paths-io.js';
import { saveState } from '../../src/core/state/persistence.js';
import { runPlanningPhase } from '../../src/engine/orchestrator/planning/run.js';
import { runPlanningPhases } from '../../src/engine/orchestrator/run/phases.js';
import { createWorkflowRecoveryBinding } from '../../src/engine/orchestrator/run/recovery-binding.js';
import { createEvidenceLedger } from '../../src/core/evidence/ledger-state.js';
import { writeEvidenceLedger } from '../../src/core/evidence/ledger-storage.js';
import { recordRejectionEvidence } from '../../src/engine/orchestrator/evidence/approval.js';
import type { OrchestratorCallbacks, WorkflowSinks } from '../../src/engine/orchestrator/types.js';
import type { ApprovalReviewResult } from '../../src/core/approval/types.js';
import type { StateAuthorityReceipt } from '../../src/core/state/types.js';
import type { Planner } from '../../src/engine/planners/types.js';
import type { Config } from '../../src/core/schemas/config.js';
import type { Attachment } from '../../src/core/schemas/attachment.js';

export { TEST_METADATA };

export const REAL_TASKS_MD = `---
id: T001
title: Add auth
action: create
file: src/auth.ts
---

### Description

Add JWT-based authentication.

### Tests

- passes tsc

### Type Definitions

\`\`\`ts
type AuthTask = { userId: string };
\`\`\`

### Implementation Steps

1. Implement the authentication module.

### Scope

**In bounds:**
- src/auth.ts
**Out of bounds:**
- unrelated UI or persistence changes

### Escalation

- Stop if existing auth behavior is ambiguous.

### Evidence

- brief-quality.json records a passing gate
`;

export function setupProject(dirs: string[]): { projectDir: string; sessionId: string } {
  const projectDir = createTempDir('planning-test');
  dirs.push(projectDir);
  const sessionId = 'sess-planning';
  ensureSessionDir(projectDir, sessionId);
  return { projectDir, sessionId };
}

export function createTestSinks(): WorkflowSinks & { abortTurn: () => boolean } {
  let abortHandler: (() => void) | null = null;
  return {
    setAbortHandler: (h) => {
      abortHandler = h;
    },
    setQueueHandler: () => {},
    abortTurn: () => {
      if (!abortHandler) return false;
      abortHandler();
      return true;
    },
  };
}

export function prepareState(
  phase?: 'specifying' | 'planning',
  rewindPending?: WorkflowState['rewindPending'],
): WorkflowState {
  const initial = createInitialState('test-feature');
  if (phase) return { ...initial, phase, rewindPending };
  return transition(initial, { type: 'START' });
}

export function makePassingTask(id = 'T001') {
  return makeTask({
    id,
    scope: {
      inBounds: ['Modify only `src/hello.ts`.'],
      outOfBounds: ['Do not touch anything outside the task file.'],
    },
    evidence: ['brief-quality.json confirms the task brief is complete'],
    typeDefs: 'type AuthTask = { userId: string }',
  });
}

export function makeBriefQualityFailureTask() {
  return makeTask({
    scope: undefined,
    evidence: [],
  });
}

export function makePassingPlanner(overrides?: Partial<Planner>): Planner {
  return makePlanner({
    plan: vi.fn().mockResolvedValue({
      spec: '# Spec',
      plan: '# Plan',
      tasks: [makePassingTask()],
      usage: { inputTokens: 100, outputTokens: 50 },
    }),
    quickPlan: vi.fn().mockResolvedValue({
      spec: '',
      plan: '',
      tasks: [makePassingTask()],
      usage: { inputTokens: 50, outputTokens: 25 },
    }),
    ...overrides,
  });
}

export function seedRejectionEvidence(projectDir: string, sessionId: string): void {
  let ledger = createEvidenceLedger({
    sessionId,
    feature: 'previous feature',
    mode: 'standard',
    tasks: [makePassingTask()],
  });
  ledger = recordRejectionEvidence({
    ledger,
    tier: 'sticky',
    actionClass: 'network',
    actionDescription: 'fetch https://api.example.com/audit',
    reason: 'user denied network access',
  });
  writeEvidenceLedger({ projectDir, sessionId }, ledger);
}

export function sequencedApproval(
  responses: readonly ApprovalReviewResult[],
): OrchestratorCallbacks['onApprovalNeeded'] {
  const fn = vi.fn<OrchestratorCallbacks['onApprovalNeeded']>();
  for (const r of responses) fn.mockResolvedValueOnce(r);
  return fn;
}

export const auto = (mode?: Config['workflow']['mode']): Partial<Config['workflow']> => ({
  approve: 'none',
  ...(mode ? { mode } : {}),
});

export const manual = (mode?: Config['workflow']['mode']): Partial<Config['workflow']> => ({
  ...(mode ? { mode } : {}),
});

export type RunOpts = {
  planner?: Planner;
  callbacks?: OrchestratorCallbacks;
  config?: Config;
  state?: WorkflowState;
  feature?: string;
  rewindPending?: WorkflowState['rewindPending'];
  rewindFeedback?: string | undefined;
  drainPendingAttachments?: (() => Attachment[]) | undefined;
  sinks?: WorkflowSinks & { abortTurn: () => boolean };
};

export async function runPhase(dirs: string[], opts: RunOpts = {}) {
  const { projectDir, sessionId } = setupProject(dirs);
  const planner = opts.planner ?? makePassingPlanner();
  const callbacks = opts.callbacks ?? makeCallbacks().callbacks;
  const config = opts.config ?? makeConfig();
  const state = opts.state ?? prepareState();
  const sinks = opts.sinks ?? createTestSinks();
  const recorder = makeBusRecorder();
  const result = await runPlanningPhase({
    wctx: {
      projectDir,
      config,
      callbacks,
      metadata: TEST_METADATA,
      sessionId,
      sinks,
      bus: recorder.bus,
      ...(opts.drainPendingAttachments !== undefined && {
        drainPendingAttachments: opts.drainPendingAttachments,
      }),
    },
    planner,
    state,
    feature: opts.feature ?? 'test-feature',
    ...(opts.rewindPending ? { rewindPending: opts.rewindPending } : {}),
    ...(opts.rewindFeedback !== undefined && { rewindFeedback: opts.rewindFeedback }),
  });
  return { result, projectDir, sessionId, events: recorder.events };
}

export type OwnedRunOpts = RunOpts & {
  project?: { projectDir: string; sessionId: string };
};

/**
 * Runs planning through the workflow-owner seam used by the real orchestrator.
 * Direct producer tests should use runPhase; approval/materialization tests use
 * this helper so they exercise the typed recovery binding rather than a fake
 * legacy fallback inside the producer.
 */
export async function runOwnedPlanningPhase(dirs: string[], opts: OwnedRunOpts = {}) {
  const project = opts.project ?? setupProject(dirs);
  const planner = opts.planner ?? makePassingPlanner();
  const callbacks = opts.callbacks ?? makeCallbacks().callbacks;
  const config = opts.config ?? makeConfig();
  const sinks = opts.sinks ?? createTestSinks();
  const recorder = makeBusRecorder();
  const ownerId = 'planning-test-owner';
  const baseState = opts.state ?? prepareState();
  const state: WorkflowState = {
    ...baseState,
    ...(opts.feature !== undefined ? { feature: opts.feature } : {}),
    stateFence: { token: 1, ownerId },
  };
  const ref = { projectDir: project.projectDir, sessionId: project.sessionId };
  ensureSessionDir(project.projectDir, project.sessionId);
  saveState(ref, state);

  let trackedState = state;
  const wctx = makeWctx({
    projectDir: project.projectDir,
    sessionId: project.sessionId,
    config,
    callbacks,
    planner,
    metadata: TEST_METADATA,
    bus: recorder.bus,
    sinks,
  });
  const authorityBase: Omit<StateAuthorityReceipt, 'stateDigest' | 'stateRevision'> = {
    kind: 'usable',
    sessionId: project.sessionId,
    ownerId,
    pid: process.pid,
    processStart: 'planning-test-process',
    runId: 'planning-test-run',
    acquisitionId: 'planning-test-acquisition',
    fence: 1,
  };
  const getState = (): WorkflowState => readWorkflowStateHead(ref)?.state ?? trackedState;
  const getAuthority = (): StateAuthorityReceipt => {
    const head = readWorkflowStateHead(ref);
    return {
      ...authorityBase,
      stateRevision: head?.state.stateRevision ?? trackedState.stateRevision ?? 0,
      stateDigest: head?.digest ?? '',
    };
  };
  const recovery = createWorkflowRecoveryBinding({
    wctx,
    getState,
    setState: (next) => {
      trackedState = next;
    },
    getAuthority,
  });
  const planning = await runPlanningPhases({
    wctx,
    state,
    savedState: undefined,
    selectedSkills: undefined,
    phaseTimings: {},
    startTime: Date.now(),
    setTrackedState: (next) => {
      trackedState = next;
    },
    recovery,
  });
  return {
    result: { ...planning, tasks: trackedState.tasks },
    projectDir: project.projectDir,
    sessionId: project.sessionId,
    events: recorder.events,
  };
}
