import type { CheckpointId } from '../../contracts/identifiers.js';
import { checkpointId } from '../../contracts/identifiers.js';
import { stripAnsiStyles } from '#testing/helpers/ansi.js';
import type { CheckpointPredicate, FixtureFactory, FixtureRegistry } from '../common.js';
import { markWorkflowPaused } from '../../../../src/stores/workflow/actions/pause.js';
import { lifecycleStore } from '../../../../src/stores/workflow/lifecycle.js';
import { feedbackStore } from '../../../../src/stores/ui/feedback.js';
import { formatCopyResult } from '../../../../src/core/runtime/commands/types.js';
import { stopStore } from '../../../../src/stores/workflow/stop.js';
import { overlayStore } from '../../../../src/stores/ui/overlay.js';
import { PROMPT_TYPEAHEAD_GRACE_MS } from '../../../../src/lib/terminal/typeahead-grace.js';
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
const CONSULT_BOUND_NOTE = 'run the formatter first';

function createStopAwareFactory(projection: WorkflowFixtureProjection): FixtureFactory {
  const base = createWorkflowFixtureFactory(projection);
  if (projection.scenarioId === 'workflow-stop-sheet-recovery') {
    return () => ({ ...base(), afterMount: () => overlayStore.open('stop-sheet') });
  }
  if (
    projection.scenarioId === 'workflow-consult-answer-default' ||
    projection.scenarioId === 'workflow-consult-answer-typed'
  ) {
    return () => ({
      ...base(),
      afterMount: async (write) => {
        const fixedNow = Date.now;
        Date.now = () => fixedNow() + PROMPT_TYPEAHEAD_GRACE_MS;
        try {
          if (projection.scenarioId === 'workflow-consult-answer-typed') {
            await write.press('redis');
          }
          await write.press('\r');
        } finally {
          Date.now = fixedNow;
        }
      },
    });
  }
  if (projection.scenarioId === 'workflow-selection-copy') {
    return () => ({
      ...base(),
      afterMount: () => feedbackStore.setMessage(formatCopyResult('native')),
    });
  }
  if (projection.scenarioId === 'workflow-recovery-consult-bound-note') {
    return () => ({
      ...base(),
      afterMount: async (write) => {
        await write.press('\t');
        await write.press(CONSULT_BOUND_NOTE);
      },
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
  return ({ output, checkpoint }) => {
    const text = stripAnsiStyles(output);
    return text.includes(checkpoint.marker) && markers.every((marker) => text.includes(marker));
  };
}

function excludesAll(...markers: readonly string[]): CheckpointPredicate {
  return ({ output }) => {
    const text = stripAnsiStyles(output);
    return markers.every((marker) => !text.includes(marker));
  };
}

const checkpointPredicates = [
  [
    checkpointId('stop-sheet-recovery'),
    (context) =>
      includesAll('Stop options', 'Stop now', 'End run')(context) &&
      excludesAll('Pause after this brief', 'tab to type a correction')(context),
  ],
  [checkpointId('idle'), includesAll(WORKFLOW_FIXTURE_TEXT.idle)],
  // One planning session: the answered round stays in the transcript, the byline carries the call.
  [checkpointId('planning'), includesAll('Keep the public API?', 'Planning…')],
  [
    checkpointId('start-attached-files'),
    includesAll('Attached files · 2', 'design/receiving-flow.png'),
  ],
  [checkpointId('planning-path-notice'), includesAll('cannot open', 'Planning…')],
  [checkpointId('plan-compiled'), includesAll('plan.md', 'tasks.md')],
  [checkpointId('first-brief-after-plan'), includesAll('Plan', 'T001', '0/3 briefs passed')],
  [checkpointId('build-consult'), includesAll('Claude Code CLI', 'answering the consult on T901')],
  [
    checkpointId('build-review-consult'),
    includesAll('REVIEW → T904', 'Claude Code CLI', 'answering the consult on T904'),
  ],
  // The build-progress block is the fact the implementation checkpoint must carry at every width;
  // the task header scrolls out of a 60x18 transcript, so pinning it would pin the viewport too.
  [
    checkpointId('implementation'),
    includesAll(WORKFLOW_FIXTURE_TEXT.implementation, 'briefs passed'),
  ],
  // The brief's row is the transcript's tail, so its estimate is on screen at every width.
  [checkpointId('implementation-narration'), includesAll('briefs passed')],
  [checkpointId('implementation-adjacent-narration'), includesAll('briefs passed')],
  [checkpointId('implementation-fenced-handback'), includesAll('briefs passed')],
  [checkpointId('implementation-retry'), includesAll('briefs passed')],
  [checkpointId('implementation-after-retry'), includesAll()],
  [checkpointId('recovery-resolved-retry'), includesAll()],
  [checkpointId('review-fix'), includesAll()],
  [
    checkpointId('review-fix-cycles'),
    (context) => {
      const text = stripAnsiStyles(context.output);
      return (
        includesAll(
          '4/4 briefs passed',
          'Review · Reviewer check V2',
          'npm test · running',
        )(context) &&
        (context.viewport.cols < 80 || includesAll('Review 1 failed', 'fixes T904')(context)) &&
        !text.includes('does not take') &&
        !text.includes('Tasks  ') &&
        !/T90[1-3] {2}/u.test(text) &&
        !text.includes('npm test · failed')
      );
    },
  ],
  [checkpointId('complete-after-fix-tasks'), includesAll('4/4 briefs passed')],
  [checkpointId('review-fix-no-change'), includesAll('no change needed')],
  [checkpointId('final-review'), includesAll('3/3 briefs passed', 'Review…', 'Codex CLI')],
  [
    checkpointId('review-render-running'),
    includesAll(
      '3/3 briefs passed',
      'Review · Render workflow-review',
      'running 0:12',
      'Render workflow-review 0:12',
    ),
  ],
  [
    checkpointId('review-task-cadence'),
    includesAll('Review T001 passed', 'Review · Reviewer check V1', 'npm test'),
  ],
  [
    checkpointId('review-task-cadence-settled'),
    (context) =>
      includesAll('Review 1 passed')(context) &&
      (context.viewport.cols < 80 || includesAll('Review T002 failed', 'fixes T003')(context)),
  ],
  [checkpointId('review-settled-passed'), includesAll('● Review 1 passed', '7.0s')],
  [checkpointId('review-settled-failed'), includesAll('✗ Review 1 failed', '7.0s')],
  [checkpointId('review-drift-clean'), includesAll('Drift · clean')],
  [
    checkpointId('review-drift-found'),
    includesAll('Drift · failed · 2 errors · 3 warnings', '3/5 briefs passed'),
  ],
  [
    checkpointId('review-corrected'),
    includesAll('T902', 'Review 1 failed', '7.0s', 'Review 2 passed', '5.0s'),
  ],
  [checkpointId('review-summary'), includesAll('Review · Summary')],
  [checkpointId('review-compaction'), includesAll('Review · Compaction')],
  [
    checkpointId('review-checks-off'),
    includesAll('End-of-run checks', 'off', 'Review…', 'Codex CLI'),
  ],
  [checkpointId('implementation-escalated'), includesAll('briefs passed')],
  [checkpointId('validation'), includesAll('Validate', 'test skipped')],
  [checkpointId('planner-commands-refused'), includesAll('Validation')],
  [checkpointId('touched-not-suggested'), includesAll('also changed')],
  // The live brief is on screen and no row a closed brief owns is left above it.
  [
    checkpointId('completed-orphan-rows'),
    (context) =>
      includesAll('T902')(context) &&
      ['timed out', 'also changed', 'Batch suite'].every(
        (orphan) => !stripAnsiStyles(context.output).includes(orphan),
      ),
  ],
  // The tiered gate owns this checkpoint: it takes the prompt zone from the document panel, so the
  // panel's own words are never on this frame.
  [checkpointId('review'), includesAll('Confirm with a reason', WORKFLOW_FIXTURE_TEXT.review)],
  // The document loads from disk after the panel paints, so each gate waits on the first row of
  // its own document too — otherwise the frame captures a gate over an empty box.
  [checkpointId('selection-copy'), includesAll('End run', 'Edit plan.json')],
  [checkpointId('approval-confirm'), includesAll('Confirm with a reason')],
  [checkpointId('approval-confirm-secret'), includesAll('Confirm with a reason')],
  [checkpointId('plan-card'), includesAll('End run', 'Edit plan.json')],
  [checkpointId('plan-card-render-note'), includesAll('End run', 'Edit plan.json')],
  [checkpointId('plan-card-shared-command'), includesAll('End run', 'Edit plan.json')],
  // The two briefs whose long headers the card once skipped, beside the first and the last.
  [checkpointId('tasks-card'), includesAll('T001', 'T004', 'T006', 'T007')],
  // The subsections the spec card does not nest, and the briefs after T001's unclosed sample.
  [checkpointId('question'), includesAll(WORKFLOW_FIXTURE_TEXT.question)],
  [checkpointId('question-overflow'), includesAll('Question 2 of 3')],
  [checkpointId('question-input'), includesAll('Question 1 of 2', 'New instruction')],
  [checkpointId('reviewer-question'), includesAll('REVIEW → T904', 'Reply to the reviewer')],
  [checkpointId('planner-reply'), includesAll('Reply to the planner…', 'Waiting for your answer')],
  // The transcript pins the tail, so the block's last row is the width-stable marker.
  [checkpointId('question-answered'), includesAll('Simplify/clean up existing code')],
  [checkpointId('consult-answer-default'), includesAll('Which store?', 'You → memory')],
  [checkpointId('consult-answer-typed'), includesAll('Which store?', 'You → redis')],
  [checkpointId('paused-mid-brief'), includesAll('⏎ resume', 'Stopped at T')],
  [checkpointId('paused-boundary'), includesAll('briefs complete', 'before T902')],
  [checkpointId('stopping'), includesAll('esc back after stop')],
  // A run at rest carries its own name: the marker is the session the record names, which the
  // closed block states in full and the open byline carries. Nothing else is width-stable — the
  // byline sheds its reason and then its alternative as the terminal narrows.
  [checkpointId('at-rest-paused'), includesAll()],
  [checkpointId('at-rest-long-park'), includesAll('15:00')],
  [checkpointId('at-rest-halted'), includesAll()],
  [checkpointId('retained-workspace'), includesAll('Workspace kept')],
  [checkpointId('at-rest-waiting'), includesAll()],
  [checkpointId('closed-ready'), includesAll()],
  [checkpointId('ready-to-apply'), includesAll()],
  [checkpointId('ready-override'), includesAll()],
  [checkpointId('closed-applied'), includesAll()],
  [checkpointId('closed-undone'), includesAll('Apply undone')],
  [checkpointId('closed-undo-conflicts'), includesAll('1 conflict kept')],
  [checkpointId('closed-discarded'), includesAll()],
  [checkpointId('closed-needs-attention'), includesAll()],
  [checkpointId('closed-ended'), includesAll()],
  [checkpointId('closed-ended-review'), includesAll()],
  [checkpointId('closed-ended-review-workspace'), includesAll('run.patch')],
  [checkpointId('closed-seat-moved'), includesAll()],
  [checkpointId('closed-mixed-workers'), includesAll('visual-closed-mixed-workers')],
  [checkpointId('replayed'), includesAll()],
  [checkpointId('failure'), includesAll(WORKFLOW_FIXTURE_TEXT.failure, 'Build failed')],
  [checkpointId('recovery'), includesAll(WORKFLOW_FIXTURE_TEXT.recovery)],
  [checkpointId('recovery-plan'), includesAll(WORKFLOW_FIXTURE_TEXT.recoveryPlan)],
  [
    checkpointId('recovery-plan-checks'),
    (context) =>
      includesAll('Criterion C2 is served by no task.')(context) &&
      (context.viewport.cols < 80 ||
        includesAll('The plan failed check uncovered-criterion:', '(+1 more)')(context)),
  ],
  [checkpointId('recovery-plan-questions'), includesAll('Which store keeps the greeting?')],
  [checkpointId('recovery-review'), includesAll(WORKFLOW_FIXTURE_TEXT.recoveryPlan)],
  [checkpointId('recovery-hint'), includesAll(WORKFLOW_FIXTURE_TEXT.recoveryPlan)],
  [checkpointId('recovery-plan-swapped'), includesAll()],
  [checkpointId('seat-switched'), includesAll()],
  [checkpointId('seat-switched-balance'), includesAll()],
  [checkpointId('plan-activity'), includesAll('src/core/crew/identity.ts')],
  [checkpointId('retry-exhausted'), includesAll(WORKFLOW_FIXTURE_TEXT.retryExhausted)],
  [checkpointId('consult-bound'), includesAll(WORKFLOW_FIXTURE_TEXT.consultBound)],
  [
    checkpointId('consult-bound-note'),
    includesAll('Continue with the typed correction', CONSULT_BOUND_NOTE),
  ],
  [checkpointId('review-failed'), includesAll(WORKFLOW_FIXTURE_TEXT.reviewFailed, 'Accept as is')],
  [
    checkpointId('review-unverified'),
    includesAll(WORKFLOW_FIXTURE_TEXT.reviewFailed, 'Accept as is', 'unverified criteria'),
  ],
  [checkpointId('left-isolation'), includesAll(WORKFLOW_FIXTURE_TEXT.leftIsolation)],
  [checkpointId('checkout-changed'), includesAll(WORKFLOW_FIXTURE_TEXT.checkoutChanged)],
  [checkpointId('at-rest-left-isolation'), includesAll()],
  [checkpointId('gates-approved'), includesAll()],
  [checkpointId('gate-stopped'), includesAll()],
  [checkpointId('api-context'), includesAll(WORKFLOW_FIXTURE_TEXT.apiContext, 'Try again')],
  [checkpointId('review-context'), includesAll('Nothing was sent to REVIEW', 'Try again')],
  [checkpointId('review-call-failed'), includesAll('Review call timed out', 'Try again')],
  [
    checkpointId('planning-claude-frames'),
    includesAll(WORKFLOW_FIXTURE_TEXT.planningReply, 'retry 2 of 10'),
  ],
  [
    checkpointId('implementation-silent'),
    includesAll('Implementing…', 'No output for', 'tools report when done'),
  ],
  [
    checkpointId('implementation-tool-running'),
    includesAll('No output for', 'running npx vitest run'),
  ],
  [checkpointId('implementation-silent-bare'), includesAll('Implementing…', 'No output for')],
  [checkpointId('review-check-running'), includesAll('Review · Reviewer check V2')],
  [checkpointId('review-pause-requested'), includesAll('Review · Reviewer check V2')],
  [checkpointId('review-check-long-command'), includesAll('Reviewer check V2 · npx vitest')],
  [checkpointId('review-checks-approve'), includesAll('Run all', 'Skip all', 'V1')],
  [checkpointId('review-checks-skipped'), includesAll('not\u00a0run V1, V2')],
  [checkpointId('review-legacy-suite'), includesAll('Pre-review suite · npm test')],
  // The red check row scrolls out of a 60x18 transcript; the last check that did not run stays.
  [
    checkpointId('review-red-gate'),
    includesAll(
      'REVIEW activity',
      'OpenAI Codex CLI',
      'GPT-6-Astra',
      'npm test · not\u00a0run',
      'Review · OpenAI Codex CLI',
    ),
  ],
  [checkpointId('review-base-rerun'), includesAll('Base re-run', 'src/legacy.test.ts')],
  [checkpointId('review-base-mixed'), includesAll('2\u00a0new,', 'V1 failed')],
  [checkpointId('fix-check-running'), includesAll('Fix check V2 · npm test')],
  [
    checkpointId('fix-check-stopped-continued'),
    includesAll('Fix check V2 · npm test · stopped', 'working on T904'),
  ],
  [
    checkpointId('fix-check-done'),
    // The verdict wraps at narrow widths; the earlier red row scrolls out of a 60x18 transcript.
    (context) =>
      includesAll(
        'your 2 failures gone',
        ...(context.viewport.cols >= 120 ? ['not proven fixed'] : []),
      )({
        ...context,
        output: context.output.replace(/\s+/g, ' '),
      }),
  ],
  [
    checkpointId('review-base-not-verified'),
    // The reason wraps at narrow widths; the last row settles the transcript.
    includesAll('Base re-run V1', 'npm test · not\u00a0run'),
  ],
  [checkpointId('planner-session-expired'), includesAll('Planner session expired')],
] as const satisfies readonly (readonly [CheckpointId, CheckpointPredicate])[];

export const workflowCheckpointPredicates: ReadonlyMap<CheckpointId, CheckpointPredicate> = new Map(
  checkpointPredicates,
);
