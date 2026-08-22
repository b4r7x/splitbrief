import { describe, it, expect, afterEach } from 'vitest';
import { execSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createTempDir, cleanupTempDir } from '#testing/helpers/temp-dir.js';
import { createTestGitRepo } from '#testing/helpers/git.js';
import type { DriftReport } from '../../../../core/schemas/drift.js';
import { REVIEW_FILE, sessionDir } from '../../../../core/paths.js';
import type { ReviewPacket } from '../../../../core/schemas/review-packet.js';
import { ReviewPacketSchema } from '../../../../core/schemas/review-packet.js';
import { buildFinalReview, resolveChangedFiles } from './sections-io.js';
import { renderReviewPacketMarkdown } from './render.js';
import { makeUsage } from '#testing/helpers/factories/summary.js';

let dirs: string[] = [];

afterEach(() => {
  for (const d of dirs) cleanupTempDir(d);
  dirs = [];
});

function makeProject(): { projectDir: string; runStartHead: string } {
  const projectDir = createTempDir('sections-io-test');
  dirs.push(projectDir);
  createTestGitRepo(projectDir);
  const runStartHead = execSync('git rev-parse HEAD', {
    cwd: projectDir,
    stdio: 'pipe',
    encoding: 'utf8',
  }).trim();
  return { projectDir, runStartHead };
}

function driftWith(changedFiles: string[]): DriftReport {
  return {
    version: 1,
    passed: true,
    score: 1,
    changedFiles,
    expectedFiles: [],
    findings: [],
    briefHash: null,
  };
}

describe('resolveChangedFiles', () => {
  it('uses the drift report changed files (deduped, sorted) without consulting git or reporting missing', async () => {
    const { projectDir, runStartHead } = makeProject();
    const missing: string[] = [];

    const files = await resolveChangedFiles({
      projectDir,
      drift: driftWith(['src/b.ts', 'src/a.ts', 'src/a.ts']),
      missing,
      baseline: { head: runStartHead },
    });

    expect(files).toEqual(['src/a.ts', 'src/b.ts']);
    expect(missing).toEqual([]);
  });

  it('reports "changed files" missing instead of an empty-but-confident list when no drift report and the tree is clean', async () => {
    const { projectDir, runStartHead } = makeProject();
    const missing: string[] = [];

    const files = await resolveChangedFiles({
      projectDir,
      drift: null,
      missing,
      baseline: { head: runStartHead },
    });

    expect(files).toEqual([]);
    expect(missing).toContain('changed files');
  });

  it('reports the run-start baseline missing instead of guessing the run boundary from git history', async () => {
    const { projectDir } = makeProject();
    const git = (args: string) => execSync(`git ${args}`, { cwd: projectDir, stdio: 'pipe' });
    mkdirSync(join(projectDir, 'src'), { recursive: true });
    writeFileSync(join(projectDir, 'src/feature.ts'), 'export const x = 1;\n');
    git('add src/feature.ts');
    git('commit -m "feat(splitbrief): T1 - add feature"');

    const missing: string[] = [];
    const files = await resolveChangedFiles({
      projectDir,
      drift: null,
      missing,
      baseline: undefined,
    });

    expect(files).toEqual([]);
    expect(missing).toEqual(['run-start baseline']);
  });

  it('surfaces files committed since run-start when per-task commits leave a clean working tree', async () => {
    const { projectDir, runStartHead } = makeProject();
    const git = (args: string) => execSync(`git ${args}`, { cwd: projectDir, stdio: 'pipe' });
    mkdirSync(join(projectDir, 'src'), { recursive: true });
    // A per-task commit (prefixed `feat(splitbrief):`) moves the run's change out of
    // the working tree, leaving `git status` empty.
    writeFileSync(join(projectDir, 'src/feature.ts'), 'export const x = 1;\n');
    git('add src/feature.ts');
    git('commit -m "feat(splitbrief): T1 - add feature"');

    const missing: string[] = [];
    const files = await resolveChangedFiles({
      projectDir,
      drift: null,
      missing,
      baseline: { head: runStartHead },
    });

    expect(files).toEqual(['src/feature.ts']);
    expect(missing).not.toContain('changed files');
  });

  it('routes the no-drift fallback through the run-baseline filter, dropping splitbrief-internal paths', async () => {
    const { projectDir, runStartHead } = makeProject();
    mkdirSync(join(projectDir, 'src'), { recursive: true });
    writeFileSync(join(projectDir, 'src/feature.ts'), 'export const x = 1;\n');
    // An internal control-plane write that must NOT surface as a changed file.
    mkdirSync(join(projectDir, '.splitbrief', 'sessions'), { recursive: true });
    writeFileSync(join(projectDir, '.splitbrief', 'sessions', 'state.json'), '{}\n');

    const missing: string[] = [];
    const files = await resolveChangedFiles({
      projectDir,
      drift: null,
      missing,
      baseline: { head: runStartHead },
    });

    expect(files).toContain('src/feature.ts');
    expect(files.some((f) => f.startsWith('.splitbrief'))).toBe(false);
    expect(missing).not.toContain('changed files');
  });

  it('uses the persisted run boundary for no-drift review packets', async () => {
    const { projectDir } = makeProject();
    const git = (args: string) =>
      execSync(`git ${args}`, { cwd: projectDir, stdio: 'pipe', encoding: 'utf8' }).trim();
    mkdirSync(join(projectDir, 'src'), { recursive: true });
    writeFileSync(join(projectDir, 'src/pre-run.ts'), 'export const preRun = true;\n');
    git('add src/pre-run.ts');
    git('commit -m "feat(splitbrief): misleading pre-run subject"');
    const runStartHead = git('rev-parse HEAD');

    writeFileSync(join(projectDir, 'src/post-run.ts'), 'export const postRun = true;\n');
    git('add src/post-run.ts');
    git('commit -m "chore: arbitrary post-run subject"');

    const missing: string[] = [];
    const files = await resolveChangedFiles({
      projectDir,
      drift: null,
      missing,
      baseline: { head: runStartHead },
    });

    expect(files).toEqual(['src/post-run.ts']);
    expect(missing).not.toContain('changed files');
  });

  it('includes commits from an explicitly captured unborn boundary', async () => {
    const { projectDir } = makeProject();
    const git = (args: string) => execSync(`git ${args}`, { cwd: projectDir, stdio: 'pipe' });
    mkdirSync(join(projectDir, 'src'), { recursive: true });
    writeFileSync(join(projectDir, 'src/from-unborn.ts'), 'export const value = true;\n');
    git('add src/from-unborn.ts');
    git('commit -m "chore: arbitrary subject"');

    const missing: string[] = [];
    const files = await resolveChangedFiles({
      projectDir,
      drift: null,
      missing,
      baseline: { head: null },
    });

    expect(files).toContain('src/from-unborn.ts');
    expect(missing).not.toContain('changed files');
  });
});

