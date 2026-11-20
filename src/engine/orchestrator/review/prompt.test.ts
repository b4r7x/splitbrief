import { expect, it, onTestFinished } from 'vitest';
import { makeConfig } from '#testing/helpers/factories/config.js';
import { makeWorkflowState } from '#testing/helpers/factories/workflow-state.js';
import { makeBusRecorder } from '#testing/helpers/orchestrator-factories.js';
import { createTempDir, cleanupTempDir } from '#testing/helpers/temp-dir.js';
import { reviewScopeFor } from '../../../core/review/scope.js';
import { ensureSessionDir } from '../../../core/sessions/spec-files.js';
import { cliPromptLimit } from '../../runners/cli-tools/registry.js';
import { buildStageContext } from '../validation/run.js';
import { reviewPlanData } from './plan.js';
import { prepareReviewCall } from './prompt.js';
import { reviewRenders } from './renders.js';

it('names the reviewer once when its check log exceeds the prompt limit', async () => {
  const projectDir = createTempDir('review-trim');
  onTestFinished(() => cleanupTempDir(projectDir));
  const sessionId = 'trim';
  ensureSessionDir(projectDir, sessionId);
  const state = makeWorkflowState({ phase: 'final-review' });
  const { bus, events } = makeBusRecorder();
  const limit = cliPromptLimit('planner', 'codex');
  if (limit === undefined) throw new Error('Expected a Codex prompt limit.');
  const { prompt } = await prepareReviewCall(
    {
      projectDir,
      workspaceDir: projectDir,
      sessionId,
      bus,
      signal: undefined,
      runner: { kind: 'cli', tool: 'codex' },
      cadence: 'final',
      live: { get: () => state, set: () => {} },
      setTrackedState: undefined,
      integration: undefined,
      skillsContext: undefined,
      reviewedBeforeStart: new Set(),
      sent: { text: '', suffix: '', reviewInput: undefined, tooLarge: undefined },
      bounds: {
        baseline: { head: null, fingerprints: {}, runStartChangedFiles: [] },
        universe: { fullDiff: '', changedFiles: [], preRunFiles: [], setupFiles: [] },
        userFiles: new Set(),
        scope: reviewScopeFor(state, 'final'),
        reviewScope: {
          files: [],
          laterDiff: '',
          workspaceContext: [],
          description: '',
          provenance: {
            path: 'changes',
            status: 'available',
            promotedFiles: [],
            workspaceFiles: [],
            uncertainFiles: [],
            preRunFiles: [],
            setupFiles: [],
          },
        },
      },
      inputs: {
        spec: 'Check the greeting.',
        taskBriefs: '',
        plan: reviewPlanData(state),
        testChecks: buildStageContext({
          projectDir,
          config: makeConfig(),
          discoveredValidation: undefined,
          notices: { bus, phase: state.phase },
        }),
        evidencePaths: {
          validation: 'evidence.json',
          sessionLog: 'session.jsonl',
          drift: 'drift-report.json',
        },
        checksLog: 'x'.repeat(limit.max),
        wholeChecksLog: undefined,
        driftPromptSection: undefined,
        renders: reviewRenders({
          ledger: null,
          registry: new Map(),
          projectDir,
          seatSupportsImages: false,
          currentCandidateId: undefined,
        }),
        reviewChecksSection: undefined,
        preExistingChecks: [],
        seatTakesImages: false,
        touchedNotSuggested: [],
        checkIds: [],
        checkResults: '',
        consultLog: '',
        triageLog: '',
        pendingInputs: [],
        fixCycle: 1,
        writesFiles: 'direct',
        planningAnswers: '',
        operatorInstructions: '',
      },
    },
    [],
  );
  prompt('');
  prompt('');
  expect(events.flatMap((event) => (event.type === 'warning' ? [event.message] : []))).toEqual([
    'Review input trimmed to fit OpenAI Codex CLI',
  ]);
});
