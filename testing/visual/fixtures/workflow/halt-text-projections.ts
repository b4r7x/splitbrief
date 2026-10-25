import type { EngineEvent, EventBus } from '../../../../src/engine/events/types.js';
import { VISUAL_FIXTURE_EPOCH as epoch } from '../common.js';
import { scenarioId } from '../../contracts/identifiers.js';
import type { WorkflowFixtureProjection } from './projections.js';
import { typedOutputError } from '../../../../src/engine/runners/typed-output.js';
import { buildSeatProtocolErrorRecoveryIssue } from '../../../../src/engine/orchestrator/recovery/builders/seat-protocol.js';
import { buildPlannerCallFailedRecoveryIssue } from '../../../../src/engine/orchestrator/recovery/builders/planner.js';
import { diagnosePlannerCallFailure } from '../../../../src/engine/orchestrator/recovery/planner-call-failure.js';
import { reviewSeatDetails } from '../../../../src/engine/orchestrator/recovery/builders/details.js';
import { error } from '../../../../src/utils/error.js';
import { argvPromptTooLarge } from '../../../../src/engine/runners/input-limit.js';
import {
  buildRunnerInputTooLargeRecoveryIssue,
  runnerDefectRow,
} from '../../../../src/engine/orchestrator/recovery/builders/task.js';
import { createEventBus } from '../../../../src/engine/events/bus.js';
import {
  publishError,
  publishRecoveryPrompted,
} from '../../../../src/engine/orchestrator/events.js';
import { makeImplState } from '../../../helpers/factories/workflow-state.js';
import { makeTask } from '../../../helpers/factories/task.js';
import { VISUAL_WORKFLOW_SESSION_ID } from '../screen-fixtures.js';
import type { RecoveryIssue } from '../../../../src/core/schemas/recovery/schemas.js';

function publishedEvents(ts: number, publish: (bus: EventBus) => void): EngineEvent[] {
  const bus = createEventBus();
  const events: EngineEvent[] = [];
  bus.subscribe((event) => events.push(event));
  publish(bus);
  return events.map((event, index) => ({ ...event, ts: ts + index }));
}

const contractError = typedOutputError.seatProtocol({
  seat: 'reviewer',
  attempts: 2,
  transport: 'native',
  errors: [
    'result.checks.0.value: The check command contains a shell operator. Choose a single command.',
    'result.verdict: Required',
  ],
  answerPreview: '',
});

export const reviewContractRecoveryIssue: RecoveryIssue = buildSeatProtocolErrorRecoveryIssue({
  id: 'rec_visual_review_contract',
  error: contractError,
  phase: 'final-review',
  createdAt: new Date(epoch).toISOString(),
});

export const reviewContractErrorMessage: string = contractError.message;

export const reviewContractProjection: WorkflowFixtureProjection = {
  scenarioId: scenarioId('workflow-recovery-review-contract'),
  feature: 'Add a multiply function',
  inputMode: 'question',
  sidebarVisible: false,
  config: { planner: { kind: 'cli', tool: 'claude-code', model: 'sonnet' } },
  get events(): EngineEvent[] {
    return publishedEvents(epoch + 1_000, (bus) => {
      publishError({ bus, phase: 'final-review', message: reviewContractErrorMessage });
      publishRecoveryPrompted(
        { bus, phase: 'final-review' },
        VISUAL_WORKFLOW_SESSION_ID,
        reviewContractRecoveryIssue,
      );
    });
  },
  get resumeState() {
    return makeImplState([makeTask({ id: 'T001', status: 'done' })], {
      feature: 'Add a multiply function',
      startedAt: new Date(epoch).toISOString(),
      phase: 'final-review',
      pendingRecovery: reviewContractRecoveryIssue,
    });
  },
};

const argvOverflow = argvPromptTooLarge(186_486, 120_000);
const argvOverflowError = error('runner-call-failed', 'Planner review call failed', {
  role: 'review',
  status: 'failed',
  error: { code: argvOverflow.kind, message: argvOverflow.message },
});

