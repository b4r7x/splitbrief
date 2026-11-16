import { VISUAL_FIXTURE_EPOCH } from '../common.js';
import { scenarioId } from '../../contracts/identifiers.js';
import type { WorkflowFixtureProjection } from './projections.js';

const FEATURE = 'Refine the lockfile writer';

// The plan is in review, a phase that takes no queued words, and a runner-trust gate opens over a
// correction the composer keeps. The fixture types the words and opens the gate after mount.
export const approvalWordsStayProjection: WorkflowFixtureProjection = {
  scenarioId: scenarioId('workflow-approval-confirm-words-stay'),
  feature: FEATURE,
  inputMode: 'normal',
  sidebarVisible: false,
  approvalAfterMount: {
    actionClass: 'runner_trust',
    actionDescription: 'Executable: "tools/review-bot"\nArguments: "--diff"',
  },
  events: [
    {
      type: 'workflow_started',
      ts: VISUAL_FIXTURE_EPOCH,
      phase: 'reviewing-plan',
      feature: FEATURE,
    },
    {
      type: 'planner_text',
      ts: VISUAL_FIXTURE_EPOCH + 100,
      phase: 'reviewing-plan',
      role: 'planner',
      content: 'plain',
      text: 'The plan is ready to review.',
    },
  ],
};

// The same gate after Tab gives it the keys: a typed word and ⏎ name no row, so it asks for one.
export const approvalWordNudgeProjection: WorkflowFixtureProjection = {
  ...approvalWordsStayProjection,
  scenarioId: scenarioId('workflow-approval-confirm-word-nudge'),
};
