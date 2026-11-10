import type { EvidenceLedger } from '../../../src/core/schemas/evidence.js';
import type { Summary } from '../../../src/core/schemas/summary.js';
import { taskId } from '../../../src/core/schemas/task.js';
import type { WorkflowState } from '../../../src/core/schemas/workflow.js';
import type { EngineEvent } from '../../../src/engine/events/types.js';
import { makeSummary } from './summary.js';
import { makeTask } from './task.js';
import { makeWorkflowState } from './workflow-state.js';

/**
 * The record of a long applied run, with the numbers of a real one: 15 briefs, 8 of them from 3 fix
 * cycles, 2 briefs that asked the planner, 65 changed files, 3 failed final reviews before the one
 * that passed with a note.
 */
export const FIX_CYCLE_RUN_FEATURE =
  'No Drift row, the whole stuck reason, a short question row, a fold that names the saved folder, and a crew strip that names every seat';

const AT = '2026-09-14T09:41:00.000Z';
const BUILD_SEAT = { tool: 'command-code', model: 'deepseek/deepseek-v4.1-flash-fast' } as const;
const PLAN_SEAT = { tool: 'claude-code', model: 'claude-opus-5-5' } as const;

interface BriefFact {
  readonly id: string;
  readonly title: string;
  readonly method: 'local' | 'consulted';
  readonly retries: number;
  readonly durationMs: number;
  readonly files: readonly string[];
}

