import { createBriefRecoveryState } from '../../../../src/engine/orchestrator/planning/brief-recovery.js';
import type { BriefQualityReport } from '../../../../src/engine/spec/brief-quality.js';
import { taskId } from '../../../../src/core/schemas/task.js';
import { makeUsage } from '../../../helpers/factories/summary.js';
import type { PersistedWorkflowState } from '../../../../src/core/schemas/workflow.js';
import { WORKFLOW_STATE_VERSION } from '../../../../src/core/schemas/workflow.js';
import { scenarioId } from '../../contracts/identifiers.js';
import type { WorkflowFixtureProjection } from './projections.js';

const SESSION_ID = 'visual-workflow';
const FEATURE = 'Persisted Brief recovery fixture';
const FIXED_TIMESTAMP = '2026-08-14T00:00:00.000Z';

const TASKS_FILE_PATH = '.splitbrief/sessions/visual-workflow/tasks.md';

const ACTIVE_BRIEF = Object.freeze({
  revision: 1,
  hash: 'persisted-blocked-brief-hash',
  path: 'brief/tasks.md',
});

const ZERO_TASK_ISSUE = Object.freeze({
  code: 'brief_zero_tasks',
  severity: 'error' as const,
  taskId: 'T000',
  message: 'The Brief contains no tasks to implement.',
});

export interface PersistedBriefRecoveryFixtureProjection extends WorkflowFixtureProjection {
  readonly persistedState: PersistedWorkflowState;
  readonly legacyQuality: BriefQualityReport;
}

/**
 * The captured persisted authority plus contradictory legacy projections:
 * `state.json` carries a blocked Brief recovery while `tasks.md` holds zero
 * Tasks and `brief-quality.json` reports score 0.80. The projection is written
 * to disk only; nothing is injected into the component deps, so the production
 * loader must resolve the persisted authority above the legacy files.
 */
export function persistedBriefRecoveryFixture(): PersistedBriefRecoveryFixtureProjection {
  const recovery = createBriefRecoveryState(
    {
      sessionId: SESSION_ID,
      origin: { mode: 'standard', entry: 'initial' },
      continuation: { version: 1, kind: 'approval', mode: 'standard', entry: 'initial' },
      activeBrief: ACTIVE_BRIEF,
      report: {
        briefHash: ACTIVE_BRIEF.hash,
        report: {
          revision: 1,
          hash: 'persisted-blocked-report-hash',
          path: 'brief/quality.json',
        },
        ruleVersion: 'brief-quality-v1',
        issues: [ZERO_TASK_ISSUE],
        errorCount: 1,
      },
      qualityPolicyVersion: 'brief-quality-v1',
    },
    { epochId: 'persisted-brief-recovery-epoch-1', recoveryRevision: 1 },
  );
  const persistedState: PersistedWorkflowState = {
    stateVersion: WORKFLOW_STATE_VERSION,
    stateRevision: 1,
    stateFence: { token: 1, ownerId: 'persisted-recovery-fixture' },
    phase: 'reviewing-briefs',
    feature: FEATURE,
    currentTaskIndex: 0,
    attempt: 0,
    tasks: [],
    startedAt: FIXED_TIMESTAMP,
    tokenUsage: makeUsage(),
    awaitingContinue: false,
    messageQueue: [],
    briefRecovery: recovery,
  };
  return {
    scenarioId: scenarioId('workflow-brief-recovery-zero-task-blocked'),
    feature: FEATURE,
    events: [],
    inputMode: 'review',
    sidebarVisible: false,
    review: { filePath: TASKS_FILE_PATH, source: '' },
    persistedState,
    legacyQuality: {
      version: 1,
      passed: false,
      score: 0.8,
      issues: [
        {
          taskId: taskId('T000'),
          severity: 'error',
          code: 'empty_task_list',
          message: 'The Brief contains no tasks to implement.',
        },
      ],
    },
  };
}
