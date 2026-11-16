import { retainedWorkspaceNotice } from '../../../../src/engine/orchestrator/isolation/kept-notice.js';
import {
  WORKSPACE_KEPT_CODE,
  WORKSPACE_NOTICE_CATEGORY,
} from '../../../../src/core/sessions/workspace-notice.js';
import type { EngineEvent } from '../../../../src/engine/events/types.js';
import { buildRetryExhaustedRecoveryIssue } from '../../../../src/engine/orchestrator/recovery/builders/retry.js';
import { makeTask } from '../../../helpers/factories/task.js';
import { makeImplState } from '../../../helpers/factories/workflow-state.js';
import { scenarioId } from '../../contracts/identifiers.js';
import type { WorkflowFixtureProjection } from './projections.js';

const retainedWorkspaceEpoch = 1_783_958_400_000;
const FEATURE = 'Build partial module';
const BRIEF = makeTask({
  id: 'T001',
  title: 'Build the partial module',
  suggestedFiles: ['src/partial/module.ts'],
  status: 'in_progress',
});

export const retainedWorkspaceNotices = [
  retainedWorkspaceNotice('.splitbrief/sessions/stopped/stage/workspace'),
];

const haltIssue = buildRetryExhaustedRecoveryIssue({
  task: BRIEF,
  phase: 'escalating',
  validationSummary: "src/partial/module.ts(12,3): error TS2304: Cannot find name 'build'.",
  attempts: 3,
  allowRetryOverride: true,
  createdAt: new Date(retainedWorkspaceEpoch).toISOString(),
});

// The saved run halted on its brief and kept its workspace for Continue. Opening the halt, the
// recovery driver warns where the workspace is, then prompts the halt again.
export const retainedWorkspaceProjection: WorkflowFixtureProjection = {
  scenarioId: scenarioId('workflow-retained-workspace'),
  feature: FEATURE,
  inputMode: 'question',
  sidebarVisible: false,
  resumeState: makeImplState([BRIEF], {
    feature: FEATURE,
    startedAt: new Date(retainedWorkspaceEpoch).toISOString(),
    phase: haltIssue.phase,
    pendingRecovery: haltIssue,
  }),
  events: [
    {
      type: 'workflow_started',
      ts: retainedWorkspaceEpoch,
      phase: 'implementing',
      feature: FEATURE,
    },
    {
      type: 'tasks_planned',
      ts: retainedWorkspaceEpoch + 10,
      phase: 'implementing',
      total: 1,
      tasks: [
        {
          id: BRIEF.id,
          title: BRIEF.title,
          index: 0,
          file: 'src/partial/module.ts',
          action: 'create',
        },
      ],
    },
    {
      type: 'task_started',
      ts: retainedWorkspaceEpoch + 20,
      phase: 'implementing',
      taskId: BRIEF.id,
      title: BRIEF.title,
      index: 0,
      total: 1,
      file: 'src/partial/module.ts',
      action: 'create',
    },
    ...retainedWorkspaceNotices.map(
      (message, index): EngineEvent => ({
        type: 'warning',
        ts: retainedWorkspaceEpoch + 42_000 + index,
        phase: haltIssue.phase,
        message,
        category: WORKSPACE_NOTICE_CATEGORY,
        code: WORKSPACE_KEPT_CODE,
      }),
    ),
  ],
};