const BRIEFS: readonly BriefFact[] = [
  {
    id: 'T001',
    title: 'Make drift_report rowless and remove the Drift row code, tests, and gallery fixtures',
    method: 'local',
    retries: 0,
    durationMs: 802413,
    files: [
      'docs/FEATURES.md',
      'docs/SLASH-COMMANDS-REFERENCE.md',
      'docs/STORES-AND-UI.md',
      'src/features/workflow/conversation-rows/build.test.ts',
      'src/features/workflow/conversation-rows/check-list-spacing.test.ts',
      'src/features/workflow/conversation-rows/check-list-spacing.ts',
      'src/features/workflow/conversation-rows/event-rows/dispatch.test.ts',
      'src/features/workflow/conversation-rows/event-rows/dispatch.ts',
      'src/features/workflow/conversation-rows/event-rows/visibility.test.ts',
      'src/features/workflow/conversation-rows/event-rows/visibility.ts',
      'src/features/workflow/conversation-rows/row-actions.test.ts',
      'src/features/workflow/conversation-rows/row-actions.ts',
      'testing/e2e/scenarios/drift-out-of-scope.test.ts',
      'testing/visual/catalog.ts',
      'testing/visual/fixtures/workflow/projections.ts',
      'testing/visual/fixtures/workflow/registry.ts',
      'testing/visual/workflow-fixtures.test.tsx',
    ],
  },
  {
    id: 'T002',
    title: 'Keep the whole planner reason in recovery halts',
    method: 'local',
    retries: 0,
    durationMs: 521735,
    files: [
      'src/core/recovery/headline.ts',
      'src/engine/orchestrator/recovery/builders/issue.test.ts',
      'src/engine/orchestrator/recovery/builders/issue.ts',
      'src/engine/orchestrator/recovery/builders/task.test.ts',
      'src/features/workflow/components/recovery-menu.test.tsx',
      'src/features/workflow/components/recovery-menu.tsx',
      'src/features/workflow/recovery-prompt.ts',
      'testing/e2e/scenarios/task-review-no-progress-halt.test.ts',
      'testing/visual/fixtures/workflow/projections.ts',
    ],
  },
  {
    id: 'T003',
    title: 'Size the one-row free-text planner question answer field to the draft plus cursor',
    method: 'consulted',
    retries: 1,
    durationMs: 768393,
    files: [
      'src/features/workflow/components/planner-question.test.tsx',
      'src/features/workflow/components/planner-question.tsx',
      'testing/e2e/scenarios/planner-question-short-panel.test.ts',
      'testing/visual/fixtures/workflow/registry.ts',
    ],
  },
  {
    id: 'T004',
    title: "Name the hidden replaced-files fact 'saved folder' in prompt folds",
    method: 'local',
    retries: 0,
    durationMs: 656196,
    files: [
      'src/core/runtime/commands/messages.ts',
      'src/features/workflow/prompt-body-rows.test.ts',
      'src/features/workflow/prompt-body-rows.ts',
      'testing/e2e/scenarios/checkout-isolation-halt.test.ts',
      'testing/visual/fixtures/workflow/registry.ts',
    ],
  },
  {
    id: 'T005',
    title: 'Add formatSeatToolWord, tool-word collapsed seat fallback, and SeatView.tool',
    method: 'local',
    retries: 0,
    durationMs: 974350,
    files: [
      'src/core/crew/identity.test.ts',
      'src/core/crew/identity.ts',
      'src/features/workflow/closed/copy.test.ts',
      'src/features/workflow/closed/copy.ts',
      'src/features/workflow/closed/header.test.ts',
      'src/features/workflow/closed/header.ts',
      'src/features/workflow/closed/projections.ts',
      'src/features/workflow/closed/view-model.test.ts',
      'src/features/workflow/closed/view-model.ts',
      'testing/helpers/factories/summary-view.ts',
    ],
  },
  {
    id: 'T006',
    title:
      'Select rail form and crew strip mode jointly across live header, snapshot, and closed header',
    method: 'consulted',
    retries: 2,
    durationMs: 4145157,
    files: [
      'src/app/screens/workflow.test.tsx',
      'src/app/screens/workflow.tsx',
      'src/features/workflow/closed/copy.ts',
      'src/features/workflow/closed/header.test.ts',
      'src/features/workflow/closed/header.ts',
      'src/features/workflow/components/header.test.tsx',
      'src/features/workflow/components/header.tsx',
      'src/features/workflow/hooks/use-halt-ran-on.ts',
      'src/features/workflow/hooks/use-running-seats.ts',
      'src/features/workflow/layout/chrome-rows.test.ts',
      'src/features/workflow/layout/chrome-rows.ts',
      'src/features/workflow/layout/snapshot.test.ts',
      'src/features/workflow/layout/snapshot.ts',
      'src/hooks/use-crew-display-names.ts',
      'testing/e2e/scenarios/crew-strip-narrow.test.ts',
      'testing/visual/catalog.test.ts',
      'testing/visual/fixtures/workflow/registry.ts',
      'src/core/crew/identity.ts',
      'src/features/workflow/hooks/use-rail-cells.ts',
    ],
  },
  {
    id: 'T007',
    title: 'Update documentation and CHANGELOG.md for the five UI fixes',
    method: 'local',
    retries: 0,
    durationMs: 155474,
    files: ['CHANGELOG.md', 'docs/WORKFLOW-CONVERSATION-SCROLL.md'],
  },
  {
    id: 'T008',
    title: 'Complete the shared tool-word fallback',
    method: 'local',
    retries: 0,
    durationMs: 617552,
    files: [
      'src/app/screens/home.test.tsx',
      'src/core/crew/identity.test.ts',
      'src/core/crew/identity.ts',
      'src/features/home/components/seat-block.test.tsx',
      'src/features/workflow/closed/copy.test.ts',
      'src/features/workflow/closed/copy.ts',
      'src/features/workflow/closed/rows/run.tsx',
    ],
  },
  {
    id: 'T009',
    title: 'Use the painted halt stages for rail selection',
    method: 'local',
    retries: 0,
    durationMs: 976580,
    files: [
      'src/app/screens/workflow.test.tsx',
      'src/features/workflow/components/rail.test.tsx',
      'src/features/workflow/components/rail.tsx',
      'src/features/workflow/hooks/use-rail-cells.ts',
      'src/features/workflow/layout/hit-test.ts',
      'src/features/workflow/layout/snapshot.test.ts',
      'src/features/workflow/layout/snapshot.ts',
    ],
  },
  {
    id: 'T010',
    title: 'Repair the short-question e2e and enforce the draft cap',
    method: 'local',
    retries: 0,
    durationMs: 1012871,
    files: [
      'src/features/workflow/components/planner-question.test.tsx',
      'testing/e2e/scenarios/planner-question-short-panel.test.ts',
    ],
  },
  {
    id: 'T011',
    title: 'Update closed-screen assertions for tool headers',
    method: 'local',
    retries: 0,
    durationMs: 442300,
    files: ['src/app/screens/workflow-closed.test.tsx'],
  },
  {
    id: 'T012',
    title: 'Migrate gallery checkpoints to the one-stage rail',
    method: 'local',
    retries: 0,
    durationMs: 641255,
    files: [
      'testing/visual/fixtures/workflow/registry.ts',
      'testing/visual/workflow-fixtures.test.tsx',
    ],
  },
  {
    id: 'T013',
    title: 'Recognize saved-folder facts across wrapped rows',
    method: 'local',
    retries: 0,
    durationMs: 470645,
    files: [
      'src/features/workflow/prompt-body-rows.test.ts',
      'src/features/workflow/prompt-body-rows.ts',
      'testing/e2e/scenarios/checkout-isolation-halt.test.ts',
    ],
  },
  {
    id: 'T014',
    title: 'Select the rail using the displayed recorded crew',
    method: 'local',
    retries: 0,
    durationMs: 1399304,
    files: [
      'src/app/screens/workflow-closed.test.tsx',
      'src/app/screens/workflow.tsx',
      'src/features/workflow/closed/header.test.ts',
      'src/features/workflow/closed/header.ts',
      'src/features/workflow/components/header.tsx',
      'src/features/workflow/layout/snapshot.test.ts',
      'testing/e2e/scenarios/crew-strip-narrow.test.ts',
      'testing/visual/fixtures/workflow/registry.ts',
    ],
  },
  {
    id: 'T015',
    title: 'Pin the ready-seat-moved-auto predicate to the line the joint selector paints',
    method: 'local',
    retries: 0,
    durationMs: 506451,
    files: ['testing/visual/fixtures/workflow/registry.ts'],
  },
];

