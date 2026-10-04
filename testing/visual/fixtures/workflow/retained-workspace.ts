import { retainedWorkspaceNotice } from '../../../../src/engine/orchestrator/isolation/retention.js';
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
    ...retainedWorkspaceNotices.map(
      (message, index): EngineEvent => ({
        type: 'warning',
        ts: retainedWorkspaceEpoch + 100 + index,
        phase: 'implementing',
        message,
      }),
    ),
  ],
};
