import type { EngineEvent, EventBus } from '../../../../src/engine/events/types.js';
import { VISUAL_FIXTURE_EPOCH as epoch } from '../common.js';
import { scenarioId } from '../../contracts/identifiers.js';
import type { WorkflowFixtureProjection } from './projections.js';
import { typedOutputError } from '../../../../src/engine/runners/typed-output.js';
import { buildSeatProtocolErrorRecoveryIssue } from '../../../../src/engine/orchestrator/recovery/builders/seat-protocol.js';
import { buildReviewInputTooLargeRecoveryIssue } from '../../../../src/engine/orchestrator/recovery/builders/review-input.js';
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

/** Codex's own refusal of a prompt over its input limit, as the tool prints it. */
export const CODEX_INPUT_TOO_LARGE =
  'Error: turn/start: turn/start failed: Input exceeds the maximum length of 1048576 characters. (code -32602), data: {"input_error_code":"input_too_large","max_chars":1048576,"actual_chars":1106026}';

/** A seat on the one tool with an input limit, with a fallback that has none. */
const CODEX_SEAT = {
  kind: 'cli',
  tool: 'codex',
  model: 'gpt-5-codex',
  fallback: { tool: 'claude-code' },
} as const;

export const reviewPromptTooLargeRecoveryIssue: RecoveryIssue =
  buildReviewInputTooLargeRecoveryIssue({
    id: 'rec_visual_review_prompt_too_large',
    phase: 'final-review',
    failure: {
      kind: 'input-too-large',
      figures: { unit: 'characters', size: 1_106_026, limit: 1_048_576 },
      promptSize: { characters: 1_106_026 },
      largestFiles: [
        { path: 'src/generated/schema.ts', chars: 812_400 },
        { path: 'src/math.ts', chars: 4_210 },
      ],
    },
    tool: 'OpenAI Codex CLI',
    acceptAsIs: true,
    seatSwap: {
      seat: 'review',
      currentTool: 'codex',
      detectedTools: [
        { tool: 'codex', ready: true },
        { tool: 'claude-code', ready: true },
        { tool: 'opencode', ready: true },
      ],
    },
    createdAt: new Date(epoch).toISOString(),
  });

export const reviewPromptTooLargeProjection: WorkflowFixtureProjection = {
  scenarioId: scenarioId('workflow-recovery-review-prompt-too-large'),
  feature: 'Add a multiply function',
  inputMode: 'question',
  sidebarVisible: false,
  config: { planner: CODEX_SEAT },
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

export const buildPromptTooLargeRecoveryIssue: RecoveryIssue =
  buildRunnerInputTooLargeRecoveryIssue({
    id: 'rec_visual_build_prompt_too_large',
    task: makeTask({ id: 'T001', title: 'Add multiply' }),
    phase: 'implementing',
    runner: CODEX_SEAT,
    toolMessage: CODEX_INPUT_TOO_LARGE,
    attempts: 1,
    maxAttempts: 8,
    seatSwap: {
      seat: 'build',
      currentTool: 'codex',
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
  config: { implementer: CODEX_SEAT },
  get events(): EngineEvent[] {
    return publishedEvents(epoch + 100, (bus) =>
      publishError({
        bus,
        phase: buildPromptTooLargeRecoveryIssue.phase,
        message: runnerDefectRow(
          buildPromptTooLargeRecoveryIssue,
          'OpenAI Codex CLI',
          CODEX_INPUT_TOO_LARGE,
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