function writeReview(projectDir: string, sessionId: string, body: string): void {
  const dir = sessionDir(projectDir, sessionId);
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, REVIEW_FILE),
    `---
generated_by: splitbrief v0.0.0
---

${body}`,
  );
}

describe('buildFinalReview', () => {
  it('lands a fail verdict with one critical finding in the packet', async () => {
    const { projectDir } = makeProject();
    const sessionId = 'review-fail-session';
    writeReview(
      projectDir,
      sessionId,
      `### Verdict
fail

### Findings
- **Critical**: Unauthenticated requests return 500 instead of 401
`,
    );

    const missing: string[] = [];
    const section = await buildFinalReview({
      projectDir,
      sessionId,
      requestedStatus: 'written',
      ledger: null,
      missing,
    });

    expect(section.verdict).toBe('fail');
    expect(section.findingCounts).toEqual({ critical: 1, warning: 0, note: 0 });
    expect(section.criteriaPassed).toBe(0);
    expect(section.criteriaFailed).toBe(0);
    expect(missing).not.toContain(REVIEW_FILE);
  });

  it('yields the defaults when the review file is absent', async () => {
    const { projectDir } = makeProject();
    const missing: string[] = [];
    const section = await buildFinalReview({
      projectDir,
      sessionId: 'review-absent-session',
      requestedStatus: 'written',
      ledger: null,
      missing,
    });

    expect(section.verdict).toBeNull();
    expect(section.findingCounts).toEqual({ critical: 0, warning: 0, note: 0 });
    expect(section.criteriaPassed).toBe(0);
    expect(section.criteriaFailed).toBe(0);
    expect(section.excerpt).toBeNull();
    expect(missing).toContain(REVIEW_FILE);
  });
});

