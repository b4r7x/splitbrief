import type { CheckpointId } from '../../contracts/identifiers.js';
import { checkpointId } from '../../contracts/identifiers.js';
import type { CheckpointPredicate, FixtureRegistry } from '../common.js';
import { WORKFLOW_FIXTURE_TEXT, workflowFixtureProjections } from './projections.js';
import { createWorkflowFixtureFactory } from './setup.js';

export const workflowFixtureRegistry: FixtureRegistry = new Map(
  [...workflowFixtureProjections.values()].map((projection) => [
    projection.scenarioId,
    createWorkflowFixtureFactory(projection),
  ]),
);

function includesAll(...markers: readonly string[]): CheckpointPredicate {
  return ({ output, checkpoint }) =>
    output.includes(checkpoint.marker) && markers.every((marker) => output.includes(marker));
}

const checkpointPredicates = [
  [checkpointId('idle'), includesAll(WORKFLOW_FIXTURE_TEXT.idle)],
  [checkpointId('planning'), includesAll(WORKFLOW_FIXTURE_TEXT.planning)],
  // Small viewports scroll the transcript to its tail, so the predicate pins content that
  // survives every viewport: the activity block and the in-flight task's file.
  [
    checkpointId('implementation'),
    includesAll('Implementer activity', 'src/engine/detection/service.ts'),
  ],
  [checkpointId('review'), includesAll('Approval', WORKFLOW_FIXTURE_TEXT.review)],
  [checkpointId('question'), includesAll(WORKFLOW_FIXTURE_TEXT.question)],
  [checkpointId('success'), includesAll('complete', WORKFLOW_FIXTURE_TEXT.success)],
  [checkpointId('failure'), includesAll(WORKFLOW_FIXTURE_TEXT.failure, 'Workflow cancelled')],
] as const satisfies readonly (readonly [CheckpointId, CheckpointPredicate])[];

export const workflowCheckpointPredicates: ReadonlyMap<CheckpointId, CheckpointPredicate> = new Map(
  checkpointPredicates,
);
