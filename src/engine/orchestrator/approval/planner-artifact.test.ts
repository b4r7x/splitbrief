import {
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
  writeSync,
} from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { sessionDir } from '../../../core/paths.js';
import { createTestGitRepo } from '#testing/helpers/git.js';
import { cleanupTempDir, createTempDir } from '#testing/helpers/temp-dir.js';
import { DECLARED_PLANNER_ARTIFACT_PATH, PLANNER_ARTIFACT_MAX_BYTES } from '../../runners/types.js';
import { beginDeclaredArtifactReview, cleanupStaleArtifactReviews } from './planner-artifact.js';
import { createStagedProject, type StagedProject } from './staged-project.js';

const itUnix = process.platform === 'win32' ? it.skip : it;
const SESSION_ID = 'session-1';
const CALL_ID = 'call-1';

type ArtifactFixture = Readonly<{
  projectDir: string;
  staged: StagedProject;
}>;

type ApprovalCallback = Parameters<typeof beginDeclaredArtifactReview>[0]['onApprovalNeeded'];
type ReviewLease = Awaited<ReturnType<typeof beginDeclaredArtifactReview>>;

type ReviewOptions = Readonly<{
  declaredRedactionValues?: readonly string[];
  onApprovalNeeded?: ApprovalCallback;
}>;

