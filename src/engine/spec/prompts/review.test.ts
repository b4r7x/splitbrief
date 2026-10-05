import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, it, expect } from 'vitest';
import { makeNoValidationConfig } from '#testing/helpers/factories/config.js';
import { makeTask } from '#testing/helpers/factories/task.js';
import { makeImplState } from '#testing/helpers/factories/workflow-state.js';
import { createTestGitRepo } from '#testing/helpers/git.js';
import {
  makePlanner,
  makeBusRecorder,
  makeCallbacks,
} from '#testing/helpers/orchestrator-factories.js';
import { setupProject } from '#testing/helpers/planning-phase.js';
import { cleanupTempDir, createTempDir } from '#testing/helpers/temp-dir.js';
import {
  planFromTasks,
  passingReviewVerdict,
  typedCallPlanAndReview,
} from '#testing/helpers/typed-planner.js';
import { REVIEW_FILE, sessionDir } from '../../../core/paths.js';
import { getChangedFilesSnapshot } from '../../orchestrator/approval/file-snapshots/capture.js';
import { runFinalReviewPhase } from '../../orchestrator/final-review.js';
import { buildFinalReviewPrompt } from './review.js';

const SPEC = '## Spec\nAdd a hello function.';
const TASK_BRIEFS = '## Task T001\nAdd the hello export.';
const DIFF = '+export function hello() { return "hello"; }';
const dirs: string[] = [];

afterEach(() => {
  for (const dir of dirs.splice(0)) cleanupTempDir(dir);
});

