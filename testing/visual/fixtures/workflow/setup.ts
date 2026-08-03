import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
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
import {
  createWorkflowBaseFixture,
  teardownVisualFixture,
  VISUAL_FIXTURE_PROJECT_DIR,
} from '../screen-fixtures.js';
import { WORKFLOW_FIXTURE_TASK_ID, type WorkflowFixtureProjection } from './projections.js';

function getReviewFilePath(review: NonNullable<WorkflowFixtureProjection['review']>): string {
  return join(VISUAL_FIXTURE_PROJECT_DIR, review.filePath);
}

function teardownWorkflowFixture(): void {
  closeApprovalPrompt();
  teardownVisualFixture();
}

function applyProjection(projection: WorkflowFixtureProjection): void {
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
  }

  controlsStore.setSidebar(projection.sidebarVisible);
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
  if (context.scenario.id !== projection.scenarioId) {
    throw new Error(
      `Workflow fixture ${projection.scenarioId} cannot set up scenario ${context.scenario.id}`,
    );
  }
  closeApprovalPrompt();
  await createWorkflowBaseFixture(projection.feature).setup(context);
  if (projection.review !== undefined) {
    const filePath = getReviewFilePath(projection.review);
    await mkdir(dirname(filePath), { recursive: true });
    await writeFile(filePath, projection.review.source);
  }

  if (projection.summary !== undefined) {
    routerStore.init({ screen: 'summary', summary: projection.summary, status: 'complete' });
  } else {
    const route = routerStore.get();
    if (route.screen !== 'workflow') {
      throw new Error(`Workflow fixture ${projection.scenarioId} failed to initialize its route`);
    }
  }

  applyProjection(projection);
}

function activateFixtureInputMode(
  projection: WorkflowFixtureProjection,
  options: Parameters<RunWorkflowFn>[0],
): void {
  if (projection.review !== undefined) {
    void options.callbacks.onApprovalNeeded('briefs', getReviewFilePath(projection.review));
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
