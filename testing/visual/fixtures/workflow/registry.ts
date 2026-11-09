import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { renderToString } from 'ink';
import { stripAnsiStyles } from '#testing/helpers/ansi.js';
import { AGY_QUOTA_LEAD } from '#testing/helpers/events/agy-quota.js';
import { SESSION_LOG_FILE, sessionDir } from '../../../../src/core/paths.js';
import { toEngineEventEntry } from '../../../../src/core/sessions/log-writer.js';
import { hydrateRun } from '../../../../src/features/workflow/run-history.js';
import { endRunAtRest } from '../../../../src/engine/orchestrator/run/close.js';
import { createRecoveryBus } from '../../../../src/engine/orchestrator/recovery/bus.js';
import { saveState } from '../../../../src/core/state/persistence.js';
import { writeEvidenceLedger } from '../../../../src/core/evidence/ledger-storage.js';
import { WORKFLOW_STATE_VERSION } from '../../../../src/core/schemas/workflow.js';
import { getWorkflowSidebarWidth } from '../../../../src/features/workflow/layout/rect.js';
import { readConversationScrollSnapshot } from '../../../../src/features/workflow/layout/snapshot.js';
import {
  getConversationRowsProjection,
  getConversationRowsWindowProjection,
} from '../../../../src/features/workflow/conversation-rows/projection-cache.js';
import { rowText } from '../../../../src/features/workflow/conversation-rows/row-format/rows.js';
import type { ConversationRow } from '../../../../src/features/workflow/conversation-rows/types.js';
import { displayActivityLabel } from '../../../../src/features/workflow/display/activity-label-display.js';
import { getSections } from '../../../../src/stores/workflow/actions/sections.js';
import { conversationScrollStore } from '../../../../src/stores/workflow/conversation-scroll.js';
import { streamingOutputStore } from '../../../../src/stores/workflow/streaming-output.js';
import type { CheckpointId } from '../../contracts/identifiers.js';
import { checkpointId } from '../../contracts/identifiers.js';
import {
  LONG_COMPOSER_DRAFT,
  VISUAL_FIXTURE_EPOCH,
  trackSlowProbe,
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
  MOVED_PROJECT_MESSAGE,
  WORKFLOW_FIXTURE_TEXT,
  workflowFixtureProjections,
  type FixtureStopState,
  type WorkflowFixtureProjection,
} from './projections.js';
import {
  OUTPUT_LIMIT_READ_FILE,
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
  if (projection.scenarioId === 'workflow-plan-card-typed-command') {
    return () => ({ ...base(), afterMount: () => composerDraftStore.request('e') });
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
    projection.scenarioId === 'workflow-consult-quota-fallback' ||
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
          expandRecovery = context.checkpoint.id.endsWith('-expanded-recovery');
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
  if (projection.scenarioId === 'workflow-recovery-empty-enter') {
    return () => ({
      ...base(),
      afterMount: async (write) => {
        await write.press('\t');
        await write.press('\r');
      },
    });
  }
  if (
    projection.scenarioId === 'workflow-ready-override-confirm' ||
    projection.scenarioId === 'workflow-ready-planner-accept-confirm' ||
    projection.scenarioId === 'workflow-ready-planner-accept-long-note' ||
    projection.scenarioId === 'workflow-ready-planner-accept-short'
  ) {
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
        : projection.scenarioId === 'workflow-at-rest-applying-quit-queued' ||
            projection.scenarioId === 'workflow-at-rest-applying-closed-quit-queued'
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
  if (
    projection.scenarioId === 'workflow-implementation-shell-wrapper' ||
    projection.scenarioId === 'workflow-implementation-tool-details'
  ) {
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
  if (projection.scenarioId === 'workflow-recovery-long-question-draft') {
    return () => ({
      ...base(),
      afterMount: async (write) => {
        await write.press('\t');
        await write.press('Read the stop from the run record and leave Projection untouched');
      },
    });
  }
  if (projection.scenarioId === 'workflow-brief-check-slow-provider') {
    return () => {
      const lifecycle = base();
      const release = Promise.withResolvers<void>();
      let held: Promise<void> | undefined;
      return {
        setup: async (context) => {
          await lifecycle.setup(context);
          held = trackSlowProbe({ provider: 'ollama', check: 'model list' }, () => release.promise);
        },
        teardown: async () => {
          release.resolve();
          await held;
          await lifecycle.teardown();
        },
      };
    };
  }
  if (
    projection.scenarioId === 'workflow-resuming' ||
    projection.scenarioId === 'workflow-resuming-apply-review-none'
  ) {
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

const REVIEW_NONE_ROW = 'Review · none · REVIEW is None, so no seat reviewed this run';

function reviewNoneRowOnce(): boolean {
  return workflowTranscriptText().replace(/\s+/g, ' ').split(REVIEW_NONE_ROW).length === 2;
}

// Every REVIEW None surface at each width: the stage wears no done mark, and no text reads as a
// review that ran or as the plan seat standing in.
const noReviewClaimed: CheckpointPredicate = (context) => {
  const [rail = ''] = context.output.split('\n');
  return (
    !rail.includes(`${glyph('stageDone')} Review`) &&
    !/= PLAN|final review|review passed/i.test(`${context.output}\n${workflowTranscriptText()}`)
  );
};

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
  [
    checkpointId('first-brief-after-plan'),
    (context) => {
      const [rail = ''] = context.output.split('\n');
      const stageLabels = ['Plan', 'Build', 'Review'].filter((label) => rail.includes(label));
      return (
        includesAll('T001', '0/3 briefs passed')(context) &&
        (stageLabels.length === 3 || (stageLabels.length === 1 && stageLabels[0] === 'Build'))
      );
    },
  ],
  [checkpointId('brief-check-slow-provider'), includesAll('Checking tools', 'T001')],
  [checkpointId('build-consult'), includesAll('Claude Code CLI', 'answering the consult on T901')],
  [
    checkpointId('build-consult-rewrite'),
    (context) =>
      includesTranscript('rewrote T901 (rev 2)')(context) &&
      excludesAll('passed · attempt', 'failed · attempt')(context),
  ],
  [
    checkpointId('build-consult-split'),
    (context) =>
      includesTranscript('split into T904, T905')(context) &&
      excludesAll('passed · attempt', 'failed · attempt')(context),
  ],
  [checkpointId('build-brief-check'), includesAll('T901 check K2', 'read after its checks')],
  [checkpointId('build-brief-check-own-id'), includesAll('Check T901-K2', 'read after its checks')],
  [
    checkpointId('build-brief-check-base-wait'),
    (context) => includesAll()(context) && excludesAll('briefs passed · Base re-run V2')(context),
  ],
  [
    checkpointId('build-base-rerun'),
    includesAll(WORKFLOW_FIXTURE_TEXT.implementation, '0/3 briefs passed'),
  ],
  [
    checkpointId('base-rerun-long-command'),
    () => {
      const rows = workflowTranscriptText()
        .split('\n')
        .map((row) => row.replaceAll('\u00a0', ' '));
      return rows.some(
        (row) => row.includes('Base re-run V5') && row.endsWith('passes at the run base · 1m 34s'),
      );
    },
  ],
  [
    checkpointId('check-timed-out'),
    () => {
      const rows = workflowTranscriptText()
        .split('\n')
        .map((row) => row.replaceAll('\u00a0', ' ').trim());
      const matches = rows.filter(
        (row) => row === 'Fix check V1 · npm run release-check · timed out · 1h 0m 0s',
      );
      return matches.length === 1;
    },
  ],
  [checkpointId('build-brief-check-seat-change'), includesAll('T901 check K2')],
  [checkpointId('implementation-shell-seat'), includesAll('Custom Shell')],
  [
    checkpointId('implementation-shell-seat-resolved'),
    (context) =>
      includesAll(
        'Custom Shell',
        ...(getWorkflowSidebarWidth({
          cols: context.viewport.cols,
          sidebarVisible: true,
        }) > 0
          ? ['claude-sonnet-5-5']
          : []),
      )(context),
  ],
  [
    checkpointId('build-fix-consult'),
    includesAll('PLAN → T904', 'Claude Code CLI', 'answering the consult on T904'),
  ],
  // The build-progress block is the fact the implementation checkpoint must carry at every width;
  // the task header scrolls out of a 60x18 transcript, so pinning it would pin the viewport too.
  [
    checkpointId('implementation'),
    includesAll(WORKFLOW_FIXTURE_TEXT.implementation, 'briefs passed'),
  ],
  [
    checkpointId('crew-wide-review-none'),
    (context) =>
      includesAll(WORKFLOW_FIXTURE_TEXT.implementation, 'briefs passed', 'REVIEW None')(context) &&
      noReviewClaimed(context),
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
  // `Checking tests` scrolls out of a 60x18 transcript, so the frame pins the activity block,
  // and the transcript text proves that the main word ends whole above that block.
  [
    checkpointId('implementation-subagent-text'),
    (context) => {
      const text = workflowTranscriptText();
      return (
        includesAll('Found 3.', 'Done.')(context) &&
        excludesAll('testFound', 'sDone', 'sFound')(context) &&
        /BUILD activity[\s\S]*Found 3\.[\s\S]*Done\./.test(stripAnsiStyles(context.output)) &&
        /Checking tests[\s\S]*BUILD activity[\s\S]*Found 3\.[\s\S]*Done\./.test(text) &&
        !text.includes('testFound') &&
        !text.includes('sDone') &&
        !text.includes('sFound')
      );
    },
  ],
  [checkpointId('implementation-command-code'), includesTranscript('src/app.ts', 'npm test')],
  [checkpointId('implementation-adjacent-narration'), implementerMarkdown('src/fixture.ts')],
  [checkpointId('implementation-fenced-handback'), implementerMarkdown('src/row.ts')],
  [
    checkpointId('implementation-handback-unclosed-quote'),
    (context) =>
      implementerMarkdown('src/row.ts')(context) &&
      includesAll('Report  done · 1 decision')(context) &&
      excludesAll('"status":"done"', 'REDACTED')(context),
  ],
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
  [
    checkpointId('implementation-retry'),
    (context) =>
      includesAll('Retry  attempt 7', 'briefs passed')(context) &&
      excludesAll('passed · attempt', 'failed · attempt')(context),
  ],
  [checkpointId('implementation-after-retry'), includesAll()],
  [checkpointId('recovery-resolved-retry'), includesAll()],
  [checkpointId('recovery-resolved-skip'), recoveryRows(['Recovery  Skip task', 'skipped'])],
  [
    checkpointId('recovery-resolved-dependency-skip'),
    recoveryRows(['Recovery  Skip task', 'skipped'], ['Recovery  Dependency blocked']),
  ],
  [
    checkpointId('recovery-resolved-apply-retry'),
    // The old check waited for Run continued; the Recovery row now says the run went on.
    (context) =>
      recoveryRows(['Recovery  Re-run Apply', 'continued'])(context) &&
      excludesAll('Run continued')(context) &&
      !workflowTranscriptText().includes('Run continued'),
  ],
  [checkpointId('review-fix'), includesAll()],
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
  [checkpointId('review-stuck-planner'), includesTranscript('review stuck after T904')],
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
    includesTranscript(
      'Final review after 1 fix cycle passed',
      'Final review after 1 fix cycle, re-run',
    ),
  ],
  [
    checkpointId('complete-after-fix-tasks'),
    (context) => {
      const [rail = ''] = context.output.split('\n');
      const stageMarks = rail.split(glyph('stageDone')).length - 1;
      return (
        includesAll()(context) &&
        (stageMarks === 3 || (stageMarks === 1 && rail.includes('Review'))) &&
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
    (context) =>
      includesTranscript(
        "verified · kept the interrupted attempt's work",
        'further change',
      )(context) && /Report {2}done$/m.test(workflowTranscriptText()),
  ],
  [checkpointId('final-review'), includesAll('3/3 briefs passed', 'Review · OpenAI Codex CLI')],
  [
    checkpointId('final-review-findings'),
    includesTranscript('Blocking F1', 'Blocking F2', 'Set aside V6.1'),
  ],
  [
    checkpointId('final-review-plan-check'),
    includesAll('Final review', 'Review · OpenAI Codex CLI'),
  ],
  [
    checkpointId('final-review-plan-check-running'),
    includesAll(
      'Review · Plan check K1 · npm test',
      'running 0:12',
      'Plan check K1 · npm test 0:12',
    ),
  ],
  [
    checkpointId('review-answering-again'),
    (context) =>
      includesAll('answering again')(context) && excludesAll('did not match its contract')(context),
  ],
  [
    checkpointId('review-verify'),
    includesAll('Verify K1', 'Review · Verify K2 · npm test', 'running 0:12'),
  ],
  [checkpointId('review-verify-pre-existing'), includesAll('Verify V1', 'Verify V2')],
  [
    checkpointId('review-verify-rerun'),
    (context) =>
      includesTranscript('✗ Final review failed', 'Final review re-run passed')(context) &&
      excludesAll('fix cycle')(context),
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
      'attempt 2',
      'fixes T003',
    ),
  ],
  [checkpointId('review-task-out-of-scope'), includesAll('Review T001 passed', '3 notes')],
  [checkpointId('review-settled-passed'), includesTranscript('● Final review passed', '7.0s')],
  [
    checkpointId('review-settled-set-aside'),
    includesTranscript('Set aside V2.1', 'Transient 60 s'),
  ],
  [checkpointId('review-settled-failed'), includesTranscript('✗ Final review failed', '7.0s')],
  [
    checkpointId('review-settled-unverified'),
    includesTranscript('✗ Final review failed  4 unverified criteria'),
  ],
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
  [
    checkpointId('review-none-end'),
    (context) =>
      includesAll('REVIEW None')(context) && reviewNoneRowOnce() && noReviewClaimed(context),
  ],
  [
    checkpointId('apply-recheck-review-none'),
    (context) =>
      includesAll('3/3 briefs passed', '/ for a command…')(context) &&
      reviewNoneRowOnce() &&
      noReviewClaimed(context) &&
      excludesAll('reviewing changes')(context),
  ],
  [checkpointId('implementation-escalated'), includesAll('briefs passed')],
  [checkpointId('review-fix-narrow-rail'), includesAll('T006')],
  [checkpointId('review-fix-narrow-rail-stop'), includesAll()],
  [checkpointId('task-statuses'), includesAll('escalated', 'failed', 'skipped')],
  [checkpointId('validation'), includesAll('Validate', 'test skipped')],
  [checkpointId('planner-commands-refused'), includesAll('Validation')],
  [checkpointId('touched-not-suggested'), includesAll('also changed')],
  [
    checkpointId('between-briefs'),
    includesAll('1/3 briefs passed', 'Message BUILD on T902', 'read when its call starts'),
  ],
  [checkpointId('plan-check-refused'), includesAll('T901 check K2', 'refused')],
  [checkpointId('plan-check-not-run'), includesAll('T901 check K4 · not')],
  [checkpointId('plan-check-missing-program'), includesAll('T901 check K4 · npm test', 'mocha')],
  [checkpointId('plan-check-no-test-file'), includesAll('T901 check K4 · failed', 'loud.test.mjs')],
  [
    checkpointId('plan-check-pre-existing'),
    includesTranscript('T901 check K1', 'src/legacy/report.test.ts'),
  ],
  [
    checkpointId('completed-orphan-rows'),
    includesTranscript(
      '● T901',
      'could not be read',
      'also changed',
      'T902 Register the bounded fixture projection',
    ),
  ],
  [
    checkpointId('task-rows-context-fit'),
    includesTranscript('~24,310 of 32K context tokens (tight)'),
  ],
  // The tiered gate owns this checkpoint: it takes the prompt zone from the document panel, so the
  // panel's own words are never on this frame.
  [checkpointId('review'), includesAll('Confirm with a reason', WORKFLOW_FIXTURE_TEXT.review)],
  // The activity row renders the user-facing activity label via displayActivityLabel('AGENT') rather than the internal label,
  // showing the spawn_agent marker while keeping internal tool names and check findings hidden.
  [
    checkpointId('review-subagent-row'),
    (context) => {
      const text = workflowTranscriptText();
      return (
        includesAll(displayActivityLabel('AGENT'), 'spawn_agent')(context) &&
        excludesAll('collab_tool_call', 'F1')(context) &&
        !text.includes('collab_tool_call') &&
        !text.includes('F1')
      );
    },
  ],
  // The document loads from disk after the panel paints, so each gate waits on the first row of
  // its own document too — otherwise the frame captures a gate over an empty box.
  [checkpointId('selection-copy'), includesAll('End run', 'Edit plan.json')],
  [checkpointId('approval-confirm'), includesAll('Confirm with a reason')],
  [checkpointId('approval-confirm-secret'), includesAll('Confirm with a reason')],
  [checkpointId('approval-confirm-short'), includesAll('Confirm')],
  [checkpointId('approval-confirm-long-path'), includesAll('src/features/workflow')],
  [checkpointId('plan-card-short'), includesAll('Approve plan')],
  [checkpointId('question-short'), includesAll('Reviewer/planner seat')],
  [checkpointId('planner-question-short'), includesAll('Reviewer/planner seat')],
  [
    checkpointId('planner-question-free-short'),
    includesAll('Which file or module do you want refactored?'),
  ],
  [checkpointId('recovery-short'), includesAll('Try again')],
  [checkpointId('plan-card'), planCardReady],
  [
    checkpointId('plan-card-commenting'),
    (context) =>
      planCardReady(context) && includesAll(PLAN_CARD_COMMENT_DRAFT, REVIEW_COMMENT_HINTS)(context),
  ],
  [checkpointId('plan-card-typed-command'), includesAll('Edit plan.json', '⏎ confirm · esc back')],
  [
    checkpointId('plan-card-request-empty'),
    (context) => planCardReady(context) && includesAll(REVIEW_COMMENT_HINTS)(context),
  ],
  [
    checkpointId('plan-repaired'),
    (context) => includesAll()(context) && excludesAll('Warning', 'The plan failed')(context),
  ],
  [checkpointId('plan-card-render-note'), planCardReady],
  // Below 24 rows the plan panel holds one row of the document, so the note sits under the fold.
  [
    checkpointId('plan-card-review-none'),
    (context) =>
      planCardReady(context) &&
      includesAll('REVIEW None')(context) &&
      noReviewClaimed(context) &&
      (context.viewport.rows < 24 ||
        context.output.includes('K-suite, K-render do not run: REVIEW is None')),
  ],
  [checkpointId('plan-card-no-image-reviewer'), planCardReady],
  [checkpointId('plan-card-shared-command'), planCardReady],
  [checkpointId('plan-card-session-path'), planCardReady],
  [
    checkpointId('plan-card-edited'),
    (context) => {
      if (!planCardReady(context)) return false;
      if (!stripAnsiStyles(context.output).includes('Plan 0/2')) return false;
      const rows = workflowTranscriptText()
        .split('\n')
        .map((row) => row.trimEnd());
      return (
        rows.filter((row) => row === 'Plan').length === 1 &&
        rows.filter((row) => row === 'Tasks').length === 1
      );
    },
  ],
  // The two briefs whose long headers the card once skipped, beside the first and the last.
  [checkpointId('tasks-card'), includesAll('T001', 'T004', 'T006', 'T007')],
  // The subsections the spec card does not nest, and the briefs after T001's unclosed sample.
  [checkpointId('question'), includesAll(WORKFLOW_FIXTURE_TEXT.question)],
  [checkpointId('question-overflow'), includesAll('Question 2 of 3')],
  [checkpointId('question-default'), includesAll('Question 1 of 1', 'Write your own answer…')],
  [checkpointId('question-input'), includesAll('Question 1 of 2', 'Review the current diff')],
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
  [checkpointId('consult-answer-default'), includesAll('Which store?', 'You → memory')],
  [
    checkpointId('consult-guard-question'),
    (context) =>
      includesAll('adds C4')(context) && excludesAll('rewrote T901', 'Dropped criteria')(context),
  ],
  [checkpointId('consult-answer-typed'), includesAll('Which store?', 'You → redis')],
  [
    checkpointId('paused-mid-brief'),
    includesAll('⏎ resume', 'Stopped at T', 'Partial changes kept'),
  ],
  [checkpointId('paused-cut-seat'), includesAll('⏎ resume', 'Stopped at T')],
  [checkpointId('paused-boundary'), includesAll('briefs complete', 'before T902')],
  [checkpointId('stopping'), includesAll('esc back after stop')],
  [checkpointId('stopping-review'), includesAll('Stopping the review')],
  // A run at rest carries its own name: the marker is the session the record names, which the
  // closed block states in full and the open byline carries. Nothing else is width-stable — the
  // byline sheds its reason and then its alternative as the terminal narrows.
  [checkpointId('at-rest-paused'), includesAll()],
  [checkpointId('at-rest-queued'), includesAll('Stopped at T003', '1 queued')],
  [checkpointId('at-rest-halted'), includesAll()],
  [checkpointId('at-rest-seat-wait'), includesAll()],
  [
    checkpointId('at-rest-seat-wait-elsewhere'),
    (context) => includesAll()(context) && excludesAll('Running in another process')(context),
  ],
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
    (context) => {
      if (!includesAll('This halt takes no typed correction', TYPED_WORDS)(context)) return false;
      if (context.viewport.cols > 80) return true;
      const headerRow = context.output.split('\n')[0] ?? '';
      return (
        headerRow.includes(`${glyph('statusFailed')} Apply`) &&
        headerRow.includes('PLAN claude · BUILD claude · REVIEW = PLAN')
      );
    },
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
    checkpointId('resuming-apply-review-none'),
    (context) => {
      const [rail = ''] = context.output.split('\n');
      return (
        includesAll()(context) &&
        (!rail.includes('Review') || rail.includes(`${glyph('stagePending')} Review`))
      );
    },
  ],
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
  [
    checkpointId('retained-workspace'),
    // The halt's panel takes the short screens, so the notice above it is read from the transcript.
    (context) =>
      includesTranscript('Workspace kept at', 'Recovery  T001 failed')(context) &&
      context.output.includes('Needs you'),
  ],
  [
    checkpointId('moved-project-run'),
    // The run's error row is the one row that names the moved folder: no kept-workspace warning.
    (context) => {
      const text = workflowTranscriptText().replace(/\s+/g, ' ');
      return (
        includesTranscript()(context) &&
        text.split(MOVED_PROJECT_MESSAGE).length === 2 &&
        !['Warning', 'Workspace kept', 'could not be verified'].some((marker) =>
          text.includes(marker),
        )
      );
    },
  ],
  [
    checkpointId('cli-stop-continued'),
    (context) => {
      const text = workflowTranscriptText();
      const frame = stripAnsiStyles(context.output);
      return (
        includesTranscript('interrupted')(context) &&
        frame.includes('Implementing… 0:16') &&
        !/Workspace kept|user-abort|\berr\b/i.test(text) &&
        !frame.includes('◉ BUILD activity')
      );
    },
  ],
  [checkpointId('at-rest-waiting'), includesAll()],
  [checkpointId('at-rest-question'), includesAll('Unanswered · 2 questions', '(yes / no)')],
  [checkpointId('closed-complete'), includesAll()],
  // The ledger pins its tail: below 40 rows the outcome row scrolls above the Run block.
  [
    checkpointId('closed-complete-review-none'),
    (context) =>
      includesAll('REVIEW None', 'no review')(context) &&
      (context.viewport.rows < 40 || context.output.includes('Complete')) &&
      noReviewClaimed(context),
  ],
  [checkpointId('ready-to-apply'), includesAll()],
  // The four-stage rail leaves one seat room in the header at 60 columns.
  [
    checkpointId('ready-to-apply-review-none'),
    (context) =>
      includesAll()(context) &&
      (context.viewport.cols < 80 || context.output.includes('REVIEW None')) &&
      reviewNoneRowOnce() &&
      noReviewClaimed(context) &&
      excludesAll('as is')(context),
  ],
  [
    checkpointId('ready-crew-saved'),
    (context) => {
      if (!context.output.includes(context.checkpoint.marker)) return false;
      if (context.viewport.cols !== 80) return context.output.includes('PLAN GPT-5.1');
      const headerRow = context.output.split('\n')[0] ?? '';
      return headerRow.includes('PLAN custom-endpoint · BUILD custom-endpoint · REVIEW codex');
    },
  ],
  [
    checkpointId('ready-seat-moved-auto'),
    (context) => {
      if (!context.output.includes(context.checkpoint.marker)) return false;
      const headerRow = context.output.split('\n')[0] ?? '';
      if (context.viewport.cols === 120) {
        return (
          headerRow.includes('○ Apply') &&
          headerRow.includes(
            'PLAN custom-endpoint · BUILD Gemini 3.8 Flash → Google Antigravity CLI · REVIEW custom-endpoint',
          )
        );
      }
      return (
        context.output.includes('PLAN GPT-5.1') &&
        (context.viewport.cols !== 160 ||
          headerRow.includes('BUILD Gemini 3.8 Flash → Google Antigravity CLI'))
      );
    },
  ],
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
  // Apply saved the run closed and still removes its workspace: the composer follows the record.
  [
    checkpointId('at-rest-applying-closed'),
    (context) =>
      includesAll('⏎ for home…')(context) &&
      excludesAll('when Apply finishes', 'Applying to your checkout')(context) &&
      activeApply() !== undefined,
  ],
  // A queued quit leaves no way home, so the composer promises none.
  [
    checkpointId('at-rest-applying-closed-quit-queued'),
    (context) =>
      includesAll('/ for a command…', 'Quits when')(context) &&
      excludesAll('for home', 'esc home')(context) &&
      activeApply() !== undefined &&
      departureStore.get()?.kind === 'quit',
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
  // The log names when the other process's Apply began, so its clock counts from there.
  [
    checkpointId('at-rest-other-process-applying-clock'),
    (context) =>
      includesAll('Applying to your checkout · 0:06', '● Apply', '⏎ for home…')(context) &&
      excludesAll('Running in another process', 'when Apply finishes', 'Ready to apply')(context),
  ],
  [checkpointId('ready-composer-focus'), includesAll('Ready to apply')],
  [checkpointId('ready-slash-command'), includesAll('Ready to apply', '› /settings')],
  [checkpointId('ready-empty-diff'), includesAll('Ready to apply')],
  [checkpointId('ready-override'), includesAll()],
  [
    checkpointId('ready-override-confirm'),
    includesAll('Apply with 2 open findings?', '- Edge case missing src/'),
  ],
  [
    checkpointId('ready-planner-accept-confirm'),
    includesAll('Apply with 2 open findings?', "Planner's note:"),
  ],
  [
    checkpointId('ready-planner-accept-long-note'),
    includesAll('Apply with 2 open findings?', "Planner's note:", 'Apply as is'),
  ],
  [checkpointId('ready-planner-accept-short'), includesAll('Apply as is')],
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
  [checkpointId('closed-set-aside'), includesAll('Set aside V1: npm run lint fails')],
  [checkpointId('closed-undone'), includesAll('Apply undone')],
  [checkpointId('closed-undo-conflicts'), includesAll('1 conflict kept')],
  [checkpointId('closed-discarded'), includesAll()],
  [checkpointId('closed-rejected'), includesAll()],
  [checkpointId('closed-needs-attention'), includesAll()],
  [checkpointId('closed-planner-accept'), includesAll('Accepted as is', "Planner's note:")],
  // The skipped brief's row scrolls above the viewport below 120 columns.
  [
    checkpointId('closed-decided-skip'),
    (context) =>
      includesAll()(context) &&
      (context.viewport.cols < 120 ||
        includesAll('skipped · Planner said:', '2/3 briefs validated', '2 files changed')(context)),
  ],
  [checkpointId('closed-ended'), includesAll()],
  [checkpointId('closed-ended-empty'), includesAll()],
  [checkpointId('closed-ended-workspace'), includesAll('run.patch')],
  // The closed-run ledger renders run.patch in the visible frame outside event rows, while the
  // transcript retains the foreign-workspace notice.
  [
    checkpointId('closed-ended-moved-workspace'),
    (context) => {
      const text = workflowTranscriptText().replace(/\s+/g, ' ');
      return (
        context.output.includes('run.patch') && text.includes('belongs to another project folder')
      );
    },
  ],
  [checkpointId('closed-ended-review'), includesAll()],
  [checkpointId('closed-review-no-verdict'), includesAll('final review no verdict')],
  [checkpointId('closed-ended-review-workspace'), includesAll('run.patch')],
  [checkpointId('closed-seat-moved'), includesAll()],
  [checkpointId('closed-mixed-workers'), includesAll('visual-closed-mixed-workers')],
  [checkpointId('replayed'), includesAll()],
  [checkpointId('failure'), includesAll(WORKFLOW_FIXTURE_TEXT.failure, 'Build failed')],
  [checkpointId('recovery'), includesAll(WORKFLOW_FIXTURE_TEXT.recovery)],
  [
    checkpointId('recovery-empty-enter'),
    includesAll('Change BUILD tool', 'Nothing to send. Tab to choose an action.'),
  ],
  [checkpointId('recovery-no-fallback'), includesAll(WORKFLOW_FIXTURE_TEXT.recovery)],
  [checkpointId('recovery-fallback-used'), includesAll(WORKFLOW_FIXTURE_TEXT.recovery)],
  [checkpointId('recovery-fallback-not-installed'), includesAll(WORKFLOW_FIXTURE_TEXT.recovery)],
  [
    checkpointId('recovery-plan'),
    (context) =>
      includesAll(WORKFLOW_FIXTURE_TEXT.recoveryPlan)(context) &&
      (context.viewport.cols < 160 || includesAll('No tasks yet')(context)),
  ],
  [
    checkpointId('recovery-plan-checks'),
    (context) =>
      includesAll('Criterion C2 is served by no task.')(context) &&
      (context.viewport.cols < 80 ||
        includesAll('Tasks T002 and T003 depend on each other.')(context)),
  ],
  [
    checkpointId('recovery-plan-input-too-large'),
    (context) =>
      includesAll(WORKFLOW_FIXTURE_TEXT.recoveryPlan)(context) &&
      (context.viewport.cols < 80 || includesAll('A retry sends the same prompt.')(context)),
  ],
  [
    checkpointId('recovery-plan-output-limit'),
    (context) => {
      const visible = context.output;
      const normalizedVisible = visible.replace(/\s+/g, ' ');
      const hasVisible = (text: string) =>
        visible.includes(text) || normalizedVisible.includes(text);
      if (
        !hasVisible('Planning failed') ||
        !hasVisible('Change PLAN tool') ||
        !hasVisible('Try again')
      ) {
        return false;
      }
      if (context.viewport.cols >= 80 && !hasVisible('A retry can run as long')) {
        return false;
      }
      if (context.viewport.cols >= 120 && !hasVisible(context.checkpoint.marker)) {
        return false;
      }
      const transcript = workflowTranscriptText().replace(/\s+/g, ' ');
      return transcript.includes(context.checkpoint.marker);
    },
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
  [
    checkpointId('seat-review-no-image'),
    (context) =>
      includesTranscript(
        'REVIEW  Claude Code CLI · Claude Sonnet 4',
        'crew changed',
        'cannot see images',
      )(context) && excludesAll('Warning')(context),
  ],
  [checkpointId('seat-switched-balance'), includesAll()],
  [
    checkpointId('seat-switched-expanded-recovery'),
    includesTranscript('provider.quota: Insufficient Balance', 'ctrl+d to collapse'),
  ],
  [
    checkpointId('consult-quota-fallback'),
    (context) => {
      const text = workflowTranscriptText().replace(/\s+/g, ' ');
      return (
        includesTranscript()(context) &&
        text.includes('continued on fallback') &&
        !text.includes(AGY_QUOTA_LEAD)
      );
    },
  ],
  [
    checkpointId('consult-quota-fallback-expanded-recovery'),
    (context) =>
      includesTranscript()(context) &&
      workflowTranscriptText().replace(/\s+/g, ' ').includes(AGY_QUOTA_LEAD),
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
    includesAll('+2 earlier · ctrl+a', 'Edit    test/text.test.js'),
  ],
  [checkpointId('spent-b2-replay-t001-completion'), includesAll()],
  [
    checkpointId('spent-b2-replay-t002-activity'),
    includesAll('+1 earlier · ctrl+a', 'Edit    test/preview.test.js'),
  ],
  [checkpointId('spent-b2-replay-t002-completion'), includesAll()],
  [checkpointId('plan-activity'), includesAll('src/core/crew/identity.ts')],
  [checkpointId('retry-exhausted'), includesAll(WORKFLOW_FIXTURE_TEXT.retryExhausted)],
  [checkpointId('unanswered-question'), includesAll('T901 needs your answer')],
  [checkpointId('long-question'), includesAll('T901 needs your answer', 'Question: Projection')],
  [
    checkpointId('long-question-draft'),
    includesAll('T901 needs your answer', 'Question: Projection', 'untouched'),
  ],
  [
    checkpointId('masked-question'),
    includesAll('T901 needs your answer', 'Question: Deploy needs Authorization: Bearer'),
  ],
  [checkpointId('open-quote'), includesAll('T901 needs your answer', 'Question: The docs say')],
  [
    checkpointId('open-quote-title'),
    includesAll('T901 needs your answer', 'Question: Should activity.ts'),
  ],
  [checkpointId('cannot'), includesAll('T901: the planner says it cannot be done')],
  [checkpointId('many-files'), includesAll(WORKFLOW_FIXTURE_TEXT.retryExhausted)],
  [
    checkpointId('recovery-slash-draft'),
    includesAll('⏎ runs the command · tab back to the actions', '/scroll top'),
  ],
  [checkpointId('recovery-slash-list'), includesAll('/skills', 'tab fill')],
  [checkpointId('review-failed'), includesAll(WORKFLOW_FIXTURE_TEXT.reviewFailed, 'Accept as is')],
  [checkpointId('review-fix-again'), recoveryRows(['Recovery  Review again', 'continued'])],
  [
    checkpointId('review-unverified'),
    includesAll(
      WORKFLOW_FIXTURE_TEXT.reviewFailed,
      'Accept as is',
      'Decide for me',
      'Planner said:',
      'Unverified criteria: C1, C2, C3, C4, C5, C6',
    ),
  ],
  [checkpointId('review-no-image'), includesAll('needs a REVIEW seat', 'Accept as is')],
  [
    checkpointId('review-question'),
    includesAll(WORKFLOW_FIXTURE_TEXT.reviewFailed, 'Decide for me'),
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
  [
    checkpointId('review-failed-review-none'),
    (context) =>
      includesAll('Continue')(context) && excludesAll(WORKFLOW_FIXTURE_TEXT.reviewFailed)(context),
  ],
  [
    checkpointId('recovery-review-none-in-place'),
    (context) =>
      includesAll('validation.render is not set', 'Run the checks again')(context) &&
      excludesAll('✗ Apply', '● Apply', '○ Apply')(context),
  ],
  [
    checkpointId('left-isolation'),
    (context) =>
      includesAll(WORKFLOW_FIXTURE_TEXT.leftIsolation)(context) &&
      (context.viewport.cols !== 80 && context.viewport.cols !== 60
        ? true
        : context.output.includes('PLAN claude · BUILD agy · REVIEW = PLAN')) &&
      (context.scenario.id !== 'workflow-recovery-left-isolation-in-place' ||
        context.viewport.cols !== 60 ||
        context.output.includes('… 7 more lines')),
  ],
  [checkpointId('checkout-changed'), includesAll(WORKFLOW_FIXTURE_TEXT.checkoutChanged)],
  [checkpointId('repeated-timeout'), includesAll()],
  [checkpointId('runner-check-failed'), includesAll()],
  [checkpointId('runner-check-failed-drift'), includesAll()],
  [checkpointId('recovery-plan-timeout'), includesAll('timed out')],
  [checkpointId('recovery-plan-runner-check-failed'), includesAll()],
  [checkpointId('recovery-review-runner-check-failed-drift'), includesAll()],
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
    checkpointId('implementation-streamed-targets'),
    includesAll('src/engine/calls/activity-memory.ts', 'Explore'),
  ],
  [
    checkpointId('implementation-shell-wrapper'),
    includesAll('src/loans/renewals.ts', 'renewal window', 'overdue'),
  ],
  [
    checkpointId('implementation-tool-details'),
    includesAll(
      'renewals.ts :120-159',
      'biome.json :70-end',
      'Count the action flags',
      '+2 lines',
      'collapse · ctrl+a',
    ),
  ],
  [
    checkpointId('implementation-search-folders'),
    includesAll('renewalWindow · src/loans · *.ts', 'renewalWindow · src/loans/rules'),
  ],
  [checkpointId('implementation-silent-bare'), includesAll('Implementing…', 'No output for')],
  [
    checkpointId('live-seat-wait'),
    (context) =>
      includesAll('Waiting for OpenAI Codex CLI')(context) &&
      excludesAll('Between calls', 'Resuming', 'Implementing…')(context),
  ],
  [checkpointId('planning-seat-wait'), includesAll('Waiting for Claude Code')],
  [checkpointId('final-review-seat-wait'), includesAll('Waiting for OpenAI Codex CLI')],
  [checkpointId('planning-seat-retry'), includesAll('Network or server failure', 'retry 1 of 10')],
  [
    checkpointId('build-seat-retry'),
    (context) =>
      includesAll('retry 2 of 10')(context) &&
      excludesAll('BUILD failed', 'BUILD  failed')(context),
  ],
  [
    checkpointId('final-review-seat-retry'),
    includesAll('Network or server failure', 'retry 1 of 10', 'Review input trimmed'),
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
  [checkpointId('fix-check-off'), includesAll('Fix check V2 · off')],
  [
    checkpointId('fix-check-red-then-verify'),
    // The red row scrolls out of a small frame, so the rows are read from the whole transcript.
    (context) => {
      const text = workflowTranscriptText();
      return (
        includesTranscript('Render greet-card · failed')(context) &&
        text.split('\n').filter((row) => row.includes('verify T901-K1, T901-R1')).length === 1 &&
        !text.includes("misses the task's criteria checks")
      );
    },
  ],
  [
    checkpointId('attempt-reverted'),
    // SPLITBRIEF's own neutral row below the git change halt row, not a warning; a worktree
    // attempt saves no replaced files. In a frame under 40 rows, the halt panel leaves no room
    // for the row. The halt row is read with its Error heading: without that row, a Recovery
    // card shows the same headline.
    (context) => {
      const row = 'SPLITBRIEFT901attemptreverted:2files';
      if (context.viewport.rows >= 40 && !context.output.replace(/\s/g, '').includes(row)) {
        return false;
      }
      const text = workflowTranscriptText().replace(/\s/g, '');
      const halt = text.indexOf('ErrorRepositorychangedunderT901·tagv2.0.0');
      return (
        includesTranscript()(context) &&
        halt >= 0 &&
        halt < text.indexOf(row) &&
        !/Warning|replacedfiles/.test(text)
      );
    },
  ],
  [
    checkpointId('attempt-reverted-checkout'),
    // The saved path wraps, and the 60x40 frame shows it break inside itself. In a frame under
    // 40 rows, the halt panel leaves no room for the row. The 60x18 panel folds its facts, and
    // the fold names the saved folder it hides.
    (context) => {
      const row =
        'SPLITBRIEFT901attemptreverted:2files.Thereplacedfilesaresavedin.splitbrief/sessions/visual-workflow/reverted/';
      if (context.viewport.rows >= 40 && !context.output.replace(/\s/g, '').includes(row)) {
        return false;
      }
      if (
        context.viewport.rows === 18 &&
        !context.output.includes('… saved folder and 2 more lines')
      ) {
        return false;
      }
      const text = workflowTranscriptText().replace(/\s/g, '');
      const halt = text.indexOf('ErrorRepositorychangedunderT901·tagv2.0.0');
      return (
        includesTranscript()(context) &&
        halt >= 0 &&
        halt < text.indexOf(row) &&
        !text.includes('Warning')
      );
    },
  ],
  [
    checkpointId('review-base-not-verified'),
    // The reason wraps at narrow widths and the base rows of the build scroll out of a 60x18
    // transcript; the last row settles it.
    (context) =>
      includesAll('npm test · not\u00a0run', 'both runs timed out')(context) &&
      includesTranscript('Base re-run V1 · npm run e2e')(context),
  ],
  [
    checkpointId('review-base-rejected'),
    // The final review row settles the transcript; earlier rows scroll out of a 60x18 transcript.
    (context) =>
      context.output.includes('Final review passed') &&
      includesTranscript('Base re-run V1 · npm run e2e')(context),
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
      return (
        text.includes(OUTPUT_LIMIT_READ_FILE) &&
        !text.includes(OUTPUT_LIMIT_TOOL_OUTPUT_MESSAGE) &&
        !text.includes('tool calls of this call are kept') &&
        !text.includes('runner call')
      );
    },
  ],
] as const satisfies readonly (readonly [CheckpointId, CheckpointPredicate])[];

/** Predicates receive ANSI-free frame text from checkpointPredicate or waitForCheckpoint. */
export const workflowCheckpointPredicates: ReadonlyMap<CheckpointId, CheckpointPredicate> = new Map(
  checkpointPredicates,
);