const CHANGED_FILES: readonly string[] = [
  'CHANGELOG.md',
  'docs/FEATURES.md',
  'docs/SLASH-COMMANDS-REFERENCE.md',
  'docs/STORES-AND-UI.md',
  'docs/WORKFLOW-CONVERSATION-SCROLL.md',
  'src/app/screens/home.test.tsx',
  'src/app/screens/workflow-closed.test.tsx',
  'src/app/screens/workflow.test.tsx',
  'src/app/screens/workflow.tsx',
  'src/core/crew/identity.test.ts',
  'src/core/crew/identity.ts',
  'src/core/recovery/headline.ts',
  'src/core/runtime/commands/messages.ts',
  'src/engine/orchestrator/recovery/builders/issue.test.ts',
  'src/engine/orchestrator/recovery/builders/issue.ts',
  'src/engine/orchestrator/recovery/builders/task.test.ts',
  'src/features/home/components/seat-block.test.tsx',
  'src/features/workflow/closed/copy.test.ts',
  'src/features/workflow/closed/copy.ts',
  'src/features/workflow/closed/header.test.ts',
  'src/features/workflow/closed/header.ts',
  'src/features/workflow/closed/projections.ts',
  'src/features/workflow/closed/rows/run.tsx',
  'src/features/workflow/closed/view-model.test.ts',
  'src/features/workflow/closed/view-model.ts',
  'src/features/workflow/components/header.test.tsx',
  'src/features/workflow/components/header.tsx',
  'src/features/workflow/components/planner-question.test.tsx',
  'src/features/workflow/components/planner-question.tsx',
  'src/features/workflow/components/rail.test.tsx',
  'src/features/workflow/components/rail.tsx',
  'src/features/workflow/components/recovery-menu.test.tsx',
  'src/features/workflow/components/recovery-menu.tsx',
  'src/features/workflow/conversation-rows/build.test.ts',
  'src/features/workflow/conversation-rows/check-list-spacing.test.ts',
  'src/features/workflow/conversation-rows/check-list-spacing.ts',
  'src/features/workflow/conversation-rows/event-rows/dispatch.test.ts',
  'src/features/workflow/conversation-rows/event-rows/dispatch.ts',
  'src/features/workflow/conversation-rows/event-rows/visibility.test.ts',
  'src/features/workflow/conversation-rows/event-rows/visibility.ts',
  'src/features/workflow/conversation-rows/row-actions.test.ts',
  'src/features/workflow/conversation-rows/row-actions.ts',
  'src/features/workflow/hooks/use-halt-ran-on.ts',
  'src/features/workflow/hooks/use-rail-cells.ts',
  'src/features/workflow/hooks/use-running-seats.ts',
  'src/features/workflow/layout/chrome-rows.test.ts',
  'src/features/workflow/layout/chrome-rows.ts',
  'src/features/workflow/layout/hit-test.ts',
  'src/features/workflow/layout/snapshot.test.ts',
  'src/features/workflow/layout/snapshot.ts',
  'src/features/workflow/prompt-body-rows.test.ts',
  'src/features/workflow/prompt-body-rows.ts',
  'src/features/workflow/recovery-prompt.ts',
  'src/hooks/use-crew-display-names.ts',
  'testing/e2e/scenarios/checkout-isolation-halt.test.ts',
  'testing/e2e/scenarios/crew-strip-narrow.test.ts',
  'testing/e2e/scenarios/drift-out-of-scope.test.ts',
  'testing/e2e/scenarios/planner-question-short-panel.test.ts',
  'testing/e2e/scenarios/task-review-no-progress-halt.test.ts',
  'testing/helpers/factories/summary-view.ts',
  'testing/visual/catalog.test.ts',
  'testing/visual/catalog.ts',
  'testing/visual/fixtures/workflow/projections.ts',
  'testing/visual/fixtures/workflow/registry.ts',
  'testing/visual/workflow-fixtures.test.tsx',
];

