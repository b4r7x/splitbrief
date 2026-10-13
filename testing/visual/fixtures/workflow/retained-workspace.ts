import { retainedWorkspaceNotice } from '../../../../src/engine/orchestrator/isolation/retention.js';
import {
  WORKSPACE_KEPT_CODE,
  WORKSPACE_NOTICE_CATEGORY,
} from '../../../../src/core/sessions/workspace-notice.js';
import type { EngineEvent } from '../../../../src/engine/events/types.js';
import { scenarioId } from '../../contracts/identifiers.js';
import type { WorkflowFixtureProjection } from './projections.js';

const retainedWorkspaceEpoch = 1_783_958_400_000;

export const retainedWorkspaceNotices = [
  retainedWorkspaceNotice('.splitbrief/sessions/stopped/stage/workspace'),
];

export const retainedWorkspaceProjection: WorkflowFixtureProjection = {
  scenarioId: scenarioId('workflow-retained-workspace'),
  feature: 'Build partial module',
  inputMode: 'normal',
  sidebarVisible: false,
  events: [
    {
      type: 'workflow_started',
      ts: retainedWorkspaceEpoch,
      phase: 'implementing',
      feature: 'Build partial module',
    },
    ...[0, 1, 2].flatMap((stop) =>
      retainedWorkspaceNotices.map(
        (message, index): EngineEvent => ({
          type: 'warning',
          ts: retainedWorkspaceEpoch + 100 + stop * 100 + index,
          phase: 'implementing',
          message,
          category: WORKSPACE_NOTICE_CATEGORY,
          code: WORKSPACE_KEPT_CODE,
        }),
      ),
    ),
  ],
};
