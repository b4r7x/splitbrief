import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { BRIEF_QUALITY_FILE, STATE_FILE } from '../../../../src/core/paths.js';
import type { WorkflowScreenDeps } from '../../../../src/features/workflow/hooks/workflow-screen/use-model.js';
import type { RunWorkflowFn } from '../../../../src/features/workflow/hooks/use-runner.js';
import {
  closeApprovalPrompt,
  openApprovalPrompt,
} from '../../../../src/stores/approval-prompt/prompt.js';
import { routerStore } from '../../../../src/stores/navigation/router.js';
import { lifecycleStore } from '../../../../src/stores/workflow/lifecycle.js';
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
import {
  persistedRecoveryWorkflowState,
  type BriefRecoveryFixtureProjection,
} from './brief-recovery-projections.js';
import type { PersistedBriefRecoveryFixtureProjection } from './persisted-brief-recovery.js';
import { WORKFLOW_FIXTURE_TASK_ID, type WorkflowFixtureProjection } from './projections.js';

type RegisteredWorkflowProjection =
  | WorkflowFixtureProjection
  | BriefRecoveryFixtureProjection
  | PersistedBriefRecoveryFixtureProjection;

function getReviewFilePath(review: NonNullable<WorkflowFixtureProjection['review']>): string {
  return resolve(VISUAL_FIXTURE_PROJECT_DIR, review.filePath);
}

function teardownWorkflowFixture(): void {
  closeApprovalPrompt();
  teardownVisualFixture();
}

function applyProjection(projection: RegisteredWorkflowProjection): void {
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

  if ('recovery' in projection || 'persistedState' in projection) {
    lifecycleStore.__testReset({ phase: 'reviewing-briefs', status: 'running' });
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
  projection: RegisteredWorkflowProjection,
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
  if ('recovery' in projection) {
    const statePath = join(
      VISUAL_FIXTURE_PROJECT_DIR,
      '.splitbrief',
      'sessions',
      'visual-workflow',
      STATE_FILE,
    );
    await writeFile(statePath, JSON.stringify(persistedRecoveryWorkflowState(projection)));
  }
  if ('persistedState' in projection) {
    const sessionDirPath = join(
      VISUAL_FIXTURE_PROJECT_DIR,
      '.splitbrief',
      'sessions',
      'visual-workflow',
    );
    await writeFile(join(sessionDirPath, STATE_FILE), JSON.stringify(projection.persistedState));
    await writeFile(
      join(sessionDirPath, BRIEF_QUALITY_FILE),
      JSON.stringify(projection.legacyQuality),
    );
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
  projection: RegisteredWorkflowProjection,
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
  projection?: RegisteredWorkflowProjection,
): WorkflowScreenDeps {
  const runWorkflow: RunWorkflowFn = (options) => {
    if (projection !== undefined) {
      applyProjection(projection);
      activateFixtureInputMode(projection, options);
    }
    return waitForFixtureAbort(options.signal);
  };
  return {
    runWorkflow,
    ...(projection !== undefined && 'recovery' in projection
      ? { recovery: projection.recovery }
      : {}),
  };
}

export function createWorkflowFixtureFactory(
  projection: RegisteredWorkflowProjection,
): FixtureFactory {
  return () => ({
    setup: (context) => setupProjection(projection, context),
    teardown: teardownWorkflowFixture,
  });
}