/** The fix briefs each failed review got, in fix cycle order. */
const FIX_CYCLES: readonly (readonly string[])[] = [
  ['T008', 'T009', 'T010', 'T011', 'T012'],
  ['T013', 'T014'],
  ['T015'],
];

/** Each failed review ends after the briefs before it, counted from the start of the run at AT. */
const FAILED_REVIEWS: NonNullable<EvidenceLedger['reviews']> = [
  {
    scope: 'final',
    cycle: 0,
    outcome: 'fail',
    at: '2026-09-14T12:44:08.000Z',
    blocking: [
      {
        id: 'F1',
        text: 'collapsedToolWord excludes explicit models from the fallback. closed/copy.ts:350 repeats this restriction.',
      },
      {
        id: 'F2',
        text: "The long-draft test only requires '· ↓ more · Which file'. Removing the half-row cap still leaves enough space for that substring with this draft.",
      },
      {
        id: 'P1',
        text: 'Last changed by T003. Check E2E-short-question did not pass (fail): 1 failure Failures: -.',
      },
      {
        id: 'P2',
        text: 'Last changed by T006. Check E2E-crew-strip did not pass (fail): 1 failure Failures: - testing/e2e/scenarios/crew-strip-narrow.test.ts > e2e: the crew.',
      },
      {
        id: 'P3',
        text: 'Check R-left-isolation-in-place did not pass (fail): exited with code 1: Error: workflow-recovery-left-isolation-in-place 60x18:.',
      },
      {
        id: 'V4.1',
        text: 'Reviewer check V4 (npm test) failed with new failures. No task changed it.',
      },
      {
        id: 'V4.2',
        text: 'Reviewer check V4 (npm test) failed with new failures. No task changed it.',
      },
      {
        id: 'V4.3',
        text: 'Reviewer check V4 (npm test) failed with new failures. No task changed it.',
      },
      {
        id: 'V4.4',
        text: 'Reviewer check V4 (npm test) failed with new failures. No task changed it.',
      },
      {
        id: 'V4.5',
        text: 'Reviewer check V4 (npm test) failed with new failures. No task changed it.',
      },
    ],
  },
  {
    scope: 'final',
    cycle: 1,
    outcome: 'fail',
    at: '2026-09-14T14:45:26.000Z',
    blocking: [
      {
        id: 'F3',
        text: 'hiddenFoldWords joins indented display rows without removing their indentation.',
      },
      {
        id: 'F4',
        text: "WorkflowScreen selects the rail using readHeaderSeatLines(), which reads today's crew, before recordedCrewHeader substitutes the recorded crew.",
      },
    ],
  },
  {
    scope: 'final',
    cycle: 2,
    outcome: 'fail',
    at: '2026-09-14T15:19:30.000Z',
    blocking: [
      {
        id: 'V4.1',
        text: "Evidence: V4 output, 'Checkpoint ready-seat-moved-auto was not reached for scenario workflow-ready-seat-moved-auto at 120x40'.",
      },
    ],
  },
];

