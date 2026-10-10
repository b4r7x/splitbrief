import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { toEngineEventEntry } from '../../../../src/core/sessions/log-writer.js';
import { cliDetectionFor } from '../../../helpers/factories/detection.js';
import type { WorkflowScreenDeps } from '../../../../src/features/workflow/hooks/workflow-screen/use-model.js';
import type { RunWorkflowFn } from '../../../../src/features/workflow/hooks/use-run-loop.js';
import type { ReviewInputEffects } from '../../../../src/features/workflow/review-parser.js';
import type { SessionSelectDeps } from '../../../../src/stores/navigation/session-select.js';
import { feedbackStore } from '../../../../src/stores/ui/feedback.js';
import {
  closeApprovalPrompt,
  openApprovalPrompt,
} from '../../../../src/stores/approval-prompt/prompt.js';
import {
  closeReviewChecksPrompt,
  openReviewChecksPrompt,
} from '../../../../src/stores/review-checks-prompt/prompt.js';
import { routerStore } from '../../../../src/stores/navigation/router.js';
import { questionPromptStore } from '../../../../src/stores/question-prompt/prompt.js';
import { controlsStore } from '../../../../src/stores/ui/controls.js';
import { addEvent } from '../../../../src/stores/workflow/actions/event.js';
import { createEventBus } from '../../../../src/engine/events/bus.js';
import { publishUserMessage } from '../../../../src/engine/orchestrator/events.js';
import { consultReplyAnswer } from '../../../../src/engine/orchestrator/consult/apply.js';
import { reviewStore } from '../../../../src/stores/workflow/review.js';
import { streamingOutputStore } from '../../../../src/stores/workflow/streaming-output.js';
import { PLAN_JSON_FILE, SESSION_LOG_FILE, sessionDir } from '../../../../src/core/paths.js';
import { plainUserMessage } from '../../../../src/core/types/user-input.js';
import { hydrateRun } from '../../../../src/features/workflow/run-history.js';
import { PREVIEW_UNAVAILABLE, type FixtureContext, type FixtureFactory } from '../common.js';
import {
  createWorkflowBaseFixture,
  teardownVisualFixture,
  VISUAL_FIXTURE_PROJECT_DIR,
  publishVisualDiscovery,
} from '../screen-fixtures.js';
import {
  WORKFLOW_FIXTURE_TASK_ID,
  type FixtureAtRestRoute,
  type WorkflowFixtureProjection,
} from './projections.js';

function getReviewFilePath(review: NonNullable<WorkflowFixtureProjection['review']>): string {
  return resolve(VISUAL_FIXTURE_PROJECT_DIR, review.filePath);
}

function teardownWorkflowFixture(): void {
  closeApprovalPrompt();
  closeReviewChecksPrompt();
  teardownVisualFixture();
}

function applyProjection(projection: WorkflowFixtureProjection): void {
  if (projection.cliModels !== undefined) {
    publishVisualDiscovery({
      cliTools: projection.cliModels.map(({ connection }) =>
        cliDetectionFor('ready', connection.tool),
      ),
      cliModels: projection.cliModels,
    });
  }
  for (const event of projection.events) addEvent(event);

  if (projection.streaming !== undefined) {
    streamingOutputStore.startStreaming(WORKFLOW_FIXTURE_TASK_ID);
    streamingOutputStore.replaceLines([...projection.streaming.lines]);
  }

  if (projection.review !== undefined) {
    const filePath = getReviewFilePath(projection.review);
    reviewStore.setReviewFile(filePath);
    reviewStore.setBriefSources([projection.review.source]);
    reviewStore.setBriefPaths([filePath]);
  }

  if (projection.question !== undefined) {
    questionPromptStore.setHint(projection.question.prompt);
    if (projection.question.questions !== undefined) {
      questionPromptStore.setQuestions(projection.question.questions);
    }
  }

  controlsStore.setSidebar(projection.sidebarVisible);
  controlsStore.setInputMode(projection.inputMode);

  if (projection.approval !== undefined) {
    void openApprovalPrompt({
      tier: 'confirm',
      actionClass: projection.approval.actionClass ?? 'package_change',
      actionDescription: projection.approval.actionDescription,
      taskId: WORKFLOW_FIXTURE_TASK_ID,
      phase: 'reviewing-plan',
    });
  }

  if (projection.reviewChecksPrompt !== undefined) {
    void openReviewChecksPrompt(projection.reviewChecksPrompt);
  }
}

async function setupProjection(
  projection: WorkflowFixtureProjection,
  context: FixtureContext,
): Promise<void> {
  if (context.scenario.id !== projection.scenarioId) {
    throw new Error(
      `Workflow fixture ${projection.scenarioId} cannot set up scenario ${context.scenario.id}`,
    );
  }
  closeApprovalPrompt();
  closeReviewChecksPrompt();
  await createWorkflowBaseFixture(
    projection.feature,
    projection.resumeState,
    projection.config,
  ).setup(context);
  if (projection.review !== undefined) {
    const filePath = getReviewFilePath(projection.review);
    await mkdir(dirname(filePath), { recursive: true });
    await writeFile(filePath, projection.review.source);
    if (projection.review.planJson !== undefined) {
      await writeFile(join(dirname(filePath), PLAN_JSON_FILE), projection.review.planJson);
    }
  }
  const route = routerStore.get();
  if (route.screen !== 'workflow') {
    throw new Error(`Workflow fixture ${projection.scenarioId} failed to initialize its route`);
  }
  if (projection.atRest !== undefined) {
    // A run at rest is the same screen with no process behind it: its transcript is whatever its
    // log replays, and the route carries the record the closed block and the byline read.
    await seedRunLog(projection.atRest);
    await hydrateRun(projection.atRest.record);
    controlsStore.setSidebar(projection.sidebarVisible);
    controlsStore.setInputMode(projection.inputMode);
    routerStore.navigate({
      to: 'workflow',
      run: projection.atRest.record,
      execution: { kind: 'at-rest' },
    });
    return;
  }

  applyProjection(projection);
}

