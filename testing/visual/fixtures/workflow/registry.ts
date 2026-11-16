import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { renderToString } from 'ink';
import { stripAnsiStyles } from '#testing/helpers/ansi.js';
import { AGY_QUOTA_LEAD } from '#testing/helpers/events/agy-quota.js';
import { flushEffects } from '#testing/helpers/ink.js';
import { SESSION_LOG_FILE, sessionDir } from '../../../../src/core/paths.js';
import { toEngineEventEntry } from '../../../../src/core/sessions/log/writer.js';
import { hydrateRun } from '../../../../src/features/workflow/run-history.js';
import { endRunAtRest } from '../../../../src/engine/orchestrator/run/end.js';
import { createRecoveryBus } from '../../../../src/engine/orchestrator/recovery/bus.js';
import { saveState } from '../../../../src/core/state/persistence.js';
import { writeEvidenceLedger } from '../../../../src/core/evidence/ledger-storage.js';
import { WORKFLOW_STATE_VERSION } from '../../../../src/core/schemas/workflow/state.js';
import { getWorkflowSidebarWidth } from '../../../../src/features/workflow/layout/rect.js';
import {
  RAIL_SHORT_LABEL,
  railConnectorString,
} from '../../../../src/features/workflow/layout/chrome-rows.js';
import { readConversationScrollSnapshot } from '../../../../src/features/workflow/layout/snapshot.js';
import {
  getConversationRowsProjection,
  getConversationRowsWindowProjection,
} from '../../../../src/features/workflow/conversation-rows/cache/projection.js';
import { rowText } from '../../../../src/features/workflow/conversation-rows/row-format/rows.js';
import type { ConversationRow } from '../../../../src/features/workflow/conversation-rows/types.js';
import { displayActivityLabel } from '../../../../src/features/workflow/conversation-rows/activity/rows.js';
import { getSections } from '../../../../src/stores/workflow/actions/sections.js';
import { conversationScrollStore } from '../../../../src/stores/workflow/conversation-scroll.js';
import { streamingOutputStore } from '../../../../src/stores/workflow/streaming-output.js';
import type { CheckpointId, ScenarioId } from '../../contracts/identifiers.js';
import { checkpointId } from '../../contracts/identifiers.js';
import { NO_CORRECTION_MESSAGE } from '../../../../src/features/workflow/recovery/actions.js';
import { requestSteer } from '../../../../src/features/workflow/run-requests/stop-resume.js';
import { noWordsRefusal } from '../../../../src/core/recovery/typed-words.js';
import { plainUserMessage } from '../../../../src/core/types/user-input.js';
import {
  LONG_COMPOSER_DRAFT,
  PREVIEW_UNAVAILABLE,
  VISUAL_FIXTURE_EPOCH,
  trackSlowProbe,
  type CheckpointPredicate,
  type FixtureFactory,
  type FixtureRegistry,
  type FixtureWrite,
} from '../common.js';
import { VISUAL_FIXTURE_PROJECT_DIR } from '../screen-fixtures.js';
import { markWorkflowPaused } from '../../../../src/stores/workflow/actions/pause.js';
import { lifecycleStore } from '../../../../src/stores/workflow/lifecycle/state.js';
import { glyph, type GlyphName } from '../../../../src/lib/glyphs.js';
import { feedbackStore } from '../../../../src/stores/ui/feedback.js';
import { composerDraftStore } from '../../../../src/stores/ui/composer-draft.js';
import { composerLiveStore } from '../../../../src/stores/ui/composer-live.js';
import { saveSessionDraft } from '../../../../src/stores/ui/session-drafts.js';
import { routerStore } from '../../../../src/stores/navigation/router.js';
import { createDraftDocument } from '../../../../src/core/composer/document.js';
import { listRowLead } from '../../../../src/components/list-row/lead.js';
import { reviewKeysStore } from '../../../../src/stores/ui/review-keys.js';
import { REVIEW_COMMENT_HINTS } from '../../../../src/features/workflow/prompt-rows/review-document.js';
import { formatCopyResult } from '../../../../src/core/runtime/commands/types.js';
import { stopStore } from '../../../../src/stores/workflow/stop.js';
import { departureStore } from '../../../../src/stores/workflow/departure.js';
import {
  activeApply,
  trackActiveApply,
} from '../../../../src/engine/orchestrator/session-lifecycle/shutdown.js';
import { overlayStore } from '../../../../src/stores/ui/overlay.js';
import { openApprovalPrompt } from '../../../../src/stores/prompts/approval.js';
import { PROMPT_TYPEAHEAD_GRACE_MS } from '../../../../src/lib/terminal/typeahead-grace.js';
import {
  WORKFLOW_FIXTURE_TASK_ID,
  WORKFLOW_FIXTURE_TEXT,
  crewWideReviewNoneEndProjection,
  workflowFixtureProjections,
  type FixtureStopState,
  type WorkflowFixtureProjection,
} from './projections.js';
import {
  OUTPUT_LIMIT_READ_FILE,
  OUTPUT_LIMIT_TOOL_OUTPUT_MESSAGE,
} from './output-limit-projection.js';
import { MOVED_PROJECT_MESSAGE } from './at-rest-projections.js';
import { seatMovedModelLineProjection } from './seat-moved-model-line.js';
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
const PLAN_CARD_OVER_DRAFT = 'also print the greeting in uppercase';
const TYPED_WORDS = 'keep the old lockfile';
const REFUSED_WORDS = 'also fix the typo';
const STEER_REFUSED_LINE = '/steer use the old name';
const STOP_STEER_REFUSED_LINE = `/steer ${REFUSED_WORDS}`;
const COMMAND_IMAGE_TEXT = '/steer fix the layout ';
const COMMAND_IMAGE_LINE = `${COMMAND_IMAGE_TEXT}[image #1]`;
const COMMAND_IMAGE_REASON = 'A command sends no image. Remove the command, then press ctrl+⏎.';
const PLAN_CARD_END_DRAFT = '/end now';
const PLAN_CARD_STEER_DRAFT = '/st';
const END_USAGE_REFUSAL = '/end takes no argument. Usage: /end';
const STEER_ROW_DESCRIPTION = 'Send a correction now; a running call stops first';
const STEER_ROW_START = 'Send a correction now';

