import type { CheckpointId } from '../../contracts/identifiers.js';
import { checkpointId } from '../../contracts/identifiers.js';
import type { CheckpointPredicate, FixtureFactory, FixtureRegistry } from '../common.js';
import { markWorkflowPaused } from '../../../../src/stores/workflow/actions/pause.js';
import { lifecycleStore } from '../../../../src/stores/workflow/lifecycle.js';
import { stopStore } from '../../../../src/stores/workflow/stop.js';
import {
  WORKFLOW_FIXTURE_TEXT,
  workflowFixtureProjections,
  type FixtureStopState,
  type WorkflowFixtureProjection,
} from './projections.js';
import { createWorkflowFixtureFactory } from './setup.js';

function applyStop(stop: FixtureStopState): void {
  stopStore.__testReset({
    intent: stop.intent,
    phase: stop.phase,
    requestedAt: Date.now(),
    parked: stop.parked === undefined ? null : { ...stop.parked, resolve: null },
  });
  if (stop.phase === 'parked') markWorkflowPaused();
}

// The stop ladder lives in a store, not in the event stream, and the workflow screen resets the
// session-scoped stores from a mount effect (`use-runner.ts`) and replays the projection after it.
// Stamping on every run start is what survives that replay.
function createStopAwareFactory(projection: WorkflowFixtureProjection): FixtureFactory {
  const base = createWorkflowFixtureFactory(projection);
  const stop = projection.stop;
  if (stop === undefined) return base;
  return () => {
    const lifecycle = base();
    let off: (() => void) | null = null;
    return {
      setup: async (context) => {
        off = lifecycleStore.subscribe(() => {
          if (lifecycleStore.get().status !== 'running') return;
          if (stopStore.get().intent !== 'none') return;
          applyStop(stop);
        });
        await lifecycle.setup(context);
        applyStop(stop);
      },
      teardown: () => {
        off?.();
        off = null;
        stopStore.__testReset();
        return lifecycle.teardown();
      },
    };
  };
}

export const workflowFixtureRegistry: FixtureRegistry = new Map(
  [...workflowFixtureProjections.values()].map((projection) => [
    projection.scenarioId,
    createStopAwareFactory(projection),
  ]),
);

function includesAll(...markers: readonly string[]): CheckpointPredicate {
  return ({ output, checkpoint }) =>
    output.includes(checkpoint.marker) && markers.every((marker) => output.includes(marker));
}

const checkpointPredicates = [
  [checkpointId('idle'), includesAll(WORKFLOW_FIXTURE_TEXT.idle)],
  [checkpointId('planning'), includesAll(WORKFLOW_FIXTURE_TEXT.planning)],
  // The build-progress block is the fact the implementation checkpoint must carry at every width;
  // the task header scrolls out of a 60x18 transcript, so pinning it would pin the viewport too.
  [
    checkpointId('implementation'),
    includesAll(WORKFLOW_FIXTURE_TEXT.implementation, 'briefs passed'),
  ],
  [checkpointId('implementation-retry'), includesAll('briefs passed')],
  [checkpointId('implementation-escalated'), includesAll('briefs passed')],
  [checkpointId('validation'), includesAll('validate', 'test skipped')],
  // The tiered gate owns this checkpoint: it takes the prompt zone from the document panel, so the
  // panel's own words are never on this frame.
  [checkpointId('review'), includesAll('allow this operation only', WORKFLOW_FIXTURE_TEXT.review)],
  // The document loads from disk after the panel paints, so each gate waits on the first row of
  // its own document too — otherwise the frame captures a gate over an empty box.
  [checkpointId('approval-document'), includesAll('End run', 'Fixture plan')],
  [checkpointId('approval-permission'), includesAll('allow this operation only')],
  [checkpointId('reviewing-briefs'), includesAll('Approve briefs', 'T001 modify')],
  [checkpointId('question'), includesAll(WORKFLOW_FIXTURE_TEXT.question)],
  [checkpointId('planner-reply'), includesAll('Reply to the planner…', 'Waiting for your answer')],
  [checkpointId('task-review'), includesAll('[c]  continue', '[r]  redo task', '[a]  abort')],
  [checkpointId('paused-mid-brief'), includesAll('/resume')],
  [checkpointId('paused-boundary'), includesAll('briefs complete')],
  [checkpointId('stopping'), includesAll('No new work will start')],
  [checkpointId('stopped'), includesAll('Changes kept')],
  // A run at rest carries its own name: the marker is the session the record names, which the
  // closed block states in full and the open byline carries. Nothing else is width-stable — the
  // byline sheds its reason and then its alternative as the terminal narrows.
  [checkpointId('at-rest-paused'), includesAll()],
  [checkpointId('at-rest-halted'), includesAll()],
  [checkpointId('at-rest-waiting'), includesAll()],
  [checkpointId('closed-ready'), includesAll()],
  [checkpointId('closed-needs-attention'), includesAll()],
  [checkpointId('closed-ended'), includesAll()],
  [checkpointId('replayed'), includesAll()],
  [checkpointId('failure'), includesAll(WORKFLOW_FIXTURE_TEXT.failure, 'Build failed')],
  [checkpointId('recovery'), includesAll(WORKFLOW_FIXTURE_TEXT.recovery)],
  [checkpointId('api-context'), includesAll(WORKFLOW_FIXTURE_TEXT.apiContext, 'Try again')],
] as const satisfies readonly (readonly [CheckpointId, CheckpointPredicate])[];

export const workflowCheckpointPredicates: ReadonlyMap<CheckpointId, CheckpointPredicate> = new Map(
  checkpointPredicates,
);
