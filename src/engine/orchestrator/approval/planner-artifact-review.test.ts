import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { ApprovalReviewResult } from '../../../core/approval/types.js';
import { createTestGitRepo } from '#testing/helpers/git.js';
import { cleanupTempDir, createTempDir } from '#testing/helpers/temp-dir.js';
import {
  DECLARED_PLANNER_ARTIFACT_PATH,
  PLANNER_ARTIFACT_MAX_BYTES,
  type ArtifactApprovalReview,
} from '../../runners/types.js';
import { beginDeclaredArtifactReview } from './planner-artifact.js';
import { createStagedProject, type StagedProject } from './staged-project.js';

const SESSION_ID = 'immutable-artifact-review';

type Fixture = Readonly<{
  projectDir: string;
  staged: StagedProject;
}>;

async function createFixture(): Promise<Fixture> {
  const projectDir = createTempDir('planner-artifact-review');
  try {
    createTestGitRepo(projectDir);
    mkdirSync(join(projectDir, 'src'), { recursive: true });
    writeFileSync(join(projectDir, 'src', 'app.ts'), 'export const app = true;\n');
    return { projectDir, staged: await createStagedProject(projectDir) };
  } catch (err) {
    cleanupTempDir(projectDir);
    throw err;
  }
}

function artifactPath(fixture: Fixture): string {
  return join(fixture.staged.projectDir, DECLARED_PLANNER_ARTIFACT_PATH);
}

async function withArtifactReview<T>(
  onApprovalNeeded: (
    type: 'artifact',
    review: ArtifactApprovalReview,
  ) => Promise<ApprovalReviewResult>,
  test: (
    fixture: Fixture,
    review: Awaited<ReturnType<typeof beginDeclaredArtifactReview>>,
  ) => Promise<T>,
): Promise<T> {
  const fixture = await createFixture();
  let review: Awaited<ReturnType<typeof beginDeclaredArtifactReview>> | undefined;
  try {
    review = await beginDeclaredArtifactReview({
      stagedProjectDir: fixture.staged.projectDir,
      projectDir: fixture.projectDir,
      sessionId: SESSION_ID,
      callId: 'call-1',
      declaredRedactionValues: [],
      onApprovalNeeded,
    });
    return await test(fixture, review);
  } finally {
    if (review !== undefined) await review.dispose();
    fixture.staged.cleanup();
    cleanupTempDir(fixture.projectDir);
  }
}

describe('immutable artifact approval review', () => {
  it('delivers exact at-limit canonical text in a frozen display-only payload', async () => {
    const expected = '\0'.repeat(PLANNER_ARTIFACT_MAX_BYTES);
    let received: ArtifactApprovalReview | undefined;
    await withArtifactReview(
      async (_type, review) => {
        received = review;
        expect(review.label).toBe('Custom planner artifact');
        expect(review.label).not.toContain('/');
        expect(Object.isFrozen(review)).toBe(true);
        expect(Reflect.set(review, 'text', 'callback mutation')).toBe(false);
        return { approved: true };
      },
      async (fixture, review) => {
        writeFileSync(artifactPath(fixture), expected);
        const result = await review.reviewAfterChild();

        expect(Buffer.byteLength(result, 'utf8')).toBe(PLANNER_ARTIFACT_MAX_BYTES);
        expect(Buffer.from(result, 'utf8').equals(Buffer.from(expected, 'utf8'))).toBe(true);
      },
    );

    if (received === undefined) throw new Error('Artifact approval callback was not invoked.');
    expect(Buffer.byteLength(received.text, 'utf8')).toBe(PLANNER_ARTIFACT_MAX_BYTES);
    expect(Buffer.from(received.text, 'utf8').equals(Buffer.from(expected, 'utf8'))).toBe(true);
  });

  it('rejects one byte over the immutable transport bound before invoking approval', async () => {
    let approvalRequests = 0;
    await withArtifactReview(
      async () => {
        approvalRequests += 1;
        return { approved: true };
      },
      async (fixture, review) => {
        writeFileSync(artifactPath(fixture), '\0'.repeat(PLANNER_ARTIFACT_MAX_BYTES + 1));
        await expect(review.reviewAfterChild()).rejects.toMatchObject({
          kind: 'custom-planner-artifact-invalid',
        });
      },
    );
    expect(approvalRequests).toBe(0);
  });
});