const CRITERIA: readonly { id: string; text: string }[] = [
  {
    id: 'C1',
    text: 'drift_report is a rowless transcript event: eventRows returns no rows for clean, info, warning, or failed.',
  },
  {
    id: 'C2',
    text: 'isAskedDetail lives in src/core/recovery/headline.ts and createRecoveryIssue preserves the full single-line.',
  },
  {
    id: 'C3',
    text: 'In a one-row free-text planner question panel (bodyHeight === 0), answerWidth is the visible draft cell width.',
  },
  {
    id: 'C4',
    text: 'REPLACED_FILES_SAVED_LEAD is exported from src/core/runtime/commands/messages.ts and clipPromptBodyRows names.',
  },
  {
    id: 'C5',
    text: "formatSeatToolWord formats CLI command names, uncatalogued CLI tool words, API provider ids, 'shell', and.",
  },
  {
    id: 'C6',
    text: 'Docs and CHANGELOG.md reflect all five fixes accurately without internal jargon or process markers, and all.',
  },
];

/** The criterion the review left unverified: its check ran after the review and passed. */
const VERIFIED = {
  criterionId: 'C3',
  check: {
    id: 'E2E-short-question',
    kind: 'test',
    value: 'testing/e2e/scenarios/planner-question-short-panel.test.ts',
  },
} as const;

const NOTE = {
  id: 'R1',
  taskId: 'T004',
  file: 'src/core/runtime/commands/messages.ts',
  text: 'The JSDoc of replacedFilesSavedIn now sits above the new REPLACED_FILES_SAVED_LEAD const, so it documents the wrong symbol. The user sees no change. This is cosmetic code hygiene.',
} as const;

const TIMES = {
  total: 25983389,
  active: 25937044,
  planning: 2001128,
  implementing: 14112411,
  review: 9823505,
} as const;

/** The run starts at AT, completes when its last stage ends, and closes when Apply finished. */
const COMPLETED_AT = new Date(Date.parse(AT) + TIMES.active).toISOString();
const CLOSED_AT = new Date(Date.parse(AT) + TIMES.total).toISOString();

const PLAN_SUMMARY =
  'Make drift_report a rowless transcript event and remove the dead Drift row path, preserve the full planner reason in recovery halts by routing asked.';

function brief(id: string): BriefFact {
  const found = BRIEFS.find((item) => item.id === id);
  if (found === undefined) throw new Error(`No brief ${id} in the fix cycle run`);
  return found;
}

function anchorFile(item: BriefFact): string {
  const file = item.files[0];
  if (file === undefined) throw new Error(`Brief ${item.id} changed no file`);
  return file;
}