/** A seat that takes its prompt on the command line, with a fallback that reads it on stdin. */
const ARGV_SEAT = {
  kind: 'cli',
  tool: 'opencode',
  model: 'opencode-go/deepseek-v4.1-flash',
  fallback: { tool: 'codex', model: 'gpt-5-codex' },
} as const;

export const reviewPromptTooLargeRecoveryIssue: RecoveryIssue = buildPlannerCallFailedRecoveryIssue(
  {
    id: 'rec_visual_review_prompt_too_large',
    diagnosis: diagnosePlannerCallFailure({
      seat: 'review',
      err: argvOverflowError,
      label: 'Final review failed',
      runner: ARGV_SEAT,
    }),
    seat: 'review',
    phase: 'final-review',
    runner: ARGV_SEAT,
    details: reviewSeatDetails(true),
    seatSwap: {
      seat: 'review',
      currentTool: 'opencode',
      detectedTools: [
        { tool: 'codex', ready: true },
        { tool: 'claude-code', ready: true },
        { tool: 'opencode', ready: true },
      ],
    },
    createdAt: new Date(epoch).toISOString(),
  },
);

export const reviewPromptTooLargeProjection: WorkflowFixtureProjection = {
  scenarioId: scenarioId('workflow-recovery-review-prompt-too-large'),
  feature: 'Add a multiply function',
  inputMode: 'question',
  sidebarVisible: false,
  config: { planner: ARGV_SEAT },
  get events(): EngineEvent[] {
    return publishedEvents(epoch + 100, (bus) =>
      publishError({
        bus,
        phase: reviewPromptTooLargeRecoveryIssue.phase,
        message: reviewPromptTooLargeRecoveryIssue.message,
        resetAt: reviewPromptTooLargeRecoveryIssue.resetAt ?? undefined,
      }),
    );
  },
  get resumeState() {
    return makeImplState([makeTask({ id: 'T001', status: 'done' })], {
      feature: 'Add a multiply function',
      startedAt: new Date(epoch).toISOString(),
      phase: 'final-review',
      pendingRecovery: reviewPromptTooLargeRecoveryIssue,
    });
  },
};

const buildArgvOverflow = argvPromptTooLarge(195_203, 120_000);

export const buildPromptTooLargeRecoveryIssue: RecoveryIssue =
  buildRunnerInputTooLargeRecoveryIssue({
    id: 'rec_visual_build_prompt_too_large',
    task: makeTask({ id: 'T001', title: 'Add multiply' }),
    phase: 'implementing',
    runner: ARGV_SEAT,
    toolMessage: buildArgvOverflow.message,
    attempts: 1,
    maxAttempts: 8,
    seatSwap: {
      seat: 'build',
      currentTool: 'opencode',
      detectedTools: [
        { tool: 'opencode', ready: true },
        { tool: 'claude-code', ready: true },
        { tool: 'codex', ready: true },
      ],
    },
    createdAt: new Date(epoch).toISOString(),
  });

export const buildPromptTooLargeProjection: WorkflowFixtureProjection = {
  scenarioId: scenarioId('workflow-recovery-build-prompt-too-large'),
  feature: 'Add a multiply function',
  inputMode: 'question',
  sidebarVisible: false,
  config: { implementer: ARGV_SEAT },
  get events(): EngineEvent[] {
    return publishedEvents(epoch + 100, (bus) =>
      publishError({
        bus,
        phase: buildPromptTooLargeRecoveryIssue.phase,
        message: runnerDefectRow(
          buildPromptTooLargeRecoveryIssue,
          'OpenCode CLI',
          buildArgvOverflow.message,
        ),
      }),
    );
  },
  get resumeState() {
    return makeImplState([makeTask({ id: 'T001', title: 'Add multiply' })], {
      feature: 'Add a multiply function',
      startedAt: new Date(epoch).toISOString(),
      phase: 'implementing',
      pendingRecovery: buildPromptTooLargeRecoveryIssue,
    });
  },
};
