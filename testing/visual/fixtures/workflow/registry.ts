import type { CheckpointId } from '../../contracts/identifiers.js';
import { checkpointId } from '../../contracts/identifiers.js';
import type { CheckpointPredicate, FixtureFactory, FixtureRegistry } from '../common.js';
import { markWorkflowPaused } from '../../../../src/stores/workflow/actions/pause.js';
import { lifecycleStore } from '../../../../src/stores/workflow/lifecycle.js';
import { feedbackStore } from '../../../../src/stores/ui/feedback.js';
import { formatCopyResult } from '../../../../src/core/runtime/commands/types.js';
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
  if (projection.scenarioId === 'workflow-selection-copy') {
    return () => ({
      ...base(),
      afterMount: () => feedbackStore.setMessage(formatCopyResult('native')),
    });
  }
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
  [checkpointId('quick-setup'), includesAll('Planning…')],
  // A quick run never leaves Spec, so the rail shows its researching phase as the live Plan stage.
  [checkpointId('quick-researching'), includesAll('Researching…', 'Plan')],
  [checkpointId('planning'), includesAll(WORKFLOW_FIXTURE_TEXT.planning)],
  [checkpointId('briefs-compiled'), includesAll('passed')],
  [checkpointId('briefs-approved'), includesAll('3 tasks')],
  // The build-progress block is the fact the implementation checkpoint must carry at every width;
  // the task header scrolls out of a 60x18 transcript, so pinning it would pin the viewport too.
  [
    checkpointId('implementation'),
    includesAll(WORKFLOW_FIXTURE_TEXT.implementation, 'briefs passed'),
  ],
  // The brief's row is the transcript's tail, so its estimate is on screen at every width.
  [checkpointId('implementation-user-edits'), includesAll('briefs passed')],
  [
    checkpointId('user-edit-conflict-prompt'),
    includesAll(
      'input to T901',
      'src/future.ts',
      '[c]  continue',
      '[space]  pause',
      '[a]  end run',
    ),
  ],
  [checkpointId('implementation-narration'), includesAll('briefs passed')],
  [checkpointId('implementation-adjacent-narration'), includesAll('briefs passed')],
  [checkpointId('implementation-retry'), includesAll('briefs passed')],
  [checkpointId('implementation-escalated'), includesAll('briefs passed')],
  [checkpointId('validation'), includesAll('validate', 'test skipped')],
  [checkpointId('planner-commands-refused'), includesAll('warning')],
  // The tiered gate owns this checkpoint: it takes the prompt zone from the document panel, so the
  // panel's own words are never on this frame.
  [checkpointId('review'), includesAll('allow this operation only', WORKFLOW_FIXTURE_TEXT.review)],
  // The document loads from disk after the panel paints, so each gate waits on the first row of
  // its own document too — otherwise the frame captures a gate over an empty box.
  [checkpointId('approval-document'), includesAll('End run', 'Fixture plan')],
  [checkpointId('selection-copy'), includesAll('End run', 'Fixture plan')],
  [checkpointId('approval-permission'), includesAll('allow this operation only')],
  [checkpointId('reviewing-briefs'), includesAll('Approve briefs', 'T001 modify')],
  // The two briefs whose long headers the card once skipped, beside the first and the last.
  [checkpointId('tasks-card'), includesAll('T001', 'T004', 'T006', 'T007')],
  // The subsections the spec card does not nest, and the briefs after T001's unclosed sample.
  [checkpointId('spec-tasks-cards'), includesAll('+ 12 more sections', 'T002', 'T003')],
  [checkpointId('question'), includesAll(WORKFLOW_FIXTURE_TEXT.question)],
  [checkpointId('question-overflow'), includesAll('Question 2 of 3')],
  [checkpointId('question-input'), includesAll('Question 1 of 2', 'New instruction')],
  [checkpointId('planner-reply'), includesAll('Reply to the planner…', 'Waiting for your answer')],
  // The transcript pins the tail, so the block's last row is the width-stable marker.
  [checkpointId('question-answered'), includesAll('Simplify/clean up existing code')],
  [checkpointId('task-review'), includesAll('[c]  continue', '[r]  redo task', '[a]  abort')],
  // The transcript pins the tail, so the last warning's own words are the width-stable marker.
  [checkpointId('briefs-shared-file'), includesAll()],
  [checkpointId('paused-mid-brief'), includesAll('/resume', 'Turn stopped')],
  [checkpointId('paused-boundary'), includesAll('briefs complete', 'Paused before T902')],
  [checkpointId('stopping'), includesAll('esc back after stop')],
  [checkpointId('stopped'), includesAll('Changes kept')],
  // A run at rest carries its own name: the marker is the session the record names, which the
  // closed block states in full and the open byline carries. Nothing else is width-stable — the
  // byline sheds its reason and then its alternative as the terminal narrows.
  [checkpointId('at-rest-paused'), includesAll()],
  [checkpointId('at-rest-halted'), includesAll()],
  [checkpointId('retained-workspace'), includesAll('reuse')],
  [checkpointId('at-rest-waiting'), includesAll()],
  [checkpointId('closed-ready'), includesAll()],
  [checkpointId('closed-needs-attention'), includesAll()],
  [checkpointId('closed-ended'), includesAll()],
  [checkpointId('closed-ended-review'), includesAll()],
  [checkpointId('closed-seat-moved'), includesAll()],
  [checkpointId('closed-mixed-workers'), includesAll('visual-closed-mixed-workers')],
  [checkpointId('replayed'), includesAll()],
  [checkpointId('failure'), includesAll(WORKFLOW_FIXTURE_TEXT.failure, 'Build failed')],
  [checkpointId('recovery'), includesAll(WORKFLOW_FIXTURE_TEXT.recovery)],
  [checkpointId('recovery-user-edits'), includesAll(WORKFLOW_FIXTURE_TEXT.recoveryUserEdits)],
  [checkpointId('recovery-plan'), includesAll(WORKFLOW_FIXTURE_TEXT.recoveryPlan)],
  [checkpointId('recovery-plan-swapped'), includesAll('Continued via Change PLAN tool')],
  [checkpointId('plan-activity'), includesAll('src/core/crew/identity.ts')],
  [checkpointId('retry-exhausted'), includesAll(WORKFLOW_FIXTURE_TEXT.retryExhausted)],
  [checkpointId('brief-verdict'), includesAll(WORKFLOW_FIXTURE_TEXT.briefVerdict)],
  [checkpointId('review-failed'), includesAll(WORKFLOW_FIXTURE_TEXT.reviewFailed)],
  [checkpointId('left-isolation'), includesAll(WORKFLOW_FIXTURE_TEXT.leftIsolation)],
  [checkpointId('checkout-changed'), includesAll(WORKFLOW_FIXTURE_TEXT.checkoutChanged)],
  [checkpointId('at-rest-left-isolation'), includesAll()],
  [checkpointId('gates-approved'), includesAll()],
  [checkpointId('gate-stopped'), includesAll()],
  [checkpointId('gate-corrected'), includesAll()],
  [checkpointId('api-context'), includesAll(WORKFLOW_FIXTURE_TEXT.apiContext, 'Try again')],
  [
    checkpointId('planning-claude-frames'),
    includesAll(WORKFLOW_FIXTURE_TEXT.planningReply, 'retry 2 of 10'),
  ],
  [checkpointId('implementation-silent'), includesAll('Still working', 'No update for')],
] as const satisfies readonly (readonly [CheckpointId, CheckpointPredicate])[];

export const workflowCheckpointPredicates: ReadonlyMap<CheckpointId, CheckpointPredicate> = new Map(
  checkpointPredicates,
);
