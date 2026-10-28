import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { renderToString } from 'ink';
import { stripAnsiStyles } from '#testing/helpers/ansi.js';
import { SESSION_LOG_FILE, sessionDir } from '../../../../src/core/paths.js';
import { toEngineEventEntry } from '../../../../src/core/sessions/log-writer.js';
import { hydrateRun } from '../../../../src/features/workflow/run-history.js';
import { endRunAtRest } from '../../../../src/engine/orchestrator/run/close.js';
import { createRecoveryBus } from '../../../../src/engine/orchestrator/recovery/bus.js';
import { saveState } from '../../../../src/core/state/persistence.js';
import { writeEvidenceLedger } from '../../../../src/core/evidence/ledger-storage.js';
import { WORKFLOW_STATE_VERSION } from '../../../../src/core/schemas/workflow.js';
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
import {
  LONG_COMPOSER_DRAFT,
  VISUAL_FIXTURE_EPOCH,
  type CheckpointPredicate,
  type FixtureFactory,
  type FixtureRegistry,
  type FixtureWrite,
} from '../common.js';
import { markWorkflowPaused } from '../../../../src/stores/workflow/actions/pause.js';
import { lifecycleStore } from '../../../../src/stores/workflow/lifecycle.js';
import { glyph } from '../../../../src/lib/glyphs.js';
import { feedbackStore } from '../../../../src/stores/ui/feedback.js';
import { composerDraftStore } from '../../../../src/stores/ui/composer-draft.js';
import { reviewKeysStore } from '../../../../src/stores/ui/review-keys.js';
import { REVIEW_COMMENT_HINTS } from '../../../../src/features/workflow/prompt-rows/approval.js';
import { formatCopyResult } from '../../../../src/core/runtime/commands/types.js';
import { stopStore } from '../../../../src/stores/workflow/stop.js';
import { departureStore } from '../../../../src/stores/workflow/departure.js';
import {
  activeApply,
  trackActiveApply,
} from '../../../../src/engine/orchestrator/session-lifecycle/shutdown.js';
import { overlayStore } from '../../../../src/stores/ui/overlay.js';
import { PROMPT_TYPEAHEAD_GRACE_MS } from '../../../../src/lib/terminal/typeahead-grace.js';
import {
  WORKFLOW_FIXTURE_TEXT,
  workflowFixtureProjections,
  type FixtureStopState,
  type WorkflowFixtureProjection,
} from './projections.js';
import {
  OUTPUT_LIMIT_TOOL_CALLS_MESSAGE,
  OUTPUT_LIMIT_TOOL_OUTPUT_MESSAGE,
} from './output-limit-projection.js';
import { createWorkflowFixtureFactory } from './setup.js';

const PLAN_USAGE_LIMIT_FRAGMENT = "You've used 75%";

function applyStop(stop: FixtureStopState): void {
  stopStore.__testReset({
    intent: stop.intent,
    phase: stop.phase,
    seatChange: stop.seatChange ?? false,
    requestedAt: Date.now(),
    // The screen parks a stop with the engine's continuation, so the fixture gives it one.
    parked:
      stop.parked === undefined ? null : { kept: [], ...stop.parked, resolve: () => undefined },
  });
  if (stop.phase === 'parked') markWorkflowPaused();
}

// The stop ladder lives in a store, not in the event stream, and the workflow screen resets the
// session-scoped stores from a mount effect (`use-runner.ts`) and replays the projection after it.
// Stamping on every run start is what survives that replay.
const CONSULT_BOUND_NOTE = 'run the formatter first';
const PLAN_CARD_COMMENT_DRAFT = 'Split the CLI change into a separate task.';
const TYPED_WORDS = 'keep the old lockfile';

