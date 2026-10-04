import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, it, expect, vi } from 'vitest';
import { makeNoValidationConfig } from '#testing/helpers/factories/config.js';
import { makeTask } from '#testing/helpers/factories/task.js';
import { makeImplState } from '#testing/helpers/factories/workflow-state.js';
import { createTestGitRepo } from '#testing/helpers/git.js';
import { makeBusRecorder, makeCallbacks } from '#testing/helpers/orchestrator-factories.js';
import { setupProject } from '#testing/helpers/planning-phase.js';
import { cleanupTempDir, createTempDir } from '#testing/helpers/temp-dir.js';
import { REVIEW_FILE, sessionDir } from '../../../core/paths.js';
import { getChangedFilesSnapshot } from '../../orchestrator/approval/file-snapshots/capture.js';
import { runFinalReviewPhase } from '../../orchestrator/final-review.js';
import { parseFinalReview } from '../../parsers/final-review.js';
import { buildFinalReviewPrompt } from './review.js';

const SPEC = '## Spec\nAdd a hello function.';
const TASK_BRIEFS = '## Task T001\nAdd the hello export.';
const DIFF = '+export function hello() { return "hello"; }';
const dirs: string[] = [];

afterEach(() => {
  for (const dir of dirs.splice(0)) cleanupTempDir(dir);
});

describe('buildFinalReviewPrompt', () => {
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
    const reviewer = {
      review: vi.fn().mockResolvedValue({
        text: '### Verdict\npass\n### Findings\nNone.',
        usage: { inputTokens: 1, outputTokens: 1 },
      }),
    };
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
    expect(reviewer.review).toHaveBeenCalledWith(
      expect.stringContaining(`The run workspace is \`${workspaceDir}\`.`),
      workspaceDir,
      expect.any(Object),
    );
    expect(reviewer.review.mock.calls[0]?.[0]).toContain('Read project files from this directory');
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

  it('tells the reviewer to write None. for an empty category, which the parser reads as no finding', () => {
    const result = buildFinalReviewPrompt({ spec: SPEC, taskBriefs: TASK_BRIEFS, diff: DIFF });

    expect(result).toContain(
      'Write `None.` after the label of a category with no findings, or leave the label out.',
    );
    expect(parseFinalReview('### Findings\n- **Critical**: None.').findings).toEqual([]);
  });

  it('keeps evidence-record gaps out of Critical findings, stated once', () => {
    const result = buildFinalReviewPrompt({ spec: SPEC, taskBriefs: TASK_BRIEFS, diff: DIFF });
    const rule =
      'A **Critical** finding must name a defect in the code, the tests, or the behavior the diff produces.';

    expect(result.split(rule)).toHaveLength(2);
    expect(result).toContain('an evidence gap alone never causes `fail`');
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

  it('includes the recorded validation output verbatim and binds validation claims to it', () => {
    const evidence = '- test (`npm test`): passed\n\n```\nTests  4 passed (4)\n```';
    const result = buildFinalReviewPrompt({
      spec: SPEC,
      taskBriefs: TASK_BRIEFS,
      diff: DIFF,
      validationEvidence: evidence,
    });
    expect(result).toContain('## Recorded Validation Output');
    expect(result).toContain(
      'The orchestrator ran these validation commands and recorded their output.',
    );
    expect(result).toContain('Tests  4 passed (4)');
    expect(result).toContain(
      'quote the relevant line verbatim from the Recorded Validation Output section',
    );
    expect(result).toContain('never report counts or totals that do not appear there');
  });

  it('still instructs how to handle missing validation evidence when none is provided', () => {
    const result = buildFinalReviewPrompt({ spec: SPEC, taskBriefs: TASK_BRIEFS, diff: DIFF });
    expect(result).not.toContain('## Recorded Validation Output');
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
