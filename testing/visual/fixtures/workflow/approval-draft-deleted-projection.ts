import { taskId } from '../../../../src/core/schemas/task.js';
import { VISUAL_FIXTURE_EPOCH } from '../common.js';
import { scenarioId } from '../../contracts/identifiers.js';
import type { WorkflowFixtureProjection } from './projections.js';

const FEATURE = 'Refine the lockfile writer';

// The same BUILD as the confirm gate over a draft, with no gate in the projection: the fixture
// types the correction, opens the gate over it and deletes every letter.
export const approvalDraftDeletedProjection: WorkflowFixtureProjection = {
  scenarioId: scenarioId('workflow-approval-confirm-draft-deleted'),
  feature: FEATURE,
  inputMode: 'normal',
  sidebarVisible: false,
  approvalAfterMount: {
    actionClass: 'destructive',
    actionDescription: '.splitbrief/state.json',
  },
  events: [
    {
      type: 'workflow_started',
      ts: VISUAL_FIXTURE_EPOCH,
      phase: 'implementing',
      feature: FEATURE,
    },
    {
      type: 'task_started',
      ts: VISUAL_FIXTURE_EPOCH + 100,
      phase: 'implementing',
      taskId: taskId('T901'),
      title: 'Keep the lockfile writer',
      index: 0,
      total: 1,
      file: 'src/engine/lockfile.ts',
      action: 'modify',
      tool: 'ollama',
      model: 'qwen2.5-coder:7b',
    },
  ],
};