function createStopAwareFactory(projection: WorkflowFixtureProjection): FixtureFactory {
  const base = createWorkflowFixtureFactory(projection);
  if (projection.scenarioId === 'workflow-plan-card-commenting') {
    return () => ({
      ...base(),
      afterMount: () => {
        reviewKeysStore.requestComment();
        composerDraftStore.request(PLAN_CARD_COMMENT_DRAFT);
      },
    });
  }
  if (projection.scenarioId === 'workflow-composer-long-draft') {
    return () => ({
      ...base(),
      afterMount: () => composerDraftStore.request(LONG_COMPOSER_DRAFT),
    });
  }
  if (projection.scenarioId === 'workflow-plan-card-request-empty') {
    return () => ({ ...base(), afterMount: () => reviewKeysStore.requestComment() });
  }
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
  if (projection.scenarioId === 'workflow-ready-composer-focus') {
    return () => ({ ...base(), afterMount: (write) => write.press('\t') });
  }
  if (projection.scenarioId === 'workflow-ready-slash-command') {
    return () => ({ ...base(), afterMount: (write) => write.press('/settings') });
  }
  if (projection.scenarioId === 'workflow-ready-override-confirm') {
    return () => ({ ...base(), afterMount: (write) => write.press('\r') });
  }
  if (projection.scenarioId === 'workflow-ready-empty-diff') {
    return () => ({
      ...base(),
      afterMount: () => feedbackStore.setMessage('No run changes to show.'),
    });
  }
  if (projection.scenarioId === 'workflow-closed-undone') {
    return () => ({
      ...base(),
      afterMount: () => feedbackStore.setMessage('Apply undone: removed 2 created files.'),
    });
  }
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
  // The words go through the screen's own composer and ⏎, so the refusal on screen is the real one.
  if (atRest !== undefined && projection.scenarioId === 'workflow-at-rest-typed-words') {
    return () => {
      const lifecycle = base();
      const { record } = atRest;
      if (record.hydration.kind !== 'loaded') throw new Error('typed-words needs a state');
      const saved = {
        ...record.hydration.state,
        stateVersion: WORKFLOW_STATE_VERSION,
        stateRevision: 0,
        startedAt: new Date(VISUAL_FIXTURE_EPOCH).toISOString(),
      };
      return {
        ...lifecycle,
        setup: async (context) => {
          await lifecycle.setup(context);
          saveState(record.ref, saved);
        },
        afterMount: async (write) => {
          const fixedNow = Date.now;
          Date.now = () => fixedNow() + PROMPT_TYPEAHEAD_GRACE_MS;
          try {
            await write.press(TYPED_WORDS);
            await write.press('\r');
          } finally {
            Date.now = fixedNow;
          }
        },
      };
    };
  }
  if (atRest !== undefined && projection.scenarioId === 'workflow-at-rest-closed-elsewhere') {
    return () => {
      const lifecycle = base();
      const { record } = atRest;
      if (record.hydration.kind !== 'loaded') throw new Error('closed-elsewhere needs a state');
      const saved = {
        ...record.hydration.state,
        stateVersion: WORKFLOW_STATE_VERSION,
        stateRevision: 0,
        startedAt: new Date(VISUAL_FIXTURE_EPOCH).toISOString(),
      };
      return {
        ...lifecycle,
        setup: async (context) => {
          await lifecycle.setup(context);
          saveState(record.ref, saved);
          if (record.ledger !== null) writeEvidenceLedger(record.ref, record.ledger);
          stopStore.park('mid-brief', null, null);
          overlayStore.open('stop-sheet');
        },
        afterMount: async () => {
          const bus = createRecoveryBus({ ...record.ref, sink: () => {} });
          await endRunAtRest({ ...record.ref, bus }, saved);
        },
      };
    };
  }
  if (
    projection.scenarioId.startsWith('workflow-at-rest-applying') ||
    projection.scenarioId.startsWith('workflow-live-applying')
  ) {
    // The Apply this process runs, held open for the capture and settled at teardown. Esc goes
    // through the screen's own keys; the preview stubs quitting, so the queued quit is seeded.
    const afterMount =
      projection.scenarioId === 'workflow-at-rest-applying-home-queued' ||
      projection.scenarioId === 'workflow-live-applying-home-queued'
        ? (write: FixtureWrite) => write.press('\u001b')
        : projection.scenarioId === 'workflow-at-rest-applying-quit-queued'
          ? () => departureStore.__testReset({ kind: 'quit', run: () => {} })
          : undefined;
    return () => {
      const lifecycle = base();
      const apply = Promise.withResolvers<void>();
      return {
        setup: async (context) => {
          await lifecycle.setup(context);
          void trackActiveApply(apply.promise);
        },
        ...(afterMount !== undefined && { afterMount }),
        teardown: async () => {
          apply.resolve();
          await activeApply();
          departureStore.__testReset();
          return lifecycle.teardown();
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
  if (projection.scenarioId === 'workflow-recovery-apply-conflict-sentence') {
    return () => ({
      ...base(),
      afterMount: async (write) => {
        const fixedNow = Date.now;
        Date.now = () => fixedNow() + PROMPT_TYPEAHEAD_GRACE_MS;
        try {
          await write.press('\t');
          await write.press(TYPED_WORDS);
          await write.press('\r');
        } finally {
          Date.now = fixedNow;
        }
      },
    });
  }
  if (projection.scenarioId === 'workflow-recovery-apply-partial-words') {
    return () => ({
      ...base(),
      afterMount: async (write) => {
        const fixedNow = Date.now;
        Date.now = () => fixedNow() + PROMPT_TYPEAHEAD_GRACE_MS;
        try {
          await write.press('\t');
          await write.press(TYPED_WORDS);
          await write.press('\t');
          await write.press('\r');
        } finally {
          Date.now = fixedNow;
        }
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
  if (
    projection.scenarioId === 'workflow-recovery-slash-draft' ||
    projection.scenarioId === 'workflow-recovery-slash-list'
  ) {
    const draft = projection.scenarioId === 'workflow-recovery-slash-draft' ? '/scroll top ' : '/s';
    return () => ({
      ...base(),
      afterMount: async (write) => {
        await write.press('\t');
        await write.press(draft);
      },
    });
  }
  if (projection.scenarioId === 'workflow-resuming') {
    return () => {
      const lifecycle = base();
      let off: (() => void) | null = null;
      return {
        setup: async (context) => {
          off = lifecycleStore.subscribe(() => {
            if (lifecycleStore.get().status === 'running') markWorkflowPaused();
          });
          await lifecycle.setup(context);
          markWorkflowPaused();
        },
        teardown: () => {
          off?.();
          off = null;
          return lifecycle.teardown();
        },
      };
    };
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

// One recovery reads as one row: each choice and its outcome on its own Recovery line, in order.
function recoveryRows(...expected: readonly (readonly string[])[]): CheckpointPredicate {
  return (context) => {
    const rows = workflowTranscriptText()
      .split('\n')
      .filter((line) => line.includes('Recovery  '));
    return (
      includesTranscript()(context) &&
      rows.length === expected.length &&
      expected.every((fragments, index) =>
        fragments.every((fragment) => rows[index]?.includes(fragment) === true),
      )
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

const planCardReady = includesAll(
  'End run',
  'Edit plan.json',
  'Add a greeting module and expose it from the CLI.',
);

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
  [checkpointId('composer-long-draft'), includesAll('label printer.', 'Planning…')],
  [checkpointId('question-outside-file'), includesAll('Attached files · 1', 'Planning…')],
  [checkpointId('planning-path-notice'), includesAll('cannot open', 'Planning…')],
  [
    checkpointId('start-readiness-warning'),
    includesAll('Warning', 'Examples: README.md', 'reverted/', 'Planning…'),
  ],
  [checkpointId('plan-compiled'), includesAll('plan.md', 'tasks.md')],
  [checkpointId('first-brief-after-plan'), includesAll('Plan', 'T001', '0/3 briefs passed')],
  [checkpointId('build-consult'), includesAll('Claude Code CLI', 'answering the consult on T901')],
  [checkpointId('build-brief-check'), includesAll('Plan check K2', 'read after its checks')],
  [checkpointId('build-brief-check-seat-change'), includesAll('Plan check K2')],
  [checkpointId('implementation-shell-seat'), includesAll('Custom Shell')],
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
    includesTranscript(
      '● Final review passed',
      'Plan check K1',
      'Plan check K2',
      'Reviewer check V1',
    ),
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
  [checkpointId('recovery-resolved-skip'), recoveryRows(['Recovery  Skip task', 'skipped'])],
  [
    checkpointId('recovery-resolved-dependency-skip'),
    recoveryRows(['Recovery  Skip task', 'skipped'], ['Recovery  Dependency blocked']),
  ],
  [checkpointId('recovery-resolved-apply-retry'), includesAll('Run continued')],
  [checkpointId('review-fix'), includesAll()],
  [checkpointId('review-choosing-checks'), includesAll()],
  [
    checkpointId('review-after-pause'),
    (context) => {
      const text = workflowTranscriptText();
      const continued = text.indexOf('Run continued');
      const finalReview = text.indexOf('Final review');
      return (
        includesTranscript('Final review')(context) &&
        !text.includes('Final review stopped') &&
        continued !== -1 &&
        finalReview !== -1 &&
        continued < finalReview
      );
    },
  ],
  [checkpointId('review-verdict-only'), includesAll()],
  [
    checkpointId('review-check-crash'),
    includesTranscript('Final review stopped', 'Run continued', 'Final review re-run passed'),
  ],
  [
    checkpointId('review-resumed'),
    includesTranscript('Final review stopped', 'Run continued', 'Final review re-run passed'),
  ],
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
        includesTranscript('Final review failed', 'fixes T904')(context) &&
        !text.includes('does not take') &&
        workflowTranscriptText()
          .split('\n')
          .filter((line) => line.trim() === 'Tasks').length === 1
      );
    },
  ],
  [
    checkpointId('rejected-rerun'),
    (context) => {
      const lines = workflowTranscriptText().split('\n');
      const count = (text: string) => lines.filter((line) => line.includes(text)).length;
      return (
        includesTranscript()(context) &&
        count('T901 Project') === 2 &&
        count('T902 Register') === 2 &&
        count('Stopped at T902') === 1 &&
        count('Rejected') === 1 &&
        count('Run continued') === 1
      );
    },
  ],
  [
    checkpointId('apply-rereview'),
    includesTranscript('Final review after 1 fix cycle passed', 'Final review after 2 fix cycles'),
  ],
  [
    checkpointId('complete-after-fix-tasks'),
    (context) => {
      const [rail = ''] = context.output.split('\n');
      return (
        includesAll()(context) &&
        rail.split(glyph('stageDone')).length === 4 &&
        excludesAll('done ·', 'drift not run', 'briefs passed')(context) &&
        (context.viewport.cols < 160 || context.output.includes('Tasks 4/4')) &&
        (context.viewport.cols < 80 || context.output.includes('+1 file'))
      );
    },
  ],
  [checkpointId('review-fix-no-change'), includesAll('no change needed')],
  [
    checkpointId('resumed-kept-work'),
    // At 60 columns the verdict wraps before "further change".
    includesTranscript(
      'Report  done · 0 decisions',
      "verified · kept the interrupted attempt's work",
      'further change',
    ),
  ],
  [checkpointId('final-review'), includesAll('3/3 briefs passed', 'Review · OpenAI Codex CLI')],
  [
    checkpointId('final-review-plan-check'),
    includesAll('Final review', 'Review · OpenAI Codex CLI'),
  ],
  [
    checkpointId('review-verify'),
    includesAll('Verify K1', 'Review · Verify V1 · npm test', 'running 0:12'),
  ],
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
    includesTranscript(
      'Final review after 1 fix cycle passed',
      'Review T002 failed',
      'Blocking F1',
      'PLAN rejected 1 decision for T003',
      'fixes T003',
    ),
  ],
  [checkpointId('review-task-out-of-scope'), includesAll('Review T001 passed', '3 notes')],
  [checkpointId('review-drift-clean'), includesAll('Drift · clean')],
  [
    checkpointId('review-drift-found'),
    includesAll('Drift · failed · 2 errors · 3 warnings', '3/5 briefs passed'),
  ],
  [checkpointId('review-settled-passed'), includesTranscript('● Final review passed', '7.0s')],
  [
    checkpointId('review-settled-set-aside'),
    includesTranscript('Set aside V2.1', 'Transient 60 s'),
  ],
  [checkpointId('review-settled-failed'), includesTranscript('✗ Final review failed', '7.0s')],
  [
    checkpointId('review-corrected'),
    includesTranscript('T902', 'Final review failed', '7.0s', 'Final review re-run passed', '5.0s'),
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
  [checkpointId('plan-check-refused'), includesAll('Plan check K2', 'refused')],
  [checkpointId('plan-check-not-run'), includesAll('Plan check K4 · not')],
  [checkpointId('plan-check-missing-program'), includesAll('Plan check K4 · npm test', 'mocha')],
  [checkpointId('plan-check-no-test-file'), includesAll('Plan check K4 · failed', 'loud.test.mjs')],
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
  [checkpointId('plan-card'), planCardReady],
  [
    checkpointId('plan-card-commenting'),
    (context) =>
      planCardReady(context) && includesAll(PLAN_CARD_COMMENT_DRAFT, REVIEW_COMMENT_HINTS)(context),
  ],
  [
    checkpointId('plan-card-request-empty'),
    (context) => planCardReady(context) && includesAll(REVIEW_COMMENT_HINTS)(context),
  ],
  [
    checkpointId('plan-repaired'),
    (context) =>
      includesAll('- Task T001 has no check.', 'The revised plan passes its checks.')(context) &&
      (context.viewport.cols < 80 ||
        includesAll('Warning', 'The plan failed 2 checks.', 'SPLITBRIEF')(context)),
  ],
  [checkpointId('plan-card-render-note'), planCardReady],
  [checkpointId('plan-card-shared-command'), planCardReady],
  [checkpointId('plan-card-session-path'), planCardReady],
  // The two briefs whose long headers the card once skipped, beside the first and the last.
  [checkpointId('tasks-card'), includesAll('T001', 'T004', 'T006', 'T007')],
  // The subsections the spec card does not nest, and the briefs after T001's unclosed sample.
  [checkpointId('question'), includesAll(WORKFLOW_FIXTURE_TEXT.question)],
  [checkpointId('question-overflow'), includesAll('Question 2 of 3')],
  [checkpointId('question-default'), includesAll('Question 1 of 1', 'Write your own answer…')],
  [checkpointId('question-input'), includesAll('Question 1 of 2', 'Review the current diff')],
  [checkpointId('reviewer-question'), includesAll('REVIEW → T904', 'Reply to the reviewer')],
  [checkpointId('planner-reply'), includesAll('Reply to the planner…', 'Waiting for your answer')],
  // The transcript pins the tail, so the block's last row is the width-stable marker.
  [checkpointId('question-answered'), includesAll('Simplify/clean up existing code')],
  [
    checkpointId('question-replied'),
    includesAll('Answered · 2 questions', '· Which module should change?', 'keep the public API.'),
  ],
  [
    checkpointId('question-unanswered'),
    includesAll('Unanswered · 2 questions', '(yes / no)', 'Type your answer…'),
  ],
  [
    checkpointId('reviewer-question-unanswered'),
    includesAll('Unanswered · 1 question', 'Reply to the reviewer…'),
  ],
  [checkpointId('consult-answer-default'), includesAll('Which store?', 'You → memory')],
  [checkpointId('consult-answer-typed'), includesAll('Which store?', 'You → redis')],
  [checkpointId('decision-question'), includesAll('Did you ask for greet')],
  [checkpointId('decision-guidance'), includesAll('guidance', 'Yes, keep the default export')],
  [
    checkpointId('paused-mid-brief'),
    includesAll('⏎ resume', 'Stopped at T', 'Partial changes kept'),
  ],
  [checkpointId('paused-cut-seat'), includesAll('⏎ resume', 'Stopped at T')],
  [checkpointId('paused-boundary'), includesAll('briefs complete', 'before T902')],
  [checkpointId('stopping'), includesAll('esc back after stop')],
  // A run at rest carries its own name: the marker is the session the record names, which the
  // closed block states in full and the open byline carries. Nothing else is width-stable — the
  // byline sheds its reason and then its alternative as the terminal narrows.
  [checkpointId('at-rest-paused'), includesAll()],
  [checkpointId('at-rest-queued'), includesAll('Stopped at T003', '1 queued')],
  [checkpointId('at-rest-halted'), includesAll()],
  [checkpointId('at-rest-seat-wait'), includesAll()],
  [
    checkpointId('at-rest-seat-moved'),
    (context) => includesAll()(context) && excludesAll('Waiting for')(context),
  ],
  [checkpointId('at-rest-halted-chosen'), includesAll('⏎ to try again')],
  [
    checkpointId('at-rest-prompt-too-large'),
    // Below 80 columns the byline sheds its reason and keeps only "Seat down".
    (context) =>
      includesAll()(context) &&
      excludesAll('Context overflow', 'argv')(context) &&
      (context.viewport.cols < 80 ||
        includesAll('Seat down · Prompt too large for OpenAI Codex CLI on T002')(context)),
  ],
  [
    checkpointId('at-rest-typed-words'),
    includesAll('Cannot send words with Restore backup. Clear them.', TYPED_WORDS),
  ],
  [
    checkpointId('at-rest-apply-conflict'),
    (context) =>
      includesAll('Apply found 2 conflicting files')(context) && excludesAll('the review')(context),
  ],
  [
    checkpointId('recovery-apply-conflict-sentence'),
    includesAll('This halt takes no typed correction', TYPED_WORDS),
  ],
  [
    checkpointId('recovery-apply-conflict'),
    (context) =>
      includesAll('Re-run Apply', 'Apply found 2 conflicting files')(context) &&
      excludesAll('the review')(context),
  ],
  // The halt is on screen and the live resume into Apply has landed.
  [
    checkpointId('recovery-resumed-apply-partial'),
    (context) =>
      includesAll('Apply stopped part way')(context) && lifecycleStore.get().status === 'running',
  ],
  [
    checkpointId('recovery-build-prompt-too-large'),
    (context) =>
      includesAll('Seat down · Prompt too large for', 'Change BUILD tool')(context) &&
      excludesAll('Try again', 'argv', 'Context overflow')(context),
  ],
  [
    checkpointId('recovery-apply-partial-words'),
    includesAll('Cannot send words with', TYPED_WORDS, 'tab edit the words'),
  ],
  [
    checkpointId('recovery-review-contract'),
    includesAll('Seat down · The reviewer seat', 'Try again'),
  ],
  [
    checkpointId('recovery-review-prompt-too-large'),
    (context) =>
      includesAll('Seat down · Review input too large for', 'Change REVIEW tool')(context) &&
      excludesAll('Try again')(context),
  ],
  [checkpointId('resuming'), includesAll('Resuming T')],
  [
    checkpointId('at-rest-closed-elsewhere'),
    (context) => {
      const snapshot = readConversationScrollSnapshot();
      const above = snapshot.maxOffset - snapshot.scrollOffset;
      return (
        includesAll('Ended ·')(context) &&
        excludesAll('Resume ·', '⏎ resume')(context) &&
        (above === 0 || context.output.includes(`${above} lines above`))
      );
    },
  ],
  [checkpointId('at-rest-crashed-build'), includesAll('interrupted', 'Stopped at T002')],
  [checkpointId('at-rest-failed-unsaved'), includesAll('Stopped by an error')],
  [checkpointId('at-rest-plan-unsaved'), includesAll('Stopped by an error', 'plan.json')],
  [checkpointId('at-rest-crashed-review'), includesAll('interrupted', 'Stopped at the review')],
  [checkpointId('at-rest-crashed-apply'), includesAll('/ for a command…')],
  [
    checkpointId('at-rest-crashed-review-check'),
    (context) =>
      includesAll('Final review stopped', 'Stopped at the review')(context) &&
      excludesAll('· running')(context),
  ],
  [checkpointId('retained-workspace'), includesAll('Workspace kept')],
  [
    checkpointId('cli-stop-continued'),
    (context) => {
      const text = workflowTranscriptText();
      return (
        includesTranscript('interrupted')(context) &&
        !/Workspace kept|user-abort|\berr\b/i.test(text) &&
        !stripAnsiStyles(context.output).includes('◉ BUILD activity')
      );
    },
  ],
  [checkpointId('at-rest-waiting'), includesAll()],
  [checkpointId('at-rest-question'), includesAll('Unanswered · 2 questions', '(yes / no)')],
  [checkpointId('closed-complete'), includesAll()],
  [checkpointId('ready-to-apply'), includesAll()],
  [checkpointId('ready-crew-saved'), includesAll('PLAN GPT-5.1')],
  [checkpointId('ready-seat-moved-auto'), includesAll('PLAN GPT-5.1')],
  [
    checkpointId('at-rest-applying'),
    (context) =>
      includesAll('Applying to your checkout', '● Apply')(context) &&
      excludesAll('Ready to apply', 'Stopped at Apply', 'Pick Apply')(context),
  ],
  // A narrow byline keeps only where the queued departure goes, cut to the line.
  [
    checkpointId('at-rest-applying-home-queued'),
    (context) => includesAll('Returns home')(context) && departureStore.get()?.kind === 'home',
  ],
  [
    checkpointId('at-rest-applying-quit-queued'),
    (context) => includesAll('Quits when')(context) && departureStore.get()?.kind === 'quit',
  ],
  // A live Apply reads the same as one at rest, and Esc opens no session options over it.
  [
    checkpointId('live-applying'),
    (context) =>
      includesAll('Applying to your checkout')(context) &&
      excludesAll('esc stop options', 'Stop now', 'End run')(context),
  ],
  [
    checkpointId('live-applying-home-queued'),
    (context) =>
      includesAll('Returns home')(context) &&
      excludesAll('Session options', 'Stop now', 'End run')(context) &&
      departureStore.get()?.kind === 'home',
  ],
  // No Apply of this process holds the run, so nothing waits for it: Enter goes home at once.
  [
    checkpointId('at-rest-other-process-applying'),
    (context) =>
      includesAll('Running in another process', '● Apply', '⏎ for home…')(context) &&
      excludesAll('Applying to your checkout', 'when Apply finishes', 'Ready to apply')(context),
  ],
  [checkpointId('ready-composer-focus'), includesAll('Ready to apply')],
  [checkpointId('ready-slash-command'), includesAll('Ready to apply', '› /settings')],
  [checkpointId('ready-empty-diff'), includesAll('Ready to apply')],
  [checkpointId('ready-override'), includesAll()],
  [
    checkpointId('ready-override-confirm'),
    includesAll('Apply with 2 open findings?', '- Edge case missing src/'),
  ],
  [checkpointId('closed-applied'), includesAll()],
  [checkpointId('closed-pre-existing'), includesAll('V2 pre-existing')],
  // A finding wraps at words, so at 60x18 the earlier failed review scrolls above the viewport.
  [
    checkpointId('closed-fix-cycle'),
    (context) =>
      includesAll('Final review after 1 fix cycle', 'email field is missing.')(context) &&
      (context.viewport.cols < 80 ||
        includesAll('Review T002 failed · 1 blocking', '2 blocking')(context)),
  ],
  [checkpointId('closed-undone'), includesAll('Apply undone')],
  [checkpointId('closed-undo-conflicts'), includesAll('1 conflict kept')],
  [checkpointId('closed-discarded'), includesAll()],
  [checkpointId('closed-rejected'), includesAll()],
  [checkpointId('closed-needs-attention'), includesAll()],
  [checkpointId('closed-ended'), includesAll()],
  [checkpointId('closed-ended-empty'), includesAll()],
  [checkpointId('closed-ended-workspace'), includesAll('run.patch')],
  [checkpointId('closed-ended-review'), includesAll()],
  [checkpointId('closed-review-no-verdict'), includesAll('final review no verdict')],
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
        includesAll(
          'The plan failed 2 checks.',
          'Tasks T002 and T003 depend on each other.',
        )(context)),
  ],
  [
    checkpointId('recovery-plan-input-too-large'),
    (context) =>
      includesAll(WORKFLOW_FIXTURE_TEXT.recoveryPlan)(context) &&
      (context.viewport.cols < 80 || includesAll('A retry sends the same prompt.')(context)),
  ],
  [checkpointId('recovery-plan-questions'), includesAll('Which store keeps the greeting?')],
  [checkpointId('recovery-review'), includesAll()],
  [checkpointId('recovery-model-pick'), includesAll('Pick another REVIEW model')],
  [checkpointId('recovery-hint'), includesAll(WORKFLOW_FIXTURE_TEXT.recoveryPlan)],
  [checkpointId('recovery-plan-swapped'), includesAll()],
  [
    checkpointId('seat-switched'),
    (context) =>
      includesTranscript(
        'Recovery  Balance spent on deepseek (OpenCode CLI)',
        'automatic fallback',
      )(context) &&
      excludesAll('Add credit', 'Change BUILD tool')(context) &&
      !workflowTranscriptText().includes('BUILD failed'),
  ],
  [checkpointId('seat-switched-manual'), excludesAll('automatic fallback')],
  [
    checkpointId('seat-crew-changed'),
    (context) =>
      includesTranscript(
        'BUILD  OpenCode CLI · DeepSeek V4.1 Flash · via deepseek',
        '→ OpenCode CLI · DeepSeek V4.1 Flash · via opencode-go',
        'crew changed',
      )(context) &&
      excludesAll('automatic fallback', 'Recovery  ', 'Warning')(context) &&
      !workflowTranscriptText().includes('Stopped before') &&
      !workflowTranscriptText().includes('Run continued'),
  ],
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
          'BUILD  OpenCode CLI · DeepSeek V4.1 Flash · via deepseek',
          '→ OpenCode CLI · DeepSeek V4.1 Flash · via opencode-go',
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
    includesAll('+2 more · ctrl+a', 'Edit    test/text.test.js'),
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
  [checkpointId('many-files'), includesAll(WORKFLOW_FIXTURE_TEXT.retryExhausted)],
  [
    checkpointId('consult-bound-note'),
    includesAll('Continue with the typed correction', CONSULT_BOUND_NOTE),
  ],
  [
    checkpointId('recovery-slash-draft'),
    includesAll('⏎ runs the command · tab back to the actions', '/scroll top'),
  ],
  [checkpointId('recovery-slash-list'), includesAll('/skills', 'tab fill')],
  [checkpointId('review-failed'), includesAll(WORKFLOW_FIXTURE_TEXT.reviewFailed, 'Accept as is')],
  [checkpointId('review-fix-again'), recoveryRows(['Recovery  Fix again', 'continued'])],
  [
    checkpointId('review-unverified'),
    includesAll(WORKFLOW_FIXTURE_TEXT.reviewFailed, 'Accept as is', 'unverified criteria'),
  ],
  [
    checkpointId('task-review-no-progress'),
    includesAll('Review T904 made no progress on F1', WORKFLOW_FIXTURE_TEXT.reviewFailed),
  ],
  [
    checkpointId('recovery-checks-missing-program'),
    includesAll('mocha: command not found', 'Run the checks again'),
  ],
  [
    checkpointId('recovery-checks-unrunnable'),
    includesAll('validation.render is not set', 'Run the checks again'),
  ],
  [checkpointId('left-isolation'), includesAll(WORKFLOW_FIXTURE_TEXT.leftIsolation)],
  [checkpointId('checkout-changed'), includesAll(WORKFLOW_FIXTURE_TEXT.checkoutChanged)],
  [checkpointId('repeated-timeout'), includesAll()],
  [checkpointId('recovery-plan-timeout'), includesAll('timed out')],
  [checkpointId('at-rest-left-isolation'), includesAll()],
  [checkpointId('gates-approved'), includesAll()],
  [checkpointId('gate-stopped'), includesAll()],
  [checkpointId('api-context'), includesAll(WORKFLOW_FIXTURE_TEXT.apiContext, 'Try again')],
  [checkpointId('review-context'), includesAll('Nothing was sent to REVIEW', 'Try again')],
  [checkpointId('review-call-failed'), includesAll('Review call timed out', 'Try again')],
  [
    checkpointId('task-review-call-failed'),
    includesAll('Review T901 reached no verdict', 'Review T901 failed: ', 'Try again'),
  ],
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
  [
    checkpointId('live-seat-wait'),
    (context) =>
      includesAll('Waiting for OpenAI Codex CLI')(context) &&
      excludesAll('Between calls', 'Resuming', 'Implementing…')(context),
  ],
  [checkpointId('review-check-running'), includesAll('Review · Reviewer check V2')],
  [checkpointId('review-check-reused'), includesAll('Reviewer check V2', 'reused,')],
  [checkpointId('review-pause-requested'), includesAll('Review · Reviewer check V2')],
  [checkpointId('planning-seat-change'), includesAll('Planning…')],
  [checkpointId('plan-card-seat-change'), planCardReady],
  [checkpointId('implementation-seat-change'), includesAll(WORKFLOW_FIXTURE_TEXT.implementation)],
  [
    checkpointId('final-review-seat-change'),
    includesAll(
      '3/3 briefs passed',
      'Review · OpenAI Codex CLI',
      'OpenAI Codex CLI',
      'GPT-6-Astra',
    ),
  ],
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
  [
    checkpointId('review-base-rerun'),
    (context) =>
      includesAll('Base re-run', 'src/legacy.test.ts')(context) &&
      includesTranscript('pre-existing · src/legacy.ts(3,7)', 'src/report.ts(14,5)')(context),
  ],
  [
    checkpointId('review-base-mixed'),
    includesTranscript(
      '2\u00a0new,',
      'V1 failed',
      'new · src/a.ts(1,14)',
      'src/b.ts(4,2)',
      'pre-existing · src/legacy.ts(3,7)',
    ),
  ],
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
        '1 of your 2 failures gone',
        'left to T905',
        ...(context.viewport.cols >= 120 ? ['1 of your 2 failures remains'] : []),
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
  [
    checkpointId('review-base-rejected'),
    // The final review row settles the transcript; earlier rows scroll out of a 60x18 transcript.
    includesAll('Final review passed'),
  ],
  [checkpointId('planner-session-expired'), includesAll('Planner session expired')],
  [
    checkpointId('plan-usage-limit'),
    (context) =>
      includesTranscript()(context) &&
      workflowTranscriptText().replace(/\s+/g, ' ').split(PLAN_USAGE_LIMIT_FRAGMENT).length === 2,
  ],
  [
    checkpointId('output-limit-warning'),
    (context) => {
      if (!includesTranscript()(context)) return false;
      const text = workflowTranscriptText().replace(/\s+/g, ' ');
      const sentences = [OUTPUT_LIMIT_TOOL_CALLS_MESSAGE, OUTPUT_LIMIT_TOOL_OUTPUT_MESSAGE];
      return (
        sentences.every((sentence) => sentence.length > 0 && text.includes(sentence)) &&
        !text.includes('Recent tool calls') &&
        !text.includes('runner call')
      );
    },
  ],
] as const satisfies readonly (readonly [CheckpointId, CheckpointPredicate])[];

/** Predicates receive ANSI-free frame text from checkpointPredicate or waitForCheckpoint. */
export const workflowCheckpointPredicates: ReadonlyMap<CheckpointId, CheckpointPredicate> = new Map(
  checkpointPredicates,
);
