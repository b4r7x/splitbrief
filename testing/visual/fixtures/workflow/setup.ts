import type { WorkflowScreenDeps } from '../../../../src/features/workflow/hooks/workflow-screen/use-model.js';
import type { RunWorkflowFn } from '../../../../src/features/workflow/hooks/use-runner.js';
import {
  closeApprovalPrompt,
  openApprovalPrompt,
} from '../../../../src/stores/approval-prompt/prompt.js';
import { routerStore } from '../../../../src/stores/navigation/router.js';
import { questionPromptStore } from '../../../../src/stores/question-prompt/prompt.js';
import { controlsStore } from '../../../../src/stores/ui/controls.js';
import { addEvent } from '../../../../src/stores/workflow/actions/event.js';
import { reviewStore } from '../../../../src/stores/workflow/review.js';
import { streamingOutputStore } from '../../../../src/stores/workflow/streaming-output.js';
import type { FixtureContext, FixtureFactory } from '../common.js';
import { createWorkflowBaseFixture, teardownVisualFixture } from '../screen-fixtures.js';
import { WORKFLOW_FIXTURE_TASK_ID, type WorkflowFixtureProjection } from './projections.js';

function teardownWorkflowFixture(): void {
  closeApprovalPrompt();
  teardownVisualFixture();
}

function assertFixtureContext(
  projection: WorkflowFixtureProjection,
  context: FixtureContext,
): void {
  if (context.scenario.id !== projection.scenarioId) {
    throw new Error(
      `Workflow fixture ${projection.scenarioId} cannot set up scenario ${context.scenario.id}`,
    );
  }
}

function applyProjection(projection: WorkflowFixtureProjection): void {
  for (const event of projection.events) addEvent(event);

  if (projection.streaming !== undefined) {
    streamingOutputStore.startStreaming(WORKFLOW_FIXTURE_TASK_ID);
    streamingOutputStore.replaceLines([...projection.streaming.lines]);
  }

  if (projection.review !== undefined) {
    reviewStore.setReviewFile(projection.review.filePath);
    reviewStore.setBriefSources([projection.review.source]);
    reviewStore.setBriefPaths([projection.review.filePath]);
  }

  if (projection.question !== undefined) {
    questionPromptStore.setHint(projection.question.prompt);
  }

  controlsStore.setInputMode(projection.inputMode);

  if (projection.approval !== undefined) {
    void openApprovalPrompt({
      tier: 'sticky',
      actionClass: 'write_out_of_scope',
      actionDescription: projection.approval.actionDescription,
      taskId: WORKFLOW_FIXTURE_TASK_ID,
      phase: 'reviewing-plan',
    });
  }
}

async function setupProjection(
  projection: WorkflowFixtureProjection,
  context: FixtureContext,
): Promise<void> {
  assertFixtureContext(projection, context);
  closeApprovalPrompt();
  await createWorkflowBaseFixture().setup(context);

  if (projection.summary !== undefined) {
    routerStore.init({ screen: 'summary', summary: projection.summary, status: 'complete' });
  } else {
    const route = routerStore.get();
    if (route.screen !== 'workflow') {
      throw new Error(`Workflow fixture ${projection.scenarioId} failed to initialize its route`);
    }
    routerStore.init({
      screen: 'workflow',
      feature: projection.feature,
      readiness: route.readiness,
    });
  }

  applyProjection(projection);
}

function activateFixtureInputMode(
  projection: WorkflowFixtureProjection,
  options: Parameters<RunWorkflowFn>[0],
): void {
  if (projection.review !== undefined) {
    void options.callbacks.onApprovalNeeded('briefs', projection.review.filePath);
  }
  if (projection.question !== undefined) {
    void options.callbacks.onQuestionAsked?.(
      { id: 'visual-question', type: 'input', text: projection.question.prompt },
      1,
      1,
    );
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

export function createWorkflowFixtureAppDeps(
  projection?: WorkflowFixtureProjection,
): WorkflowScreenDeps {
  const runWorkflow: RunWorkflowFn = (options) => {
    if (projection !== undefined) {
      applyProjection(projection);
      activateFixtureInputMode(projection, options);
    }
    return waitForFixtureAbort(options.signal);
  };
  return { runWorkflow };
}

export function createWorkflowFixtureFactory(
  projection: WorkflowFixtureProjection,
): FixtureFactory {
  return () => ({
    setup: (context) => setupProjection(projection, context),
    teardown: teardownWorkflowFixture,
  });
}
