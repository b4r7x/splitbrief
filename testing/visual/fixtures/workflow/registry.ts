import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { renderToString } from 'ink';
import { stripAnsiStyles } from '#testing/helpers/ansi.js';
import { SESSION_LOG_FILE, sessionDir } from '../../../../src/core/paths.js';
import { toEngineEventEntry } from '../../../../src/core/sessions/log-writer.js';
import { hydrateRun } from '../../../../src/features/workflow/run-history.js';
import { readConversationScrollSnapshot } from '../../../../src/features/workflow/layout/snapshot.js';
import {
  getConversationRowsProjection,
  getConversationRowsWindowProjection,
} from '../../../../src/features/workflow/conversation-rows/projection-cache.js';
import { rowText } from '../../../../src/features/workflow/conversation-rows/row-format/rows.js';
import type { ConversationRow } from '../../../../src/features/workflow/conversation-rows/types.js';
import { getSections } from '../../../../src/stores/workflow/actions/sections.js';
import { conversationScrollStore } from '../../../../src/stores/workflow/conversation-scroll.js';
import { streamingOutputStore } from '../../../../src/stores/workflow/streaming-output.js';
import type { CheckpointId } from '../../contracts/identifiers.js';
import { checkpointId } from '../../contracts/identifiers.js';
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
  if (
    projection.scenarioId === 'workflow-seat-switched' ||
    projection.scenarioId === 'workflow-seat-switched-manual' ||
    projection.scenarioId === 'workflow-seat-switched-balance' ||
    projection.scenarioId === 'workflow-spent-b2-replay'
  ) {
    return () => {
      const lifecycle = base();
      let expandRecovery = false;
      let checkpoint: CheckpointId;
      return {
        ...lifecycle,
        setup: async (context) => {
          checkpoint = context.checkpoint.id;
          expandRecovery = context.checkpoint.id === 'seat-switched-expanded-recovery';
          await lifecycle.setup(context);
        },
        afterMount: async (write) => {
          if (expandRecovery) await write.press('\u0004');
          const snapshot = readConversationScrollSnapshot();
          const { expandedDiffs, expandedActivityBatches } = conversationScrollStore.get();
          const rowsProjection = getConversationRowsProjection({
            sections: getSections(),
            expandedDiffs,
            expandedActivityBatches,
            cols: snapshot.conversationWidth,
            viewportHeight: snapshot.transcriptViewportHeight,
            streaming: streamingOutputStore.get(),
          });
          const { rows } = getConversationRowsWindowProjection({
            projection: rowsProjection,
            windowStart: 0,
            windowEnd: rowsProjection.totalRows,
          });
          let first = rows.findIndex((row) => rowText(row).startsWith('Recovery'));
          if (checkpoint !== 'spent-b2-replay' && checkpoint.startsWith('spent-b2-replay-')) {
            const brief = checkpoint.includes('-t001-') ? 'T001' : 'T002';
            const start = rows.findIndex((row) =>
              transcriptRowText(row, snapshot.conversationWidth)
                .trimStart()
                .startsWith(`● ${brief}`),
            );
            if (start < 0) throw new Error(`Missing replay brief ${brief}`);
            const marker = checkpoint.endsWith('-activity')
              ? 'BUILD activity'
              : brief === 'T001'
                ? 'src/text.js ·'
                : 'src/preview.js ·';
            first = rows.findIndex(
              (row, index) => index >= start && rowText(row).startsWith(marker),
            );
            if (first < 0) throw new Error(`Missing replay scroll target ${checkpoint}`);
          }
          const step = snapshot.maxOffset - Math.max(0, first);
          if (step > 0) conversationScrollStore.scrollUp({ ...snapshot, step });
        },
      };
    };
  }
  if (projection.scenarioId === 'workflow-review-fix-narrow-rail') {
    return () => {
      const lifecycle = base();
      let showStopSheet = false;
      return {
        ...lifecycle,
        setup: async (context) => {
          showStopSheet = context.checkpoint.id === 'review-fix-narrow-rail-stop';
          await lifecycle.setup(context);
        },
        afterMount: () => {
          if (showStopSheet) overlayStore.open('stop-sheet');
        },
      };
    };
  }
  const atRest = projection.atRest;
  if (atRest !== undefined && projection.events.length > 0) {
    return () => {
      const lifecycle = base();
      return {
        ...lifecycle,
        setup: async (context) => {
          await lifecycle.setup(context);
          const { projectDir, sessionId } = atRest.record.ref;
          const directory = sessionDir(projectDir, sessionId);
          await mkdir(directory, { recursive: true });
          await writeFile(
            join(directory, SESSION_LOG_FILE),
            `${projection.events.map((event) => JSON.stringify(toEngineEventEntry(event))).join('\n')}\n`,
          );
          await hydrateRun(atRest.record);
        },
      };
    };
  }
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
  if (projection.scenarioId === 'workflow-implementation-shell-wrapper') {
    return () => ({
      ...base(),
      afterMount: async (write) => {
        await write.press('\u0001');
      },
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
    return output.includes(checkpoint.marker) && markers.every((marker) => output.includes(marker));
  };
}

function excludesAll(...markers: readonly string[]): CheckpointPredicate {
  return ({ output }) => markers.every((marker) => !output.includes(marker));
}

function transcriptRowText(row: ConversationRow, columns: number): string {
  return stripAnsiStyles(
    row.node === undefined
      ? rowText(row)
      : renderToString(typeof row.node === 'function' ? row.node(false) : row.node, { columns }),
  );
}

export function workflowTranscriptText(): string {
  const { conversationWidth, transcriptViewportHeight } = readConversationScrollSnapshot();
  const { expandedDiffs, expandedActivityBatches } = conversationScrollStore.get();
  const projection = getConversationRowsProjection({
    sections: getSections(),
    expandedDiffs,
    expandedActivityBatches,
    cols: conversationWidth,
    viewportHeight: transcriptViewportHeight,
    streaming: streamingOutputStore.get(),
  });
  const { rows } = getConversationRowsWindowProjection({
    projection,
    windowStart: 0,
    windowEnd: projection.totalRows,
  });
  return rows.map((row) => transcriptRowText(row, conversationWidth)).join('\n');
}

function includesTranscript(...markers: readonly string[]): CheckpointPredicate {
  return (context) => {
    const text = workflowTranscriptText();
    return (
      (stripAnsiStyles(context.output).includes(context.checkpoint.marker) ||
        text.includes(context.checkpoint.marker)) &&
      markers.every((marker) => text.includes(marker))
    );
  };
}

function implementerMarkdown(label: string): CheckpointPredicate {
  return (context) => {
    if (!includesAll('briefs passed')(context) || !excludesAll('](file:')(context)) return false;
    const text = workflowTranscriptText();
    return text.includes(label) && !text.includes('](file:');
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
  [checkpointId('composer-outside-file'), includesAll('Attached files · 1', 'Planning…')],
  [checkpointId('question-outside-file'), includesAll('Attached files · 1', 'Planning…')],
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
  [
    checkpointId('implementation-extracted-code'),
    () => {
      const text = workflowTranscriptText().replace(/\s/g, '');
      return ['file-bundle-v1', '__init__(*args)', '<!--keep-->', '`code`'].every((marker) =>
        text.includes(marker),
      );
    },
  ],
  [checkpointId('implementation-narration'), implementerMarkdown('src/registry.ts')],
  [checkpointId('implementation-adjacent-narration'), implementerMarkdown('src/fixture.ts')],
  [checkpointId('implementation-fenced-handback'), implementerMarkdown('src/row.ts')],
  [
    checkpointId('continuous-transcript'),
    includesTranscript('● Plan', '● T001', 'lowStockItems', 'T003 Test the receiving flow'),
  ],
  [
    checkpointId('continuous-transcript-ready'),
    includesTranscript('● Review 1 passed', 'Plan check K1', 'Plan check K2', 'Reviewer check V1'),
  ],
  [
    checkpointId('implementation-queued'),
    includesAll('Queued', 'Keep the parser changes small.', '1 queued for BUILD on T003'),
  ],
  [checkpointId('implementation-delivered'), includesAll('Delivered', 'to BUILD on T003')],
  [
    checkpointId('implementation-steerable'),
    includesAll('mid-call to BUILD on T003', 'Message BUILD on T003 · read after this tool…'),
  ],
  [checkpointId('implementation-retry'), includesAll('briefs passed')],
  [checkpointId('implementation-after-retry'), includesAll()],
  [checkpointId('recovery-resolved-retry'), includesAll()],
  [checkpointId('review-fix'), includesAll()],
  [
    checkpointId('review-fix-cycles'),
    (context) => {
      const text = context.output;
      return (
        includesAll(
          '4/4 briefs passed',
          'Review · Reviewer check V2',
          'npm test · running',
        )(context) &&
        includesTranscript('Review 1 failed', 'fixes T904')(context) &&
        !text.includes('does not take') &&
        workflowTranscriptText().split('Tasks  18 lines').length === 2
      );
    },
  ],
  [checkpointId('complete-after-fix-tasks'), includesAll('4/4 briefs passed')],
  [checkpointId('review-fix-no-change'), includesAll('no change needed')],
  [checkpointId('final-review'), includesAll('3/3 briefs passed', 'Review · OpenAI Codex CLI')],
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
    (context) =>
      includesTranscript('Review T001 passed')(context) &&
      includesAll('Review · Reviewer check V1', 'npm test')(context),
  ],
  [
    checkpointId('review-task-cadence-settled'),
    includesTranscript('Review 1 passed', 'Review T002 failed', 'fixes T003'),
  ],
  [checkpointId('review-task-out-of-scope'), includesAll('Review T001 passed', '3 notes')],
  [checkpointId('review-drift-clean'), includesAll('Drift · clean')],
  [
    checkpointId('review-drift-found'),
    includesAll('Drift · failed · 2 errors · 3 warnings', '3/5 briefs passed'),
  ],
  [checkpointId('review-settled-passed'), includesTranscript('● Review 1 passed', '7.0s')],
  [checkpointId('review-settled-failed'), includesTranscript('✗ Review 1 failed', '7.0s')],
  [
    checkpointId('review-corrected'),
    includesTranscript('T902', 'Review 1 failed', '7.0s', 'Review 2 passed', '5.0s'),
  ],
  [checkpointId('review-summary'), includesAll('Review · Summary')],
  [checkpointId('review-compaction'), includesAll('Review · Compaction')],
  [
    checkpointId('review-checks-off'),
    includesAll('End-of-run checks', 'off', 'Review · OpenAI Codex CLI'),
  ],
  [checkpointId('implementation-escalated'), includesAll('briefs passed')],
  [checkpointId('review-fix-narrow-rail'), includesAll('T006')],
  [checkpointId('review-fix-narrow-rail-stop'), includesAll()],
  [checkpointId('task-statuses'), includesAll('escalated', 'failed', 'skipped')],
  [checkpointId('validation'), includesAll('Validate', 'test skipped')],
  [checkpointId('planner-commands-refused'), includesAll('Validation')],
  [checkpointId('touched-not-suggested'), includesAll('also changed')],
  [
    checkpointId('completed-orphan-rows'),
    includesTranscript(
      '● T901',
      'could not be read',
      'also changed',
      'T902 Register the bounded fixture projection',
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
  [checkpointId('at-rest-queued'), includesAll('Stopped at T003', '1 queued')],
  [checkpointId('at-rest-long-park'), includesAll('15:00')],
  [checkpointId('at-rest-halted'), includesAll()],
  [checkpointId('retained-workspace'), includesAll('Workspace kept')],
  [checkpointId('at-rest-waiting'), includesAll()],
  [checkpointId('closed-complete'), includesAll()],
  [checkpointId('ready-to-apply'), includesAll()],
  [checkpointId('ready-override'), includesAll()],
  [checkpointId('closed-applied'), includesAll()],
  [checkpointId('closed-undone'), includesAll('Apply undone')],
  [checkpointId('closed-undo-conflicts'), includesAll('1 conflict kept')],
  [checkpointId('closed-discarded'), includesAll()],
  [checkpointId('closed-needs-attention'), includesAll()],
  [checkpointId('closed-ended'), includesAll()],
  [checkpointId('closed-ended-workspace'), includesAll('run.patch')],
  [checkpointId('closed-ended-review'), includesAll()],
  [checkpointId('closed-ended-review-workspace'), includesAll('run.patch')],
  [checkpointId('closed-seat-moved'), includesAll()],
  [checkpointId('closed-mixed-workers'), includesAll('visual-closed-mixed-workers')],
  [checkpointId('replayed'), includesAll()],
  [checkpointId('failure'), includesAll(WORKFLOW_FIXTURE_TEXT.failure, 'Build failed')],
  [checkpointId('recovery'), includesAll(WORKFLOW_FIXTURE_TEXT.recovery)],
  [checkpointId('recovery-no-fallback'), includesAll(WORKFLOW_FIXTURE_TEXT.recovery)],
  [checkpointId('recovery-fallback-used'), includesAll(WORKFLOW_FIXTURE_TEXT.recovery)],
  [checkpointId('recovery-fallback-not-installed'), includesAll(WORKFLOW_FIXTURE_TEXT.recovery)],
  [checkpointId('recovery-plan'), includesAll(WORKFLOW_FIXTURE_TEXT.recoveryPlan)],
  [
    checkpointId('recovery-plan-checks'),
    (context) =>
      includesAll('Criterion C2 is served by no task.')(context) &&
      (context.viewport.cols < 80 ||
        includesAll('The plan failed check uncovered-criterion:', '(+1 more)')(context)),
  ],
  [checkpointId('recovery-plan-questions'), includesAll('Which store keeps the greeting?')],
  [checkpointId('recovery-review'), includesAll()],
  [checkpointId('recovery-hint'), includesAll(WORKFLOW_FIXTURE_TEXT.recoveryPlan)],
  [checkpointId('recovery-plan-swapped'), includesAll()],
  [
    checkpointId('seat-switched'),
    (context) =>
      includesTranscript(
        'Recovery  Balance spent on OpenCode CLI',
        'automatic fallback',
      )(context) &&
      excludesAll('Add credit', 'Change BUILD tool')(context) &&
      !workflowTranscriptText().includes('BUILD failed'),
  ],
  [checkpointId('seat-switched-manual'), excludesAll('automatic fallback')],
  [checkpointId('seat-switched-balance'), includesAll()],
  [
    checkpointId('seat-switched-expanded-recovery'),
    includesTranscript('provider.quota: Insufficient Balance', 'ctrl+d to collapse'),
  ],
  [
    checkpointId('spent-b2-replay'),
    (context) => {
      const text = workflowTranscriptText();
      const fileRows = text.split('\n').filter((row) => /^src\/(text|preview)\.js ·/.test(row));
      return (
        includesTranscript(
          'Recovery  Balance spent on OpenCode CLI',
          'BUILD  OpenCode CLI · deepseek/deepseek-flash',
          '→ OpenCode CLI · opencode-go/deepseek-v4.1-flash · high',
          '● T001',
          '● T002',
        )(context) &&
        text.split('Recovery  ').length === 2 &&
        !['BUILD seat changed', 'Warning', 'Add credit', 'Change BUILD tool'].some((marker) =>
          text.includes(marker),
        ) &&
        fileRows.length === 2 &&
        ['text', 'preview'].every((name) => {
          const line = fileRows.find((row) => row.startsWith(`src/${name}.js ·`));
          return (
            line !== undefined &&
            line.split(`src/${name}.js`).length === 2 &&
            line.split(`test/${name}.test.js`).length === 2
          );
        })
      );
    },
  ],
  [
    checkpointId('spent-b2-replay-t001-activity'),
    includesAll('+1 more · ctrl+a', 'Edit    test/text.test.js'),
  ],
  [checkpointId('spent-b2-replay-t001-completion'), includesAll()],
  [
    checkpointId('spent-b2-replay-t002-activity'),
    includesAll('+1 more · ctrl+a', 'Edit    test/preview.test.js'),
  ],
  [checkpointId('spent-b2-replay-t002-completion'), includesAll()],
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
  [
    checkpointId('implementation-shell-wrapper'),
    includesAll('src/loans/renewals.ts', 'renewal window', 'overdue'),
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

/** Predicates receive ANSI-free frame text from checkpointPredicate or waitForCheckpoint. */
export const workflowCheckpointPredicates: ReadonlyMap<CheckpointId, CheckpointPredicate> = new Map(
  checkpointPredicates,
);