export function fixCycleRun(sessionId: string): {
  state: WorkflowState;
  summary: Summary;
  ledger: EvidenceLedger;
} {
  const packetDir = `.splitbrief/sessions/${sessionId}`;
  const state = makeWorkflowState({
    feature: FIX_CYCLE_RUN_FEATURE,
    phase: 'complete',
    currentTaskIndex: BRIEFS.length,
    tasks: BRIEFS.map((item) =>
      makeTask({
        id: item.id,
        title: item.title,
        action: 'modify',
        suggestedFiles: [anchorFile(item)],
        status: 'done',
      }),
    ),
    startedAt: AT,
    completedAt: COMPLETED_AT,
    plannerTool: PLAN_SEAT.tool,
    plannerModel: PLAN_SEAT.model,
    plannerKind: 'cli',
    implementerTool: BUILD_SEAT.tool,
    implementerModel: BUILD_SEAT.model,
    implementerKind: 'cli',
    reviewerTool: PLAN_SEAT.tool,
    reviewerModel: PLAN_SEAT.model,
    reviewerKind: 'cli',
    plan: {
      summary: PLAN_SUMMARY,
      decisions: [],
      criteria: CRITERIA.map((criterion) => ({
        ...criterion,
        checkIds: criterion.id === VERIFIED.criterionId ? [VERIFIED.check.id] : [],
      })),
      checks: [VERIFIED.check],
      validation: null,
    },
    fixCycles: { used: FIX_CYCLES.length, briefed: FIX_CYCLES.length, notes: [] },
    triage: FIX_CYCLES.map((ids, index) => ({
      cycle: index + 1,
      at: AT,
      inputIds: ['F1'],
      result: {
        fixTasks: ids.map((id) => ({
          id: taskId(id),
          title: brief(id).title,
          intent: brief(id).title,
          criteria: [],
          checks: [],
          suggestedFiles: [anchorFile(brief(id))],
          contextFiles: [],
          exclusions: [],
          protectedOperations: null,
          steps: null,
          dependsOn: [],
          batch: 1,
          findingIds: ['F1'],
        })),
        rejected: [],
        ask: null,
      },
    })),
    review: {
      scope: 'final',
      cycle: FIX_CYCLES.length,
      verdict: {
        tasks: [],
        criteria: CRITERIA.map((criterion) => ({
          id: criterion.id,
          status: criterion.id === VERIFIED.criterionId ? 'unverified' : 'pass',
          evidence: '',
        })),
        findings: [
          {
            id: NOTE.id,
            kind: 'defect',
            severity: 'minor',
            taskId: NOTE.taskId,
            file: NOTE.file,
            line: null,
            text: NOTE.text,
            acceptance: null,
            checkIds: null,
            criterionId: null,
          },
        ],
      },
      outcome: 'pass-with-notes',
      verification: [
        {
          id: `criterion:${VERIFIED.criterionId}`,
          status: 'pass',
          output: `${VERIFIED.check.id}: pass`,
        },
      ],
      at: COMPLETED_AT,
    },
    reviewStatus: 'passed',
    applied: { at: CLOSED_AT, backupId: 'fix-cycle-backup', files: [...CHANGED_FILES] },
    closed: { at: CLOSED_AT, as: 'applied' },
  });
  const summary = makeSummary({
    feature: FIX_CYCLE_RUN_FEATURE,
    phase: 'complete',
    totalTasks: BRIEFS.length,
    completedByLocal: BRIEFS.length,
    totalTime: TIMES.total,
    activeTime: TIMES.active,
    phaseTimings: {
      planning: TIMES.planning,
      implementing: TIMES.implementing,
      review: TIMES.review,
    },
    taskBreakdown: BRIEFS.map((item) => ({
      taskId: taskId(item.id),
      taskTitle: item.title,
      method: item.method,
      implementerTokens: 0,
      escalationTokens: 0,
      retryCount: item.retries,
      ...BUILD_SEAT,
    })),
    plannerTool: PLAN_SEAT.tool,
    plannerModel: PLAN_SEAT.model,
    plannerAxes: ['high'],
    implementerTool: BUILD_SEAT.tool,
    implementerModel: BUILD_SEAT.model,
    implementerAxes: ['max'],
    reviewerTool: PLAN_SEAT.tool,
    reviewerModel: PLAN_SEAT.model,
    reviewerAxes: ['high'],
    driftSummary: { passed: true, errorCount: 0, warningCount: 0 },
    reviewPacket: {
      jsonPath: `${packetDir}/review-packet.json`,
      markdownPath: `${packetDir}/review-packet.md`,
      generatedAt: AT,
      finalReviewStatus: 'written',
      finalReviewVerdict: 'pass_with_notes',
      finalReviewFindingCounts: { critical: 0, warning: 1, note: 0 },
      driftPassed: true,
      evidenceValidatedTasks: BRIEFS.length,
      evidenceTotalTasks: BRIEFS.length,
      missingArtifactCount: 0,
    },
    review: { verdict: 'pass_with_notes', critical: 0, warnings: 1, notes: 0 },
    changedFiles: [...CHANGED_FILES],
  });
  const ledger: EvidenceLedger = {
    version: 1,
    sessionId,
    feature: FIX_CYCLE_RUN_FEATURE,
    generatedAt: AT,
    tasks: BRIEFS.map((item) => ({
      id: taskId(item.id),
      title: item.title,
      file: anchorFile(item),
      status: 'done',
      method: item.method,
      retries: item.retries,
      durationMs: item.durationMs,
      changedFiles: [...item.files],
      escalated: false,
    })),
    validationSummary: { passed: BRIEFS.length, failed: 0, skipped: 0, escalated: 0 },
    finalReview: { path: `${packetDir}/review-packet.md`, status: 'written' },
    reviews: [
      ...FAILED_REVIEWS,
      {
        scope: 'final',
        cycle: FIX_CYCLES.length,
        outcome: 'pass-with-notes',
        blocking: [],
        at: COMPLETED_AT,
      },
    ],
  };
  return { state, summary, ledger };
}

const REVIEW_CALL = {
  callId: 'review-4',
  role: 'review',
  backendKind: 'cli',
  runnerName: 'claude',
  model: PLAN_SEAT.model,
} as const;