async function createArtifactFixture(): Promise<ArtifactFixture> {
  const projectDir = createTempDir('planner-artifact');
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

function cleanupFixture(fixture: ArtifactFixture): void {
  fixture.staged.cleanup();
  cleanupTempDir(fixture.projectDir);
}

function declaredArtifactPath(fixture: ArtifactFixture): string {
  return join(fixture.staged.projectDir, DECLARED_PLANNER_ARTIFACT_PATH);
}

function sessionRoot(projectDir: string): string {
  return sessionDir(realpathSync(projectDir), SESSION_ID);
}

function candidateRoot(projectDir: string): string {
  return join(sessionRoot(projectDir), '.custom-runner-review');
}

function writeArtifact(fixture: ArtifactFixture, bytes: string | Buffer): void {
  writeFileSync(declaredArtifactPath(fixture), bytes);
}

function writeArtifactInChunks(fixture: ArtifactFixture, chunks: readonly Buffer[]): void {
  const descriptor = openSync(declaredArtifactPath(fixture), 'w');
  try {
    let position = 0;
    for (const chunk of chunks) {
      position += writeSync(descriptor, chunk, 0, chunk.byteLength, position);
    }
  } finally {
    closeSync(descriptor);
  }
}

async function beginReview(
  fixture: ArtifactFixture,
  options: ReviewOptions = {},
): Promise<ReviewLease> {
  return beginDeclaredArtifactReview({
    stagedProjectDir: fixture.staged.projectDir,
    projectDir: fixture.projectDir,
    sessionId: SESSION_ID,
    callId: CALL_ID,
    declaredRedactionValues: options.declaredRedactionValues ?? [],
    onApprovalNeeded: options.onApprovalNeeded ?? (async () => ({ approved: true })),
  });
}

async function withReview<T>(
  options: ReviewOptions,
  test: (fixture: ArtifactFixture, review: ReviewLease) => Promise<T>,
): Promise<T> {
  const fixture = await createArtifactFixture();
  let review: ReviewLease | undefined;
  try {
    review = await beginReview(fixture, options);
    return await test(fixture, review);
  } finally {
    if (review !== undefined) await review.dispose();
    cleanupFixture(fixture);
  }
}

async function expectInvalid(operation: () => Promise<unknown>): Promise<Error> {
  let failure: unknown;
  try {
    await operation();
  } catch (err) {
    failure = err;
  }
  expect(failure).toMatchObject({ kind: 'custom-planner-artifact-invalid' });
  if (!(failure instanceof Error)) throw new Error('Expected an artifact validation error.');
  return failure;
}

async function assertSecretIsNeverPresented(input: {
  secret: string;
  values: readonly string[];
  writeArtifact: (fixture: ArtifactFixture) => void;
}): Promise<void> {
  const { secret, values, writeArtifact: write } = input;
  let approvalRequests = 0;
  await withReview(
    {
      declaredRedactionValues: values,
      onApprovalNeeded: async () => {
        approvalRequests += 1;
        return { approved: true };
      },
    },
    async (fixture, review) => {
      write(fixture);
      const failure = await expectInvalid(() => review.reviewAfterChild());

      expect(approvalRequests).toBe(0);
      expect(existsSync(candidateRoot(fixture.projectDir))).toBe(false);
      expect(existsSync(sessionRoot(fixture.projectDir))).toBe(false);
      expect(failure.message).not.toContain(secret);
      expect(JSON.stringify(failure)).not.toContain(secret);
    },
  );
}

describe('declared artifact review lease', () => {
  it('uses the retained descriptor and presents frozen immutable content', async () => {
    const expected = 'Żółw 🦊\n漢字\n';
    let approvalRequests = 0;
    await withReview(
      {
        onApprovalNeeded: async (type, review) => {
          approvalRequests += 1;
          expect(type).toBe('artifact');
          expect(review).toEqual({ label: 'Custom planner artifact', text: expected });
          expect(Object.isFrozen(review)).toBe(true);
          expect(Reflect.set(review, 'text', 'mutated by callback')).toBe(false);
          return { approved: true };
        },
      },
      async (fixture, review) => {
        expect(readFileSync(declaredArtifactPath(fixture))).toEqual(Buffer.from([0xff]));
        writeArtifact(fixture, expected);

        await expect(review.reviewAfterChild()).resolves.toBe(expected);
        expect(existsSync(candidateRoot(fixture.projectDir))).toBe(false);
      },
    );
    expect(approvalRequests).toBe(1);
  });

  it('cleans stale candidates before an active review lease starts', async () => {
    const fixture = await createArtifactFixture();
    try {
      const stalePath = join(candidateRoot(fixture.projectDir), 'stale-call', 'result');
      mkdirSync(join(candidateRoot(fixture.projectDir), 'stale-call'), { recursive: true });
      writeFileSync(stalePath, 'stale');

      await cleanupStaleArtifactReviews({ projectDir: fixture.projectDir, sessionId: SESSION_ID });
      expect(existsSync(stalePath)).toBe(false);

      const review = await beginReview(fixture);
      try {
        writeArtifact(fixture, 'fresh result');
        await expect(review.reviewAfterChild()).resolves.toBe('fresh result');
      } finally {
        await review.dispose();
      }
    } finally {
      cleanupFixture(fixture);
    }
  });

  it('rejects an exact raw declared value before candidate or approval exposure', async () => {
    const secret = 'planner-secret-value';
    await assertSecretIsNeverPresented({
      secret,
      values: [secret],
      writeArtifact: (fixture) => writeArtifact(fixture, `result ${secret}`),
    });
  });

  it('rejects overlapping raw declared values before candidate or approval exposure', async () => {
    const secret = 'alpha-bravo';
    await assertSecretIsNeverPresented({
      secret,
      values: [secret, 'alpha-bravo-charlie'],
      writeArtifact: (fixture) => writeArtifact(fixture, 'token=alpha-bravo-charlie'),
    });
  });

  it('rejects Unicode raw declared values before candidate or approval exposure', async () => {
    const secret = 'żółw🔐';
    await assertSecretIsNeverPresented({
      secret,
      values: [secret],
      writeArtifact: (fixture) => writeArtifact(fixture, `contains ${secret}`),
    });
  });

  it('rejects declared values split across child file-write chunks', async () => {
    const secret = Buffer.from('chunk-boundary-secret');
    await assertSecretIsNeverPresented({
      secret: secret.toString('utf8'),
      values: [secret.toString('utf8')],
      writeArtifact: (fixture) =>
        writeArtifactInChunks(fixture, [
          Buffer.from('prefix-'),
          secret.subarray(0, 7),
          secret.subarray(7),
          Buffer.from('-suffix'),
        ]),
    });
  });

  it('rejects malformed UTF-8 before callback or candidate creation', async () => {
    let approvalRequests = 0;
    await withReview(
      {
        onApprovalNeeded: async () => {
          approvalRequests += 1;
          return { approved: true };
        },
      },
      async (fixture, review) => {
        writeArtifact(fixture, Buffer.from([0xc3, 0x28]));
        await expectInvalid(() => review.reviewAfterChild());
        expect(approvalRequests).toBe(0);
        expect(existsSync(candidateRoot(fixture.projectDir))).toBe(false);
      },
    );
  });

  it('rejects oversized output before callback or candidate creation', async () => {
    let approvalRequests = 0;
    await withReview(
      {
        onApprovalNeeded: async () => {
          approvalRequests += 1;
          return { approved: true };
        },
      },
      async (fixture, review) => {
        writeArtifact(fixture, Buffer.alloc(PLANNER_ARTIFACT_MAX_BYTES + 1));
        await expectInvalid(() => review.reviewAfterChild());
        expect(approvalRequests).toBe(0);
        expect(existsSync(candidateRoot(fixture.projectDir))).toBe(false);
      },
    );
  });

  it('cleans the candidate when interactive approval rejects the artifact', async () => {
    await withReview(
      { onApprovalNeeded: async () => ({ approved: false }) },
      async (fixture, review) => {
        writeArtifact(fixture, 'requires approval');
        await expect(review.reviewAfterChild()).rejects.toMatchObject({
          kind: 'custom-planner-artifact-rejected',
        });
        expect(existsSync(candidateRoot(fixture.projectDir))).toBe(false);
      },
    );
  });

  it('never creates a pathname candidate for a successful immutable review', async () => {
    await withReview(
      {
        onApprovalNeeded: async (_type, review) => {
          expect(typeof review.label).toBe('string');
          expect(review.text).toBe('original bytes');
          expect(Object.isFrozen(review)).toBe(true);
          return { approved: true };
        },
      },
      async (fixture, review) => {
        writeArtifact(fixture, 'original bytes');
        await expect(review.reviewAfterChild()).resolves.toBe('original bytes');
        expect(existsSync(candidateRoot(fixture.projectDir))).toBe(false);
      },
    );
  });

  it('does not create a candidate on rejected immutable review', async () => {
    await withReview(
      {
        onApprovalNeeded: async () => {
          return { approved: false };
        },
      },
      async (fixture, review) => {
        writeArtifact(fixture, 'original bytes');
        await expect(review.reviewAfterChild()).rejects.toMatchObject({
          kind: 'custom-planner-artifact-rejected',
        });
        expect(existsSync(candidateRoot(fixture.projectDir))).toBe(false);
      },
    );
  });

  it('rejects source changes that occur while approval is pending and cleans the candidate', async () => {
    let mutateSource: (() => void) | undefined;
    await withReview(
      {
        onApprovalNeeded: async () => {
          if (mutateSource === undefined) throw new Error('Test source mutation was not prepared.');
          mutateSource();
          return { approved: true };
        },
      },
      async (fixture, review) => {
        writeArtifact(fixture, 'reviewed first result');
        mutateSource = () => writeArtifact(fixture, 'changed during approval');

        await expectInvalid(() => review.reviewAfterChild());
        expect(existsSync(candidateRoot(fixture.projectDir))).toBe(false);
      },
    );
  });

  itUnix('rejects a transient ancestor swap without presenting its outside canary', async () => {
    let approvalRequests = 0;
    await withReview(
      {
        onApprovalNeeded: async () => {
          approvalRequests += 1;
          return { approved: true };
        },
      },
      async (fixture, review) => {
        const output = join(fixture.staged.projectDir, '.splitbrief-runner', 'output');
        const parkedOutput = join(fixture.staged.projectDir, '.splitbrief-runner', 'parked-output');
        const outside = createTempDir('planner-artifact-outside');
        const canary = 'outside-host-canary';
        try {
          writeArtifact(fixture, 'retained result');
          renameSync(output, parkedOutput);
          symlinkSync(outside, output);
          writeFileSync(join(outside, 'result'), canary);
          rmSync(output);
          renameSync(parkedOutput, output);

          const failure = await expectInvalid(() => review.reviewAfterChild());
          expect(approvalRequests).toBe(0);
          expect(failure.message).not.toContain(canary);
          expect(JSON.stringify(failure)).not.toContain(canary);
          expect(existsSync(candidateRoot(fixture.projectDir))).toBe(false);
        } finally {
          cleanupTempDir(outside);
        }
      },
    );
  });

  it('rejects an unsafe call id before creating a lease or review candidate', async () => {
    const fixture = await createArtifactFixture();
    try {
      await expect(
        beginDeclaredArtifactReview({
          stagedProjectDir: fixture.staged.projectDir,
          projectDir: fixture.projectDir,
          sessionId: SESSION_ID,
          callId: '../outside',
          declaredRedactionValues: [],
          onApprovalNeeded: async () => ({ approved: true }),
        }),
      ).rejects.toMatchObject({ kind: 'custom-planner-artifact-call-id' });
      expect(existsSync(join(fixture.staged.projectDir, '.splitbrief-runner'))).toBe(false);
      expect(existsSync(candidateRoot(fixture.projectDir))).toBe(false);
    } finally {
      cleanupFixture(fixture);
    }
  });

  it('rejects a pre-existing control parent with the active invalid-artifact contract', async () => {
    const fixture = await createArtifactFixture();
    try {
      mkdirSync(join(fixture.staged.projectDir, '.splitbrief-runner'));
      await expectInvalid(() => beginReview(fixture));
      expect(existsSync(candidateRoot(fixture.projectDir))).toBe(false);
    } finally {
      cleanupFixture(fixture);
    }
  });

  it('disposes idempotently and prevents subsequent active review', async () => {
    await withReview({}, async (fixture, review) => {
      writeArtifact(fixture, 'would otherwise be valid');
      await review.dispose();
      await review.dispose();
      await expect(review.reviewAfterChild()).rejects.toMatchObject({
        kind: 'custom-planner-artifact-review-disposed',
      });
    });
  });
});

describe('R7 terminal artifact cleanup', () => {
  it('rejects missing, malformed, and declared-secret results before any approval surface', async () => {
    const secret = 'r7-terminal-artifact-secret';
    const rows = [
      {
        name: 'missing result',
        write: (fixture: ArtifactFixture) => unlinkSync(declaredArtifactPath(fixture)),
        values: [] as const,
      },
      {
        name: 'malformed UTF-8',
        write: (fixture: ArtifactFixture) => writeArtifact(fixture, Buffer.from([0xc3, 0x28])),
        values: [] as const,
      },
      {
        name: 'declared secret',
        write: (fixture: ArtifactFixture) => writeArtifact(fixture, `result ${secret}`),
        values: [secret],
      },
    ] as const;

    for (const row of rows) {
      let approvalRequests = 0;
      await withReview(
        {
          declaredRedactionValues: row.values,
          onApprovalNeeded: async () => {
            approvalRequests += 1;
            return { approved: true };
          },
        },
        async (fixture, review) => {
          row.write(fixture);
          const failure = await expectInvalid(() => review.reviewAfterChild());

          expect(approvalRequests, row.name).toBe(0);
          expect(existsSync(candidateRoot(fixture.projectDir)), row.name).toBe(false);
          expect(existsSync(sessionRoot(fixture.projectDir)), row.name).toBe(false);
          expect(failure.message, row.name).not.toContain(secret);
          expect(JSON.stringify(failure), row.name).not.toContain(secret);
        },
      );
    }
  });

  it('returns no canonical result or review candidate when approval rejects', async () => {
    let approvalRequests = 0;
    await withReview(
      {
        onApprovalNeeded: async () => {
          approvalRequests += 1;
          return { approved: false };
        },
      },
      async (fixture, review) => {
        writeArtifact(fixture, 'reviewed but rejected');

        await expect(review.reviewAfterChild()).rejects.toMatchObject({
          kind: 'custom-planner-artifact-rejected',
        });
        expect(approvalRequests).toBe(1);
        expect(existsSync(candidateRoot(fixture.projectDir))).toBe(false);
        expect(existsSync(sessionRoot(fixture.projectDir))).toBe(false);
      },
    );
  });
});