describe('buildFinalReviewPrompt', () => {
  it('carries the plan, one diff per file with its tasks, the touched-not-suggested files, the check results, the consult log and the user answers', () => {
    const result = buildFinalReviewPrompt({
      spec: SPEC,
      taskBriefs: TASK_BRIEFS,
      diff: DIFF,
      files: [
        {
          path: 'src/hello.ts',
          taskIds: ['T001'],
          diff: '+export function hello() { return "hello"; }',
        },
      ],
      laterDiff: '+export const operatorFix = true;',
      workspaceContext: [
        { path: 'src/tool-fix.ts', taskIds: [], diff: '+export const independentFix = true;' },
      ],
      plan: {
        criteria: [{ id: 'C1', text: 'The greeting is returned', checkIds: ['K1'] }],
        decisions: [{ text: 'Keep the greeting pure', taskId: 'T001' }],
        tasks: [
          {
            id: 'T001',
            title: 'Hello module',
            intent: 'Add the hello export',
            criteria: ['C1'],
            suggestedFiles: ['src/hello.ts'],
            exclusions: ['docs/**'],
          },
        ],
      },
      touchedNotSuggested: [{ taskId: 'T001', files: ['src/shared.ts'] }],
      checkResults: '- T001 check K1: pass',
      consultLog: '- 2026-01-01T00:00:00.000Z T001: failing → guidance: try another approach',
      triageLog: '- F2: already fixed',
      planningAnswers: '- Which greeting? → hello',
      taskIds: ['T001'],
      criterionIds: ['C1'],
    });

    expect(result).toContain('## Plan');
    expect(result).toContain('C1: The greeting is returned (checks: K1)');
    expect(result).toContain('T001 Hello module: Add the hello export');
    expect(result).toContain('Suggested files: src/hello.ts');
    expect(result).toContain('Exclusions: docs/**');
    expect(result).toContain('### Decisions');
    expect(result).toContain('- Keep the greeting pure (T001)');
    expect(result).toContain('## Implementation Diff');
    expect(result).toContain('### src/hello.ts — T001');
    expect(result).toContain(
      '### Changes after the last recorded task completion; authorship unknown',
    );
    expect(result.split('## Workspace Context')[1]).toContain(
      '+export const independentFix = true;',
    );
    expect(result.split('+export function hello() { return "hello"; }')).toHaveLength(2);
    expect(result).toContain('## Touched, Not Suggested');
    expect(result).toContain('src/shared.ts');
    expect(result).toContain('## Recorded Check Results');
    expect(result).toContain('T001 check K1: pass');
    expect(result).toContain('## Consult Log');
    expect(result).toContain('try another approach');
    expect(result).toContain('## Triage Log');
    expect(result).toContain('## Planning Answers');
    expect(result).toContain('- Which greeting? → hello');
  });

  it('states the required result ids, and none when the caller names none', () => {
    const named = buildFinalReviewPrompt({
      spec: SPEC,
      taskBriefs: TASK_BRIEFS,
      diff: DIFF,
      plan: {
        criteria: [{ id: 'C1', text: 'The greeting is returned', checkIds: [] }],
        tasks: [],
      },
    });
    expect(named).toContain('## Required Results');
    expect(named).toContain('Task ids: none');
    expect(named).toContain('Criterion ids: C1');

    const bare = buildFinalReviewPrompt({ spec: SPEC, taskBriefs: TASK_BRIEFS, diff: DIFF });
    expect(bare).toContain('Task ids: none');
    expect(bare).toContain('Criterion ids: none');
    expect(bare).toContain('one result per listed id');
    expect(bare).toContain(
      'Every task not met and every failed criterion needs a blocking finding naming it.',
    );
    expect(bare).toContain(
      'Mark a criterion unverified when no recorded evidence proves it, and name its checkIds.',
    );
    expect(bare).toContain(
      'Verify a render only when its current-candidate images are attached and you critique the scenario.',
    );
    expect(bare).not.toContain('Never claim a render was verified.');
  });

  it('drops the containment sentence that made a missing render at most a Note', () => {
    const result = buildFinalReviewPrompt({ spec: SPEC, taskBriefs: TASK_BRIEFS, diff: DIFF });

    expect(result).not.toContain('A **Critical** finding must name a defect');
    expect(result).not.toContain('an evidence gap alone never causes `fail`');
    expect(result).not.toContain('Write `None.` after the label of a category with no findings');
  });

  it('dispatches the workspace directory instruction and keeps review records in the checkout', async () => {
    const { projectDir, sessionId } = setupProject(dirs);
    const workspaceDir = createTempDir('review-workspace');
    dirs.push(workspaceDir);
    createTestGitRepo(projectDir);
    createTestGitRepo(workspaceDir);
    const baseline = await getChangedFilesSnapshot(workspaceDir);
    const state = {
      ...makeImplState([makeTask({ status: 'done' })]),
      changedFilesBaseline: { head: baseline.head, fingerprints: {}, runStartChangedFiles: [] },
    };
    const prompts: string[] = [];
    const reviewer = makePlanner({
      typedCall: typedCallPlanAndReview(
        () => planFromTasks([]),
        (prompt) => {
          prompts.push(prompt);
          return passingReviewVerdict(prompt);
        },
      ),
    });
    const result = await runFinalReviewPhase({
      projectDir,
      workspaceDir,
      sessionId,
      config: makeNoValidationConfig(),
      callbacks: makeCallbacks().callbacks,
      bus: makeBusRecorder().bus,
      state,
      reviewer,
      summaryBase: {
        feature: 'review workspace',
        startTime: Date.now(),
        plannerTool: 'claude-code',
        implementerTool: 'ollama',
      },
      taskBreakdowns: [],
    });

    expect(result.reviewStatus).toBe('written');
    expect(prompts[0]).toContain(`The run workspace is \`${workspaceDir}\`.`);
    expect(prompts[0]).toContain('Read project files from this directory');
    expect(existsSync(join(sessionDir(projectDir, sessionId), REVIEW_FILE))).toBe(true);
    expect(existsSync(join(workspaceDir, '.splitbrief'))).toBe(false);
  });

  it('returns a string without a drift section when driftReport is omitted', () => {
    const result = buildFinalReviewPrompt({ spec: SPEC, taskBriefs: TASK_BRIEFS, diff: DIFF });
    expect(result).not.toContain('Deterministic Drift Report');
    expect(result).toContain('## Task Briefs');
    expect(result).toContain(TASK_BRIEFS);
    expect(result).toContain(
      'Treat error-level drift findings as review blockers unless you can clearly explain why they are false positives.',
    );
  });

  it('includes a drift section heading and content when driftReport is provided', () => {
    const driftSection = 'DRIFT: missing export in src/foo.ts';
    const result = buildFinalReviewPrompt({
      spec: SPEC,
      taskBriefs: TASK_BRIEFS,
      diff: DIFF,
      driftReport: driftSection,
    });
    expect(result).toContain('## Deterministic Drift Report');
    expect(result).toContain(driftSection);
  });

  it('includes the checks log verbatim and binds validation claims to it', () => {
    const evidence =
      '- test T001 (exit 0): npm test\n  output: Tests  4 passed (4)\n  snapshot: candidate-1';
    const result = buildFinalReviewPrompt({
      spec: SPEC,
      taskBriefs: TASK_BRIEFS,
      diff: DIFF,
      checksLog: evidence,
    });
    expect(result).toContain('## Checks Log');
    expect(result).toContain(
      'The orchestrator ran these validation commands and recorded their output.',
    );
    expect(result).toContain('Tests  4 passed (4)');
    expect(result).toContain('quote the relevant line verbatim from the Checks Log section');
    expect(result).toContain('never report counts or totals that do not appear there');
  });

  it('still instructs how to handle missing validation evidence when none is provided', () => {
    const result = buildFinalReviewPrompt({ spec: SPEC, taskBriefs: TASK_BRIEFS, diff: DIFF });
    expect(result).not.toContain('## Checks Log');
    expect(result).toContain(
      'state that validation output was not recorded instead of asserting results',
    );
  });

  it('includes a 200,000-character diff with its final line and without truncation marker', () => {
    const finalLine = '+last line of 200k diff';
    const diff = `${'x'.repeat(200_000 - finalLine.length - 1)}\n${finalLine}`;
    const result = buildFinalReviewPrompt({ spec: SPEC, taskBriefs: TASK_BRIEFS, diff });
    expect(result).toContain(finalLine);
    expect(result).not.toContain('diff truncated');
  });

  it('contains a 500-character diff verbatim', () => {
    const diff = '+'.repeat(500);
    const result = buildFinalReviewPrompt({ spec: SPEC, taskBriefs: TASK_BRIEFS, diff });
    expect(result).toContain(diff);
  });
});