/** What the review that passed read and ran, in the order the transcript lists it. */
const REVIEW_STEPS = [
  { kind: 'command', label: 'Run', target: 'git diff --stat' },
  { kind: 'read', label: 'Read', target: NOTE.file },
  { kind: 'read', label: 'Read', target: 'src/features/workflow/prompt-body-rows.ts' },
  { kind: 'command', label: 'Run', target: 'npm test' },
  { kind: 'read', label: 'Read', target: 'testing/visual/fixtures/workflow/registry.ts' },
] as const;

/** How long each final review ran: the three that failed, then the one that passed. */
const REVIEW_MS = [963_470, 3_587_243, 174_496, 3_209_313] as const;

/**
 * The session log of the same run, in the order the run wrote it: the planned briefs, each failed
 * review with the fix briefs it got, then the review that passed and the Apply.
 */
export function fixCycleRunLog(): EngineEvent[] {
  const reviewer = { tool: PLAN_SEAT.tool, model: PLAN_SEAT.model, axes: ['high'] };
  const planned = BRIEFS.length - FIX_CYCLES.flat().length;
  const events: EngineEvent[] = [];
  let ts = Date.parse(AT) - TIMES.total;
  events.push({ type: 'workflow_started', ts, phase: 'planning', feature: FIX_CYCLE_RUN_FEATURE });
  ts += TIMES.planning;
  events.push({ type: 'plan_approved', ts, phase: 'planning' });

  const build = (ids: readonly string[], total: number) => {
    for (const id of ids) {
      const item = brief(id);
      events.push({
        type: 'task_started',
        ts,
        phase: 'implementing',
        taskId: taskId(item.id),
        title: item.title,
        file: anchorFile(item),
        action: 'modify',
        index: BRIEFS.indexOf(item),
        total,
        ...BUILD_SEAT,
      });
      ts += item.durationMs;
      events.push({
        type: 'task_completed',
        ts,
        phase: 'implementing',
        taskId: taskId(item.id),
        title: item.title,
        method: item.method,
        retries: item.retries,
        duration: item.durationMs,
        ...BUILD_SEAT,
      });
    }
  };

  build(
    BRIEFS.slice(0, planned).map((item) => item.id),
    planned,
  );
  let built = planned;
  FIX_CYCLES.forEach((ids, cycle) => {
    const failed = FAILED_REVIEWS[cycle];
    const duration = REVIEW_MS[cycle] ?? 0;
    events.push({ type: 'review_started', ts, phase: 'final-review', scope: 'final', ...reviewer });
    ts += duration;
    events.push({
      type: 'review_completed',
      ts,
      phase: 'final-review',
      scope: 'final',
      ...reviewer,
      verdict: 'fail',
      findings: { blocking: failed?.blocking.length ?? 0, minor: 0, outOfScope: 0 },
      blockingFindings: [...(failed?.blocking ?? [])],
      duration,
    });
    events.push({
      type: 'review_fix_started',
      ts,
      phase: 'implementing',
      cycle: cycle + 1,
      taskIds: ids.map((id) => taskId(id)),
    });
    built += ids.length;
    build(ids, built);
  });

  const duration = REVIEW_MS[FIX_CYCLES.length] ?? 0;
  events.push({ type: 'review_started', ts, phase: 'final-review', scope: 'final', ...reviewer });
  events.push({
    type: 'runner_call_started',
    ts: ts + 100,
    phase: 'final-review',
    ...REVIEW_CALL,
    sequence: 0,
  });
  REVIEW_STEPS.forEach((step, index) => {
    events.push({
      type: 'runner_call_activity',
      ts: ts + (index + 1) * 4_000,
      phase: 'final-review',
      ...REVIEW_CALL,
      sequence: index + 1,
      activityId: `${REVIEW_CALL.callId}:tool:${index + 1}`,
      stage: 'completed',
      ...step,
      redacted: false,
    });
  });
  ts += duration;
  events.push({
    type: 'review_completed',
    ts,
    phase: 'final-review',
    scope: 'final',
    ...reviewer,
    verdict: 'pass-with-notes',
    findings: { blocking: 0, minor: 1, outOfScope: 0 },
    duration,
  });
  events.push({
    type: 'workflow_complete',
    ts,
    phase: 'complete',
    review: 'passed',
    completedTasks: BRIEFS.length,
  });
  events.push(
    { type: 'apply_started', ts: ts + 26_000 },
    { type: 'apply_finished', ts: ts + 36_000 },
  );
  return events;
}