/** The replay reads the session log from disk, so a scenario about the replay writes one first. */
async function seedRunLog(route: FixtureAtRestRoute): Promise<void> {
  if (route.log === undefined) return;
  const target = join(
    sessionDir(route.record.ref.projectDir, route.record.ref.sessionId),
    SESSION_LOG_FILE,
  );
  await mkdir(dirname(target), { recursive: true });
  const content =
    typeof route.log === 'string'
      ? await readFile(resolve(process.cwd(), route.log), 'utf8')
      : route.log.map((event) => `${JSON.stringify(toEngineEventEntry(event))}\n`).join('');
  await writeFile(target, content);
}

async function activateFixtureInputMode(
  projection: WorkflowFixtureProjection,
  options: Parameters<RunWorkflowFn>[0],
): Promise<void> {
  if (projection.review !== undefined) {
    void options.callbacks.onApprovalNeeded(
      'plan',
      getReviewFilePath(projection.review),
      projection.review.confirms ?? [],
    );
  }
  // A halt is not a planner conversation: the recovery driver sets question mode with the prompt
  // itself, so only the fixture's explicit question scenario needs this callback.
  if (projection.question !== undefined) {
    const answer = await options.callbacks.onPlannerReply?.({
      call: 'research',
      ...(projection.question.seat !== undefined && { seat: projection.question.seat }),
      text: '',
      questions:
        projection.question.questions === undefined
          ? [{ id: 'visual-question', type: 'input', text: projection.question.prompt }]
          : [...projection.question.questions],
      answers: [],
      answered: false,
    });
    if (
      projection.scenarioId === 'workflow-consult-answer-default' ||
      projection.scenarioId === 'workflow-consult-answer-typed'
    ) {
      if (answer === undefined) throw new Error('Consult fixture requires an answer');
      const question = projection.question.questions?.[0];
      if (question === undefined) throw new Error('Consult fixture requires a question');
      const reply = consultReplyAnswer(question, answer);
      const bus = createEventBus();
      bus.subscribe(addEvent);
      publishUserMessage({ bus, phase: 'escalating' }, reply.message.displayText, {
        qa: reply.qa,
        attachedInputs: reply.message.attachedInputs,
      });
      const consultCall = projection.events.find((event) => event.type === 'runner_call_started');
      if (consultCall === undefined) throw new Error('Consult fixture requires a planner call');
      bus.publish({
        ...consultCall,
        callId: 'visual-consult-answer-call-001',
        ts: Date.now(),
        sequence: 0,
      });
    }
  }
}

function waitForFixtureAbort(signal?: AbortSignal): Promise<never> {
  return new Promise<never>((_resolve, reject) => {
    if (signal === undefined) return;
    if (signal.aborted) {
      reject(signal.reason);
      return;
    }
    signal.addEventListener('abort', () => reject(signal.reason), { once: true });
  });
}

/**
 * The two effects live review input spends outside the stores. Neither can reach a process: the
 * editor route answers on the feedback line the operator is already reading, and there is no
 * planner behind a fixture to queue a message into.
 */
const fixtureReviewInput: ReviewInputEffects = {
  openExternalEditor: async () => feedbackStore.setMessage(PREVIEW_UNAVAILABLE),
  enqueue: async () => null,
};

/**
 * Every effect the run screen can reach: the run itself, the continuation a run at rest prepares
 * and the two live-input effects. A caller that has one supplies its own `sessionSelect` so home,
 * the sessions overlay and the screen all continue a run through the same object; without one the
 * screen keeps the production composition root it already fell back to.
 */
export function createWorkflowFixtureAppDeps(
  projection?: WorkflowFixtureProjection,
  sessionSelect?: SessionSelectDeps,
): WorkflowScreenDeps {
  const runWorkflow: RunWorkflowFn = async (options) => {
    if (projection !== undefined) {
      applyProjection(projection);
      await activateFixtureInputMode(projection, options);
    }
    return waitForFixtureAbort(options.signal);
  };
  return {
    runWorkflow,
    reviewInput: fixtureReviewInput,
    ...(sessionSelect !== undefined && { sessionSelect }),
  };
}

export function createWorkflowFixtureFactory(
  projection: WorkflowFixtureProjection,
): FixtureFactory {
  return () => ({
    setup: (context) => setupProjection(projection, context),
    teardown: teardownWorkflowFixture,
    ...(projection.questionPreview === 'overflow-back' && {
      afterMount: () => {
        const questions = projection.question?.questions;
        const first = questions?.[0];
        const second = questions?.[1];
        if (first?.type !== 'choice' || second?.type !== 'choice') {
          throw new Error('Question overflow fixture requires two choices');
        }
        const firstAnswer = first.options[0];
        const longAnswer = second.options[2];
        if (firstAnswer === undefined || longAnswer === undefined) {
          throw new Error('Question overflow fixture is missing its answers');
        }
        questionPromptStore.answer(plainUserMessage(firstAnswer));
        questionPromptStore.select(2);
        questionPromptStore.answer(plainUserMessage(longAnswer));
        questionPromptStore.previous();
      },
    }),
  });
}
