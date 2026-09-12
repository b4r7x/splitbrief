import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createTestGitRepo } from '#testing/helpers/git.js';
import { cleanupTempDir, createTempDir } from '#testing/helpers/temp-dir.js';
import { sessionDir, SPLITBRIEF_DIR } from '../../core/paths.js';
import {
  createTaskCompilationAttemptId,
  TaskCompilationSemanticIdSchema,
} from '../../core/schemas/task-compilation.js';
import { createCustomRunnerRuntime } from './custom-runner-runtime.js';
import { PLANNER_ARTIFACT_MAX_BYTES, type ArtifactApprovalReview } from './types.js';

const tempDirs: string[] = [];

afterEach(() => {
  for (const directory of tempDirs.splice(0)) cleanupTempDir(directory);
});

function projectDir(): string {
  const directory = createTempDir('custom-runner-runtime');
  tempDirs.push(directory);
  return directory;
}

function sessionFreeRuntimeFor(project: string, reviews: ArtifactApprovalReview[] = []) {
  return createCustomRunnerRuntime({
    projectDir: project,
    sessionId: 'review-2026-09-11-090000',
    sweepStaleReviews: false,
    admission: { interaction: 'headless', allowRepoRunners: true },
    onArtifactApproval: (_type, review) => {
      reviews.push(review);
      return Promise.resolve({ approved: true as const });
    },
  });
}

describe('createCustomRunnerRuntime', () => {
  it('carries the caller identity and scopes authorization to the project', () => {
    const project = projectDir();

    const runtime = sessionFreeRuntimeFor(project);

    expect(runtime.sessionId).toBe('review-2026-09-11-090000');
    expect(runtime.authorizationProjectDir).toBe(project);
    expect(runtime.admission).toEqual({ interaction: 'headless', allowRepoRunners: true });
    expect(runtime.authorizationPathEnv).toBe(process.env.PATH);
  });

  it('sweeps no stale review root, because a sessionless caller wrote none', async () => {
    const project = projectDir();

    await sessionFreeRuntimeFor(project).cleanupStaleArtifactReviews();

    expect(existsSync(join(project, SPLITBRIEF_DIR))).toBe(false);
  });

  it('sweeps the session review root when the caller owns the session', async () => {
    const project = projectDir();
    const runtime = createCustomRunnerRuntime({
      projectDir: project,
      sessionId: 'sess-001',
      sweepStaleReviews: true,
      admission: { interaction: 'headless', allowRepoRunners: true },
      onArtifactApproval: () => Promise.resolve({ approved: true as const }),
    });
    const reviewRoot = join(sessionDir(project, 'sess-001'), '.custom-runner-review');
    mkdirSync(reviewRoot, { recursive: true });
    writeFileSync(join(reviewRoot, 'stale'), 'old\n', 'utf-8');

    await runtime.cleanupStaleArtifactReviews();

    expect(runtime.sessionId).toBe('sess-001');
    expect(existsSync(reviewRoot)).toBe(false);
    expect(existsSync(sessionDir(project, 'sess-001'))).toBe(true);
  });

  it('stages the project outside it and removes the stage on cleanup', async () => {
    const project = projectDir();
    createTestGitRepo(project, { 'src/app.ts': 'export const app = true;\n' });

    const stage = await sessionFreeRuntimeFor(project).createStage(project, 'planner');

    expect(relative(project, stage.projectDir).startsWith('..')).toBe(true);
    expect(readFileSync(join(stage.projectDir, 'src', 'app.ts'), 'utf-8')).toBe(
      'export const app = true;\n',
    );
    // The port narrows the staged workspace to `CustomRunnerStage`: a one-shot
    // review seat gets no sandbox environment to spawn a second runner with.
    expect('sandboxEnv' in stage).toBe(false);

    stage.cleanup();

    expect(existsSync(stage.projectDir)).toBe(false);
  });

  it('reviews a declared artifact through the caller gate, with no session state', async () => {
    const project = projectDir();
    createTestGitRepo(project);
    const reviews: ArtifactApprovalReview[] = [];
    const runtime = sessionFreeRuntimeFor(project, reviews);
    const stage = await runtime.createStage(project, 'planner');
    const attemptId = createTaskCompilationAttemptId();
    const relativePath = `.splitbrief-runner/output/${attemptId}/result`;

    const prepared = await runtime.beginDeclaredArtifactReview({
      stagedProjectDir: stage.projectDir,
      callId: 'call-1',
      declaredRedactionValues: [],
      provenance: {
        semanticId: TaskCompilationSemanticIdSchema.parse('planner-artifact-result'),
        programId: null,
        batchId: null,
        attemptId,
        transport: {
          kind: 'declared-file',
          lease: { leaseId: attemptId, attemptId, relativePath },
        },
        maxBytes: PLANNER_ARTIFACT_MAX_BYTES,
        relativePath,
      },
    });
    try {
      writeFileSync(join(stage.projectDir, relativePath), '### Verdict\npass\n', 'utf-8');

      expect(await prepared.reviewAfterChild()).toBe('### Verdict\npass\n');
      expect(reviews.map((review) => review.text)).toEqual(['### Verdict\npass\n']);
      expect(prepared.getReceipt()).not.toBeUndefined();
    } finally {
      await prepared.dispose();
      stage.cleanup();
    }

    expect(existsSync(join(project, SPLITBRIEF_DIR))).toBe(false);
  });
});
