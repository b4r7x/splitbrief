import { scenarioId } from '../../contracts/identifiers.js';
import { workflowFixtureProjections, type WorkflowFixtureProjection } from './projections.js';

const movedSeat = workflowFixtureProjections.get(scenarioId('workflow-ready-seat-moved-auto'));
if (movedSeat === undefined) {
  throw new Error('The model-line fixture requires the moved-seat run');
}

export const seatMovedModelLineProjection: WorkflowFixtureProjection = {
  ...movedSeat,
  scenarioId: scenarioId('workflow-ready-seat-moved-model-line'),
};