function packetWithFinalReview(finalReview: ReviewPacket['finalReview']): ReviewPacket {
  return ReviewPacketSchema.parse({
    version: 1,
    sessionId: 's',
    generatedAt: '2026-08-05T00:00:00.000Z',
    run: {
      sessionId: 's',
      feature: 'feat',
      mode: null,
      phase: 'complete',
      planner: { tool: null, model: null },
      implementer: { tool: null, model: null },
      startedAt: null,
      completedAt: null,
      totalTimeMs: null,
      totalTasks: 1,
      completedLocally: 1,
      escalated: 0,
      skipped: 0,
      failed: 0,
    },
    readiness: {
      path: 'readiness.json',
      present: true,
      status: null,
      nextAction: null,
      blockerCount: null,
      warningCount: null,
      checks: [],
    },
    changes: {
      changedFiles: [],
      expectedFiles: [],
      outOfScopeFiles: [],
      taskFiles: [],
      diffReference: 'Review the working tree with `git diff`.',
    },
    checkpoints: {
      items: [],
      latestRunCheckpoint: null,
      preFinalReview: null,
      runLedger: {
        path: 'checkpoint-run-ledger.json',
        present: false,
        accepted: null,
        rejected: null,
        runSnapshotIds: [],
        runSnapshotKinds: {},
        latestSnapshotId: null,
      },
      safety: {
        hashGuarded: true,
        conflictsSkippedByDefault: true,
        forceOverwritesConflicts: true,
        partialRestoreExpected: true,
        excludedPaths: [],
        text: {
          hashGuarded: '',
          conflictsSkippedByDefault: '',
          forceOverwritesConflicts: '',
          partialRestoreExpected: '',
          excludedPaths: '',
        },
      },
    },
    recoveryDecisions: {
      sourceArtifacts: [],
      events: [],
      currentIssue: null,
      selectedActions: [],
      outcomes: [],
      unresolvedRisks: [],
    },
    validation: {
      summary: { passed: 0, failed: 0, skipped: 0, escalated: 0 },
      tasks: [],
      finalReviewEvidenceStatus: null,
      missingEvidenceWarnings: [],
    },
    evidence: {
      path: null,
      present: false,
      briefHash: null,
      finalReview: null,
      approvals: [],
      rejections: [],
    },
    drift: {
      path: null,
      present: false,
      passed: null,
      score: null,
      errorCount: 0,
      warningCount: 0,
      changedFiles: [],
      expectedFiles: [],
      findings: [],
      findingsBySeverity: { info: [], warning: [], error: [] },
      briefHash: null,
      chainSummary: {
        path: 'drift-chains.json',
        present: false,
        emittedChainCount: 0,
        topChain: null,
        briefQuality: {
          path: 'brief-quality.json',
          present: false,
          passed: null,
          score: null,
          errorCount: 0,
          warningCount: 0,
        },
      },
      briefQuality: {
        path: 'brief-quality.json',
        present: false,
        passed: null,
        score: null,
        errorCount: 0,
        warningCount: 0,
      },
    },
    escalations: {
      retries: [],
      escalatedTasks: [],
      skippedTasks: [],
      failedTasks: [],
      warnings: [],
    },
    cost: {
      tokenUsage: makeUsage(),
      costBreakdown: null,
      estimatedCostSavings: null,
      taskRouting: [],
      routingWarnings: [],
    },
    finalReview,
    reviewerChecklist: [],
    missingArtifacts: [],
  });
}

describe('renderReviewPacketMarkdown final review block', () => {
  it('renders a verdict line with the finding counts', () => {
    const rendered = renderReviewPacketMarkdown(
      packetWithFinalReview({
        path: 'review.md',
        status: 'written',
        evidenceStatus: null,
        statusText: 'Planner final review written to review.md.',
        excerpt: null,
        verdict: 'fail',
        criteriaPassed: 2,
        criteriaFailed: 1,
        findingCounts: { critical: 1, warning: 0, note: 0 },
      }),
    );

    expect(rendered).toContain('- Verdict: fail');
    expect(rendered).toContain('- Criteria: 2 passed, 1 failed');
    expect(rendered).toContain('- Findings: 1 critical, 0 warning, 0 note');
  });

  it('renders a null verdict as unknown, never as pass', () => {
    const rendered = renderReviewPacketMarkdown(
      packetWithFinalReview({
        path: 'review.md',
        status: 'missing',
        evidenceStatus: null,
        statusText: 'review.md was not available.',
        excerpt: null,
        verdict: null,
        criteriaPassed: 0,
        criteriaFailed: 0,
        findingCounts: { critical: 0, warning: 0, note: 0 },
      }),
    );

    expect(rendered).toContain('- Verdict: unknown');
    expect(rendered).not.toContain('- Verdict: pass');
  });
});