function createStopAwareFactory(projection: WorkflowFixtureProjection): FixtureFactory {
  const base = createWorkflowFixtureFactory(projection);
  if (projection.scenarioId === 'workflow-crew-wide-review-none') {
    return () => {
      const live = base();
      let chosen = live;
      return {
        ...live,
        setup: async (context) => {
          const selected = workflowFixtureProjectionFor(context.scenario.id, context.checkpoint.id);
          chosen =
            selected === undefined || selected === projection
              ? live
              : createWorkflowFixtureFactory(selected)();
          await chosen.setup(context);
        },
        teardown: () => chosen.teardown(),
      };
    };
  }
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
  // The restored line makes the card wait, so the keys stay in the composer and ⏎ runs it.
  if (projection.scenarioId === 'workflow-plan-card-usage-refused') {
    return () => {
      const lifecycle = base();
      return {
        ...lifecycle,
        setup: async (context) => {
          await lifecycle.setup(context);
          const route = routerStore.get();
          if (route.screen !== 'workflow') throw new Error('The usage fixture needs a run');
          saveSessionDraft(route.run.ref, createDraftDocument(PLAN_CARD_END_DRAFT));
        },
        afterMount: (write) => write.press('\r'),
      };
    };
  }
  // The same restored line keeps the card up while the command list explains what /steer does.
  if (projection.scenarioId === 'workflow-plan-card-steer-row') {
    return () => {
      const lifecycle = base();
      return {
        ...lifecycle,
        setup: async (context) => {
          await lifecycle.setup(context);
          const route = routerStore.get();
          if (route.screen !== 'workflow') throw new Error('The steer row fixture needs a run');
          saveSessionDraft(route.run.ref, createDraftDocument(PLAN_CARD_STEER_DRAFT));
        },
      };
    };
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
  // The correction is deleted again, so the composer is empty and the gate is back in charge.
  if (projection.scenarioId === 'workflow-approval-confirm-draft-deleted') {
    return () => ({
      ...base(),
      afterMount: async (write) => {
        const approval = projection.approvalAfterMount;
        if (approval === undefined) {
          throw new Error('The draft-deleted gate needs its after-mount approval');
        }
        await write.press(TYPED_WORDS);
        void openApprovalPrompt({
          tier: 'confirm',
          actionClass: approval.actionClass ?? 'package_change',
          actionDescription: approval.actionDescription,
          taskId: WORKFLOW_FIXTURE_TASK_ID,
          phase: 'implementing',
        });
        for (const _ of TYPED_WORDS) await write.press('\b');
      },
    });
  }
  // Words typed while a plan is in review stay put: that phase takes no queued correction.
  if (projection.scenarioId === 'workflow-approval-confirm-words-stay') {
    return () => ({
      ...base(),
      afterMount: async (write) => {
        const approval = projection.approvalAfterMount;
        if (approval === undefined) {
          throw new Error('The words-stay gate needs its after-mount approval');
        }
        await write.press(TYPED_WORDS);
        void openApprovalPrompt({
          tier: 'confirm',
          actionClass: approval.actionClass ?? 'package_change',
          actionDescription: approval.actionDescription,
          taskId: WORKFLOW_FIXTURE_TASK_ID,
          phase: 'reviewing-plan',
        });
      },
    });
  }
  // The words go through the composer first, so the gate opens over a real draft.
  if (projection.scenarioId === 'workflow-approval-confirm-over-draft') {
    return () => ({
      ...base(),
      afterMount: async (write) => {
        await write.press(TYPED_WORDS);
        void openApprovalPrompt({
          tier: 'confirm',
          actionClass: 'destructive',
          actionDescription: '.splitbrief/state.json',
          taskId: WORKFLOW_FIXTURE_TASK_ID,
          phase: 'implementing',
        });
      },
    });
  }
  // The confirmation opens over the words typed in its review phase: no seat takes them, so Enter
  // hands them back under the pending confirmation and Tab gives it the keys.
  if (projection.scenarioId === 'workflow-plan-card-confirm-words') {
    return () => ({
      ...base(),
      afterMount: async (write) => {
        await write.press(TYPED_WORDS);
        void openApprovalPrompt({
          tier: 'confirm',
          actionClass: 'destructive',
          actionDescription: '.splitbrief/state.json',
          taskId: WORKFLOW_FIXTURE_TASK_ID,
          phase: 'reviewing-plan',
        });
        await flushEffects();
        await write.press('\r');
        await write.press('\t');
      },
    });
  }
  // The draft was typed before the plan arrived, so the composer restores it when the screen mounts
  // and the card opens over it.
  if (
    projection.scenarioId === 'workflow-plan-card-over-draft' ||
    projection.scenarioId === 'workflow-plan-card-over-approve'
  ) {
    const draft =
      projection.scenarioId === 'workflow-plan-card-over-draft' ? PLAN_CARD_OVER_DRAFT : 'approve';
    return () => {
      const lifecycle = base();
      return {
        ...lifecycle,
        setup: async (context) => {
          await lifecycle.setup(context);
          const route = routerStore.get();
          if (route.screen !== 'workflow') throw new Error('The plan card fixture needs a run');
          saveSessionDraft(route.run.ref, createDraftDocument(draft));
        },
      };
    };
  }
  // The expanded checkpoint opens the lowest fold of the transcript with ctrl+a.
  if (
    projection.scenarioId === 'workflow-closed-summary' ||
    projection.scenarioId === 'workflow-final-review-checks-fold'
  ) {
    return () => {
      const lifecycle = base();
      let expand = false;
      return {
        ...lifecycle,
        setup: async (context) => {
          expand = context.checkpoint.id.endsWith('-expanded');
          await lifecycle.setup(context);
        },
        afterMount: async (write) => {
          if (expand) await write.press('\u0001');
        },
      };
    };
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
  // The Skip goes through the screen's own recovery driver, so the refusal on screen is the real one.
  if (projection.scenarioId === 'workflow-moved-project-skip') {
    return () => ({
      ...base(),
      afterMount: async (write) => {
        const refused = Promise.withResolvers<void>();
        const off = feedbackStore.subscribe(() => {
          if (feedbackStore.get().message === MOVED_PROJECT_MESSAGE) refused.resolve();
        });
        await write.press('s');
        await refused.promise;
        off();
      },
    });
  }
  if (
    projection.scenarioId === 'workflow-ready-override-confirm' ||
    projection.scenarioId === 'workflow-ready-red-check-confirm' ||
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
      afterMount: () => feedbackStore.setMessage('Apply undone: removed 4 created files.'),
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
          // The close dates the run with `new Date()`, which the fixed `Date.now` of the capture
          // does not reach, so a new Date with no value reads that clock during the close.
          const SystemDate = Date;
          globalThis.Date = new Proxy(SystemDate, {
            construct: (target, args, newTarget) =>
              Reflect.construct(target, args.length === 0 ? [SystemDate.now()] : args, newTarget),
          });
          try {
            await endRunAtRest({ ...record.ref, bus }, saved);
          } finally {
            globalThis.Date = SystemDate;
          }
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
  // The preview's `/steer` stops at its own refusal (`steerRun` in `fixture-session.ts`). Once
  // the line is back, the fixture puts the halt's reason in its place, as `requestSteer` returns it.
  if (projection.scenarioId === 'workflow-recovery-steer-refused') {
    return () => ({
      ...base(),
      afterMount: async (write) => {
        await write.press('/');
        await write.press(STEER_REFUSED_LINE.slice(1));
        const refused = Promise.withResolvers<void>();
        const off = feedbackStore.subscribe(() => {
          if (feedbackStore.get().message === PREVIEW_UNAVAILABLE) refused.resolve();
        });
        await write.press('\r');
        await refused.promise;
        off();
        feedbackStore.setMessage(NO_CORRECTION_MESSAGE);
      },
    });
  }
  // The line carries its image from the session draft, and the composer refuses it whole: the
  // command never leaves for a handler, and the word and the image stay where they were typed.
  if (projection.scenarioId === 'workflow-command-image-refused') {
    return () => {
      const lifecycle = base();
      return {
        ...lifecycle,
        setup: async (context) => {
          await lifecycle.setup(context);
          const route = routerStore.get();
          if (route.screen !== 'workflow') throw new Error('The image refusal needs a run');
          saveSessionDraft(route.run.ref, {
            version: 1,
            parts: [
              { kind: 'text', text: COMMAND_IMAGE_TEXT },
              {
                kind: 'image',
                attachment: {
                  id: 'att-command-refusal-1',
                  kind: 'image',
                  path: `${VISUAL_FIXTURE_PROJECT_DIR}/docs/usage-panel.png`,
                  mimeType: 'image/png',
                  sizeBytes: 48_120,
                },
              },
            ],
          });
        },
        afterMount: (write) => write.press('\r'),
      };
    };
  }
  if (projection.scenarioId === 'workflow-apply-recheck-words-refused') {
    return () => {
      const lifecycle = base();
      return {
        ...lifecycle,
        setup: async (context) => {
          await lifecycle.setup(context);
          const route = routerStore.get();
          if (route.screen !== 'workflow') throw new Error('The Apply refusal needs a run');
          saveSessionDraft(route.run.ref, createDraftDocument(REFUSED_WORDS));
        },
        afterMount: () => feedbackStore.setMessage(noWordsRefusal({ kind: 'apply' })),
      };
    };
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
  const steerRefused = projection.scenarioId === 'workflow-stop-steer-refused';
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
      ...(steerRefused && {
        afterMount: async (write: FixtureWrite) => {
          await write.press('/');
          await write.press(STOP_STEER_REFUSED_LINE.slice(1));
          const refused = Promise.withResolvers<void>();
          const feedbackOff = feedbackStore.subscribe(() => {
            if (feedbackStore.get().message === PREVIEW_UNAVAILABLE) refused.resolve();
          });
          try {
            await write.press('\r');
            await refused.promise;
          } finally {
            feedbackOff();
          }
          const reason = requestSteer(plainUserMessage(REFUSED_WORDS));
          if (reason === undefined) throw new Error('The stop steer fixture needs its refusal');
          feedbackStore.setMessage(reason);
        },
      }),
      teardown: () => {
        off?.();
        off = null;
        stopStore.__testReset();
        return lifecycle.teardown();
      },
    };
  };
}

export const workflowProjectionRegistry: ReadonlyMap<ScenarioId, WorkflowFixtureProjection> =
  new Map(
    [...workflowFixtureProjections.values(), seatMovedModelLineProjection].map((projection) => [
      projection.scenarioId,
      projection,
    ]),
  );

export function workflowFixtureProjectionFor(
  scenario: ScenarioId,
  checkpoint: CheckpointId,
): WorkflowFixtureProjection | undefined {
  if (
    scenario === crewWideReviewNoneEndProjection.scenarioId &&
    checkpoint === 'crew-wide-review-none-end'
  ) {
    return crewWideReviewNoneEndProjection;
  }
  return workflowProjectionRegistry.get(scenario);
}

export const workflowFixtureRegistry: FixtureRegistry = new Map(
  [...workflowProjectionRegistry.values()].map((projection) => [
    projection.scenarioId,
    createStopAwareFactory(projection),
  ]),
);

function includesAll(...markers: readonly string[]): CheckpointPredicate {
  return ({ output, checkpoint }) => {
    return output.includes(checkpoint.marker) && markers.every((marker) => output.includes(marker));
  };
}

// A panel row that wraps keeps its words: the frame on one line, without the panel's border.
function panelText(output: string): string {
  return stripAnsiStyles(output).replace(/[│▌]/gu, ' ').replace(/\s+/gu, ' ');
}

function excludesAll(...markers: readonly string[]): CheckpointPredicate {
  return ({ output }) => markers.every((marker) => !output.includes(marker));
}

// The fold of a closed run's summary counts what the record adds, and names the activity key.
const SUMMARY_FOLD = /\+\d+ briefs?\b.* · ctrl\+a/u;

// A summary taller than the view keeps its labelled rows only, so each checkpoint requires its
// markers from `fromRows`, the shortest view that shows them.
function aboveSummaryFold(fromRows: number, ...markers: readonly string[]): CheckpointPredicate {
  return (context) =>
    includesAll()(context) &&
    SUMMARY_FOLD.test(context.output) &&
    (context.viewport.rows < fromRows || includesAll(...markers)(context));
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

// A check row of a group leads with its label, at any width.
const CHECK_ROW = /^(?:Plan check K\d+|Reviewer check V\d+|Base re-run V\d+|Render [\w-]+) · /u;

/**
 * One check group in the transcript: the header that counts it, the fold row, and the label of each
 * check row it shows, in order. A header too narrow for its counts keeps the leading ones. The view
 * sticks to the transcript's end, so the frame shows `screen.text`, after the mark when given, only
 * once the view is `screen.fromRows` tall.
 */
function checkGroup(expected: {
  readonly header: string;
  readonly fold: string;
  readonly rows: readonly string[];
  readonly screen: { readonly fromRows: number; readonly mark?: GlyphName; readonly text: string };
}): CheckpointPredicate {
  return (context) => {
    const lines = workflowTranscriptText().split('\n');
    const header = lines.find((line) => line.startsWith('Checks  '));
    const rows = lines.filter((line) => CHECK_ROW.test(line));
    const { fromRows, mark, text } = expected.screen;
    return (
      includesTranscript()(context) &&
      (context.viewport.rows < fromRows ||
        context.output.includes(mark === undefined ? text : `${glyph(mark)} ${text}`)) &&
      header !== undefined &&
      (header === expected.header ||
        (context.viewport.cols < 80 && expected.header.startsWith(`${header} · `))) &&
      lines.includes(expected.fold) &&
      rows.length === expected.rows.length &&
      expected.rows.every((label, index) => rows[index]?.startsWith(label) === true)
    );
  };
}

const CHECKS_FOLD_HEADER = 'Checks  29 passed · 8 rendered · 6 reused · 2m 58s';

// The 37 checks of the passed final review, in the order they ran.
const CHECKS_FOLD_ROWS = [
  ...Array.from({ length: 14 }, (_, index) => `Plan check K${index + 1} · `),
  ...[
    'signup-form-empty',
    'signup-form-filled',
    'signup-form-invalid-email',
    'signup-form-weak-password',
    'signup-form-submitting',
    'signup-form-server-error',
    'signup-success',
    'signup-form-narrow',
  ].map((scenario) => `Render ${scenario} · `),
  ...Array.from({ length: 15 }, (_, index) => `Reviewer check V${index + 1} · `),
];

// The header facts of the group with the re-runs at the run base, then how many of them the header
// keeps per viewport width: a narrower header drops whole counts from the right.
const CHECKS_BASE_FACTS = [
  'Checks  1 pre-existing',
  '1 red at the run base',
  '4 passed',
  '1 passes at the run base',
  '1 reused',
  '1m 38s',
];
const CHECKS_BASE_KEPT = new Map([
  [160, 6],
  [120, 6],
  [80, 3],
  [60, 2],
]);

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

const REVIEW_NONE_ROW = 'Review · none · no seat reviewed this run';

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
  [checkpointId('start-variant-not-applied'), includesAll('Warning', 'variant', 'Planning…')],
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
    checkpointId('crew-wide-review-none-end'),
    (context) =>
      includesAll('REVIEW None')(context) && reviewNoneRowOnce() && noReviewClaimed(context),
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
  // The first rows scroll out of a 60x18 transcript, so the frame pins the last two rows, and the
  // transcript text proves that the text of each sub-agent has its own rows.
  [
    checkpointId('implementation-parallel-subagents'),
    (context) => {
      const text = workflowTranscriptText();
      const lines = text.split('\n');
      const rows = ['Checking.', 'Reading the tests', 'Looking at it.', 'Found 3.', 'Done.'].map(
        (row) => lines.findIndex((line) => line.trim() === row),
      );
      return (
        includesAll('Found 3.', 'Done.')(context) &&
        rows.every((row, index) => row > (rows[index - 1] ?? -1)) &&
        !lines.some((line) => line.includes('Reading the tests') && line.includes('Looking')) &&
        !text.includes('it.s')
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
        // Up to 80 columns the file name does not fit whole, so the path and its count go.
        (context.viewport.cols <= 80 || context.output.includes('+1 file'))
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
  [
    checkpointId('resumed-cut-brief'),
    // One SPLITBRIEF row, never a Warning, says the brief continues; a narrow frame wraps it. Under
    // 40 rows the rows of the continued brief push that row out of the frame.
    (context) => {
      const text = workflowTranscriptText().replace(/\s/g, '');
      return (
        includesTranscript("verified · kept the interrupted attempt's work")(context) &&
        (context.viewport.rows < 40 || context.output.includes(context.checkpoint.marker)) &&
        text.split('SPLITBRIEFT901continueswherethestopleftit.').length === 2 &&
        !text.includes('Warning')
      );
    },
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
    checkpointId('final-review-checks-fold'),
    checkGroup({
      header: CHECKS_FOLD_HEADER,
      fold: '+37 checks · ctrl+a',
      rows: [],
      screen: { fromRows: 24, mark: 'stageDone', text: 'Checks  29 passed' },
    }),
  ],
  [
    checkpointId('final-review-checks-fold-expanded'),
    checkGroup({
      header: CHECKS_FOLD_HEADER,
      fold: 'collapse · ctrl+a',
      rows: CHECKS_FOLD_ROWS,
      screen: { fromRows: 24, text: 'Reviewer check V15 · ' },
    }),
  ],
  [
    checkpointId('final-review-checks-failed'),
    (context) => {
      const lines = workflowTranscriptText().split('\n');
      // A wrapped row reads as one line.
      const text = lines.map((line) => line.trim()).join(' ');
      return (
        checkGroup({
          header: 'Checks  1 failed · 1 not\u00a0run · 27 passed · 8 rendered · 6 reused · 3m 2s',
          fold: '+35 passed · ctrl+a',
          rows: ['Plan check K4 · ', 'Reviewer check V13 · '],
          screen: { fromRows: 40, mark: 'statusFailed', text: 'Checks  1 failed' },
        })(context) &&
        lines.some(
          (line) => line.startsWith('Reviewer check V13 · ') && line.includes(' · not\u00a0run'),
        ) &&
        [
          '2\u00a0new, 0\u00a0pre-existing',
          'new · src/features/signup/signup-form.test.tsx > rejects an address without a domain',
          'the command reached for the network, which a check cannot reach',
        ].every((marker) => text.includes(marker))
      );
    },
  ],
  [
    checkpointId('final-review-checks-running'),
    (context) =>
      checkGroup({
        header: 'Checks  11 passed · 2 rendered · 1 running · 2 reused · 1m 8s',
        fold: '+11 earlier · ctrl+a',
        rows: ['Reviewer check V1 · ', 'Reviewer check V2 · ', 'Reviewer check V3 · '],
        screen: { fromRows: 18, mark: 'statusInProgress', text: 'Checks  11 passed' },
      })(context) && context.output.includes('running 0:12'),
  ],
  [
    checkpointId('final-review-checks-base'),
    (context) => {
      const kept = CHECKS_BASE_KEPT.get(context.viewport.cols);
      const header = CHECKS_BASE_FACTS.slice(0, kept).join(' · ');
      const lines = workflowTranscriptText().split('\n');
      // A wrapped row reads as one line.
      const text = lines.map((line) => line.trim()).join(' ');
      return (
        kept !== undefined &&
        // The header is exact at every width, also below 80 columns.
        lines.includes(header) &&
        checkGroup({
          header,
          fold: '+5 passed · ctrl+a',
          rows: ['Reviewer check V2 · ', 'Base re-run V2 · '],
          screen: { fromRows: 24, mark: 'statusWarning', text: 'Checks  1 pre-existing' },
        })(context) &&
        [
          'Reviewer check V2 · npm test · pre-existing · 16.4s',
          'pre-existing · src/legacy/report.test.ts > total matches the ledger',
          'Base re-run V2 · npm test · red at the run base · 15.8s',
        ].every((marker) => text.includes(marker))
      );
    },
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
  [
    checkpointId('apply-recheck-words-refused'),
    (context) =>
      includesAll(
        'Cannot send words to Apply',
        REFUSED_WORDS,
        'Checking the merged result',
      )(context) &&
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
    checkpointId('brief-check-unran-red'),
    includesAll('T901 check K1 · failed · the workspace has no test file'),
  ],
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
    includesTranscript('~24,310 of 32K context tokens (tight)', '~7,000 context tokens (tight)'),
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
  [
    checkpointId('approval-confirm-over-draft'),
    includesAll(TYPED_WORDS, 'tab back to the actions'),
  ],
  [
    checkpointId('approval-confirm-draft-deleted'),
    (context) =>
      includesAll(
        'Destructive action:',
        'Confirm with a reason',
        'tab/⏎ back to the actions',
      )(context) &&
      composerLiveStore.get().empty &&
      excludesAll(
        `${listRowLead('active')}    Confirm`,
        `${listRowLead('active')}r   Confirm with a reason`,
        `${listRowLead('active')}x   Deny`,
      )(context),
  ],
  [
    checkpointId('approval-confirm-words-stay'),
    (context) =>
      includesAll(
        'Trust and run a configured runner:',
        TYPED_WORDS,
        'tab back to the actions',
      )(context) &&
      composerLiveStore.get().text === TYPED_WORDS &&
      excludesAll('queues the typed correction', 'queues the correction')(context),
  ],
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
    checkpointId('plan-card-over-draft'),
    (context) =>
      planCardReady(context) &&
      includesAll(PLAN_CARD_OVER_DRAFT)(context) &&
      excludesAll(`${listRowLead('active')}Approve plan`)(context),
  ],
  [
    checkpointId('plan-card-over-approve'),
    (context) =>
      planCardReady(context) &&
      includesAll(`${listRowLead('active')}Approve plan`, `${glyph('prompt')} approve`)(context),
  ],
  [checkpointId('plan-card-confirm-words'), includesAll('Confirm with a reason', TYPED_WORDS)],
  [
    checkpointId('plan-card-usage-refused'),
    (context) =>
      planCardReady(context) && includesAll(END_USAGE_REFUSAL, PLAN_CARD_END_DRAFT)(context),
  ],
  [
    checkpointId('plan-card-steer-row'),
    (context) => {
      if (!context.output.includes('Add a greeting module and expose it from the CLI.')) {
        return false;
      }
      const row = context.output.split('\n').find((line) => line.includes('/steer'));
      if (row === undefined || !row.includes(STEER_ROW_START)) return false;
      if (context.viewport.cols >= 120) {
        return (
          row.includes(STEER_ROW_DESCRIPTION) &&
          context.output.includes('Approve plan and start the build')
        );
      }
      return context.viewport.cols >= 80 || row.includes('…');
    },
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
  // A short terminal shows the marked row only. A tall one shows the gate down to its first
  // long command.
  [
    checkpointId('plan-card-long-gate'),
    (context) =>
      includesAll()(context) &&
      (context.viewport.rows < 18 || planCardReady(context)) &&
      (context.viewport.rows < 40 || context.output.includes('V4: npx --no-install vitest run')),
  ],
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
  [
    checkpointId('stop-steer-refused'),
    includesAll(STOP_STEER_REFUSED_LINE, 'Finishing cleanup and saving'),
  ],
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
      const crewLine = headerRow.includes('PLAN claude · BUILD claude · REVIEW = PLAN');
      if (context.viewport.cols === 80) {
        const shortRail = [
          `${glyph('stageDone')} ${RAIL_SHORT_LABEL.plan}`,
          `${glyph('stageDone')} ${RAIL_SHORT_LABEL.build}`,
          `${glyph('stageDone')} ${RAIL_SHORT_LABEL.review}`,
          `${glyph('statusFailed')} ${RAIL_SHORT_LABEL.apply}`,
        ].join(railConnectorString());
        return headerRow.includes(shortRail) && crewLine;
      }
      return headerRow.includes(`${glyph('statusFailed')} Apply`) && crewLine;
    },
  ],
  [
    checkpointId('command-image-refused'),
    (context) =>
      includesAll(COMMAND_IMAGE_LINE)(context) &&
      feedbackStore.get().message === COMMAND_IMAGE_REASON &&
      (context.viewport.cols < 120 || context.output.includes(COMMAND_IMAGE_REASON)),
  ],
  [checkpointId('recovery-steer-refused'), includesAll(STEER_REFUSED_LINE)],
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
    includesAll('Cannot send words with', TYPED_WORDS, 'tab back to the actions'),
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
        includesAll('Ended', 'Run closed')(context) &&
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
    checkpointId('moved-project-skip'),
    (context) =>
      includesTranscript('Recovery  Skip task blocked')(context) &&
      workflowTranscriptText().replace(/\s+/g, ' ').includes(MOVED_PROJECT_MESSAGE) &&
      context.output.includes('Needs you'),
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
          headerRow.includes(`○ ${RAIL_SHORT_LABEL.apply}`) &&
          headerRow.includes(
            'PLAN GPT-5.1 · BUILD Gemini 3.8 Flash → Google Antigravity CLI · REVIEW GPT-5 Codex',
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
    checkpointId('ready-seat-moved-model-line'),
    (context) => {
      if (!context.output.includes(context.checkpoint.marker)) return false;
      const headerRow = context.output.split('\n')[0] ?? '';
      return (
        headerRow.includes('○ Apply') &&
        headerRow.includes(
          'PLAN GPT-5.1 · BUILD Gemini 3.8 Flash → Google Antigravity CLI · REVIEW GPT-5 Codex',
        )
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
      includesAll('/ for a command…')(context) &&
      excludesAll('for home', 'when Apply finishes', 'Applying to your checkout')(context) &&
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
      includesAll('Running in another process', '● Apply', '/ for a command…')(context) &&
      excludesAll('Applying to your checkout', 'for home', 'Ready to apply')(context),
  ],
  // The log names when the other process's Apply began, so its clock counts from there.
  [
    checkpointId('at-rest-other-process-applying-clock'),
    (context) =>
      includesAll('Applying to your checkout · 0:06', '● Apply', '/ for a command…')(context) &&
      excludesAll('Running in another process', 'for home', 'Ready to apply')(context),
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
    checkpointId('ready-red-check'),
    (context) =>
      includesAll()(context) &&
      panelText(context.output).includes(
        'Apply as is · write the changes with the red checks and the open findings; asks once',
      ),
  ],
  [
    checkpointId('ready-red-check-confirm'),
    // The red checks come before the findings. A view too short for the whole list counts the
    // findings on its last row.
    (context) => {
      const text = panelText(context.output);
      const at = [
        '- V1 failed · npm test · Error: 2 specs failed',
        '- K004 failed · src/a.ts(3,1): TS2322',
        context.viewport.rows < 24
          ? '+2 more open findings'
          : '- src/form.ts re-validates on every keystroke',
        'Apply as is · write the changes; the red checks and these findings stay open',
      ].map((row) => text.indexOf(row));
      return (
        includesAll()(context) &&
        at.every((index, row) => index >= 0 && index > (at[row - 1] ?? -1))
      );
    },
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
  [checkpointId('closed-pre-existing'), aboveSummaryFold(40, 'V2 pre-existing')],
  [checkpointId('closed-fix-cycle'), aboveSummaryFold(24, 'earlier reviews failed')],
  [checkpointId('closed-summary'), aboveSummaryFold(0)],
  [
    checkpointId('closed-summary-expanded'),
    includesAll('Applied to your checkout', 'collapse · ctrl+a', 'T001'),
  ],
  [checkpointId('closed-set-aside'), aboveSummaryFold(24, 'Set aside V1: npm run lint fails')],
  [checkpointId('closed-undone'), includesAll('Apply undone')],
  [checkpointId('closed-undo-conflicts'), includesAll('1 conflict kept')],
  [checkpointId('closed-discarded'), includesAll()],
  [checkpointId('closed-rejected'), includesAll()],
  [checkpointId('closed-needs-attention'), includesAll()],
  // A view shorter than the whole summary names the accept on the Review row.
  [
    checkpointId('closed-planner-accept'),
    (context) =>
      aboveSummaryFold(40, 'Accepted as is', "Planner's note:")(context) &&
      (context.viewport.rows >= 40 || includesAll('failed · accepted as is')(context)),
  ],
  [
    checkpointId('closed-red-check-accept'),
    (context) =>
      aboveSummaryFold(40, 'Accepted as is · 1 red check: V1')(context) &&
      (context.viewport.rows >= 40 || includesAll('failed · accepted as is')(context)),
  ],
  [checkpointId('closed-decided-skip'), aboveSummaryFold(0, '1 skipped')],
  [checkpointId('closed-ended'), includesAll()],
  [checkpointId('closed-ended-empty'), includesAll()],
  [checkpointId('closed-ended-workspace'), includesAll('run.patch')],
  // The summary of the closed run renders run.patch in the visible frame outside event rows, while
  // the transcript retains the foreign-workspace notice.
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
  // The last detail wraps between the sides of the panel, so the frame is read as one line of
  // words, with no side and no line break.
  [
    checkpointId('recovery-plan-correction-again'),
    (context) =>
      includesAll('Planning failed', 'Change PLAN tool', 'Try again')(context) &&
      stripAnsiStyles(context.output)
        .replace(/[\s│]+/g, ' ')
        .includes('Your plan correction goes again with this step.'),
  ],
  [checkpointId('recovery-plan-questions'), includesAll('Which store keeps the greeting?')],
  // The line of the correction is whole at each size. A tall panel lists each question.
  [
    checkpointId('recovery-plan-questions-long'),
    (context) => {
      const words = stripAnsiStyles(context.output).replace(/[\s│]+/g, ' ');
      return (
        words.includes('Your plan correction goes again with this step.') &&
        (context.viewport.cols < 120 ||
          [
            'Which store keeps the greeting?',
            'Does the module export a default or a named function?',
            'Should the help text show an example?',
          ].every((question) => words.includes(question)))
      );
    },
  ],
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
    // The batch of T002 is the lowest fold of the replayed transcript, so this one names no key.
    includesAll('+2 earlier', 'Edit    test/text.test.js'),
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
    checkpointId('review-red-check'),
    // The headline names the red check as its one row does, in the words of the next screens.
    (context) =>
      includesAll(
        'found no fix for V1',
        WORKFLOW_FIXTURE_TEXT.reviewFailed,
        'Decide for me',
        'End run',
      )(context) &&
      !stripAnsiStyles(context.output).includes('found no fix for V1.1') &&
      stripAnsiStyles(context.output).includes('V1 failed · npm test · Error: 2 specs failed') &&
      !panelText(context.output).includes('Output tail:'),
  ],
  [
    checkpointId('task-review-no-progress'),
    (context) => {
      const matches = includesAll(
        'Review T904 made no progress on F1',
        WORKFLOW_FIXTURE_TEXT.reviewFailed,
      );
      if (!matches(context)) return false;
      if (context.viewport.cols !== 60 || context.viewport.rows !== 18) return true;
      // The planner's reason is the only fact, so its cut rows take the blank row under the
      // headline: three reason rows follow it with no gap, and the last one carries the cut mark.
      const rows = stripAnsiStyles(context.output)
        .split('\n')
        .map((row) => row.replace(/[│|]/gu, '').trim());
      const headline = rows.findIndex((row) => row.includes('no progress on F1'));
      if (headline < 0) return false;
      const reason = rows.slice(headline + 1, headline + 4);
      return (
        reason.length === 3 &&
        reason.every((row) => row.length > 0) &&
        reason[0]?.startsWith('Planner said: The type test') === true &&
        reason[2]?.includes('…') === true
      );
    },
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
  [
    checkpointId('implementation-read-paths'),
    includesAll('src/a.ts :12-41 · src/b.ts :12-41', 'src/c.ts :40-end'),
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
  [
    checkpointId('planning-seat-retry'),
    (context) =>
      includesAll('Network or server failure', 'retry 2 of 10')(context) &&
      excludesAll('PLAN  Network')(context),
  ],
  [
    checkpointId('build-seat-retry'),
    (context) =>
      includesAll('retry 2 of 10')(context) &&
      excludesAll('BUILD failed', 'BUILD  failed', 'BUILD  Network')(context),
  ],
  [
    checkpointId('final-review-seat-retry'),
    (context) =>
      includesAll('Network or server failure', 'retry 2 of 10', 'Review input trimmed')(context) &&
      excludesAll('REVIEW  Network')(context),
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
  [
    checkpointId('planner-session-expired'),
    // The session log keeps the expired thread and the warning and the error of the call it ended;
    // the transcript has no row and no warn or err count for any of them.
    (context) => {
      const transcript = workflowTranscriptText();
      return (
        includesAll()(context) &&
        !transcript.includes('Planner session expired') &&
        !transcript.includes('no rollout found') &&
        !transcript.includes('CLI exited with code 1') &&
        !/\d+ (warn|err)\b/.test(transcript)
      );
    },
  ],
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
