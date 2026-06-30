import { vi } from 'vitest';
import type { WorkflowState } from '../../src/core/schemas/workflow.js';
import { createInitialState, transition } from '../../src/core/state/machine.js';
import { makeConfig } from './factories/config.js';
import { makeTask } from './factories/task.js';
import {
  makeCallbacks,
  makePlanner,
  makeBusRecorder,
  TEST_METADATA,
} from './orchestrator-factories.js';
import { createTempDir } from './temp-dir.js';
import { ensureSessionDir } from '../../src/core/paths-io.js';
import { runPlanningPhase } from '../../src/engine/orchestrator/planning/run.js';
import { createEvidenceLedger, writeEvidenceLedger } from '../../src/core/evidence/ledger.js';
import { recordRejectionEvidence } from '../../src/engine/orchestrator/evidence/approval.js';
import type { OrchestratorCallbacks, WorkflowSinks } from '../../src/engine/orchestrator/types.js';
import type { ApprovalReviewResult } from '../../src/core/approval/types.js';
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
    scope: { inBounds: ['auth flow'], outOfBounds: ['unrelated UI'] },
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
  autoApproveSpec: true,
  autoApprovePlan: true,
  ...(mode ? { mode } : {}),
});

export const manual = (mode?: Config['workflow']['mode']): Partial<Config['workflow']> => ({
  autoApproveSpec: false,
  autoApprovePlan: false,
  ...(mode ? { mode } : {}),
});

export type RunOpts = {
  planner?: Planner;
  callbacks?: OrchestratorCallbacks;
  config?: Config;
  state?: WorkflowState;
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
    feature: 'test-feature',
    ...(opts.rewindPending ? { rewindPending: opts.rewindPending } : {}),
    ...(opts.rewindFeedback !== undefined && { rewindFeedback: opts.rewindFeedback }),
  });
  return { result, projectDir, sessionId, events: recorder.events };
}
