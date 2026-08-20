import {
  linkSync,
  mkdirSync,
  readFileSync,
  renameSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  createTaskCompilationAttemptId,
  createTaskCompilationBatchId,
  createTaskCompilationProgramId,
  TaskCompilationSemanticIdSchema,
} from '../../../core/schemas/task-compilation.js';
import { cleanupTempDir, createTempDir } from '#testing/helpers/temp-dir.js';
import { prepareArtifactStageLease, type ArtifactStageLease } from './artifact-stage-manifest.js';
import { beginDeclaredArtifactReview } from './planner-artifact.js';

const itUnix = process.platform === 'win32' ? it.skip : it;
const ARTIFACT_BOUND = 64;

type Fixture = Readonly<{
  root: string;
  lease: ArtifactStageLease;
  attemptId: string;
  path: string;
}>;

const roots: string[] = [];
const leases: ArtifactStageLease[] = [];

afterEach(async () => {
  await Promise.all(leases.splice(0).map((lease) => lease.dispose()));
  for (const root of roots.splice(0)) cleanupTempDir(root);
});

async function createFixture(
  leaseId = 'lease-a',
  bound = ARTIFACT_BOUND,
  path = `.splitbrief-runner/output/${leaseId}/result`,
): Promise<Fixture> {
  const root = createTempDir('planner-artifact-provenance');
  roots.push(root);
  const attemptId = createTaskCompilationAttemptId();
  const programId = createTaskCompilationProgramId({ feature: 'provenance' });
  const batchId = createTaskCompilationBatchId(programId, 0, [0]);
  const lease = await prepareArtifactStageLease({
    stagedProjectDir: root,
    provenance: {
      semanticId: TaskCompilationSemanticIdSchema.parse('semantic-provenance'),
      programId,
      batchId,
      attemptId,
      transport: {
        kind: 'declared-file',
        lease: { leaseId, attemptId, relativePath: path },
      },
      maxBytes: bound,
      relativePath: path,
    },
  });
  leases.push(lease);
  return { root, lease, attemptId, path: lease.artifactPath };
}

async function expectInvalid(operation: () => Promise<unknown>): Promise<unknown> {
  try {
    await operation();
  } catch (cause) {
    expect(cause).toMatchObject({ kind: 'custom-planner-artifact-invalid' });
    return cause;
  }
  throw new Error('expected the operation to reject');
}

function isHardlinkUnavailable(cause: unknown): boolean {
  if (typeof cause !== 'object' || cause === null || !('code' in cause)) return false;
  return (
    cause.code === 'EPERM' ||
    cause.code === 'EOPNOTSUPP' ||
    cause.code === 'ENOSYS' ||
    cause.code === 'EXDEV'
  );
}

describe('declared planner artifact provenance', () => {
  it('reads the exact bound and returns an immutable semantic receipt', async () => {
    const fixture = await createFixture();
    writeFileSync(fixture.path, 'x'.repeat(ARTIFACT_BOUND));

    const read = await fixture.lease.readWithReceiptAfterChild({ declaredRedactionValues: [] });

    expect(Buffer.byteLength(read.text, 'utf8')).toBe(ARTIFACT_BOUND);
    expect(read.receipt.semanticId).toBe('semantic-provenance');
    expect(read.receipt.programId).toContain('program-');
    expect(read.receipt.batchId).toContain('batch-');
    expect(read.receipt.attemptId).toBe(fixture.attemptId);
    expect(read.receipt.inodeIdentity).toMatch(/^\d+:\d+$/);
    expect(read.receipt.ancestryDigest).toHaveLength(64);
    expect(read.receipt.sha256).toHaveLength(64);
    expect(read.receipt.byteLength).toBe(ARTIFACT_BOUND);
    expect(read.receipt.leaseReceiptDigest).toHaveLength(64);
    expect(Object.isFrozen(read.receipt)).toBe(true);
    expect(fixture.lease.getReceipt()).toEqual(read.receipt);
  });

  it('carries the immutable receipt through planner approval', async () => {
    const root = createTempDir('planner-artifact-provenance-review');
    roots.push(root);
    const attemptId = createTaskCompilationAttemptId();
    const programId = createTaskCompilationProgramId({ feature: 'planner-review' });
    const batchId = createTaskCompilationBatchId(programId, 0, [0]);
    const review = await beginDeclaredArtifactReview({
      stagedProjectDir: root,
      projectDir: root,
      sessionId: 'provenance-review',
      callId: attemptId,
      provenance: {
        semanticId: TaskCompilationSemanticIdSchema.parse('semantic-review'),
        programId,
        batchId,
        attemptId,
        transport: {
          kind: 'declared-file',
          lease: {
            leaseId: 'lease-review',
            attemptId,
            relativePath: '.splitbrief-runner/output/lease-review/result',
          },
        },
        maxBytes: ARTIFACT_BOUND,
        relativePath: '.splitbrief-runner/output/lease-review/result',
      },
      declaredRedactionValues: [],
      onApprovalNeeded: async (_type, payload) => {
        expect(payload.text).toBe('approved artifact');
        return { approved: true };
      },
    });
    try {
      writeFileSync(review.artifactPath, 'approved artifact');
      await expect(review.reviewAfterChild()).resolves.toBe('approved artifact');
      const reviewed = await review.readWithReceiptAfterChild();
      expect(reviewed.text).toBe('approved artifact');
      expect(reviewed.receipt.leaseId).toBe('lease-review');
      const receipt = review.getReceipt();
      expect(receipt?.semanticId).toBe('semantic-review');
      expect(Object.isFrozen(receipt)).toBe(true);
    } finally {
      await review.dispose();
    }
  });

  it('rejects a stale lease path before creating a second invocation', async () => {
    const fixture = await createFixture();
    await fixture.lease.dispose();
    await expectInvalid(async () => {
      await prepareArtifactStageLease({
        stagedProjectDir: fixture.root,
        provenance: {
          semanticId: TaskCompilationSemanticIdSchema.parse('semantic-provenance'),
          programId: createTaskCompilationProgramId({ feature: 'provenance' }),
          batchId: null,
          attemptId: fixture.attemptId,
          transport: {
            kind: 'declared-file',
            lease: {
              leaseId: 'lease-a',
              attemptId: fixture.attemptId,
              relativePath: '.splitbrief-runner/output/lease-a/result',
            },
          },
          maxBytes: ARTIFACT_BOUND,
          relativePath: '.splitbrief-runner/output/lease-a/result',
        },
      });
    });
  });

  it('rejects missing and same-basename sibling files outside the lease', async () => {
    const missing = await createFixture('lease-missing');
    unlinkSync(missing.path);
    await expectInvalid(() =>
      missing.lease.readWithReceiptAfterChild({ declaredRedactionValues: [] }),
    );

    const fixture = await createFixture('lease-sibling');
    writeFileSync(fixture.path, 'valid');
    const siblingLease = join(fixture.root, '.splitbrief-runner', 'output', 'other-lease');
    mkdirSync(siblingLease);
    writeFileSync(join(siblingLease, 'result'), 'same-basename sibling');
    await expectInvalid(() =>
      fixture.lease.readWithReceiptAfterChild({ declaredRedactionValues: [] }),
    );
  });

  it('rejects basename-only, traversal, and absolute transport paths', async () => {
    const root = createTempDir('planner-artifact-paths');
    roots.push(root);
    for (const path of ['result', '../result', '/tmp/result']) {
      const attemptId = createTaskCompilationAttemptId();
      await expectInvalid(async () => {
        await prepareArtifactStageLease({
          stagedProjectDir: root,
          provenance: {
            semanticId: TaskCompilationSemanticIdSchema.parse('semantic-provenance'),
            programId: null,
            batchId: null,
            attemptId,
            transport: {
              kind: 'declared-file',
              lease: { leaseId: `lease-${path.length}`, attemptId, relativePath: path },
            },
            maxBytes: ARTIFACT_BOUND,
            relativePath: path,
          },
        });
      });
    }
  });

  itUnix('rejects links and swapped ancestry without exposing outside bytes', async () => {
    const fixture = await createFixture();
    const outside = createTempDir('planner-artifact-provenance-outside');
    roots.push(outside);
    writeFileSync(join(outside, 'result'), 'outside-canary');
    unlinkSync(fixture.path);
    symlinkSync(join(outside, 'result'), fixture.path);
    await expectInvalid(() =>
      fixture.lease.readWithReceiptAfterChild({ declaredRedactionValues: [] }),
    );

    const fresh = await createFixture('lease-swap');
    writeFileSync(fresh.path, 'retained');
    const leaseDir = join(fresh.root, '.splitbrief-runner', 'output', 'lease-swap');
    const parked = `${leaseDir}-parked`;
    renameSync(leaseDir, parked);
    symlinkSync(outside, leaseDir);
    await expectInvalid(() =>
      fresh.lease.readWithReceiptAfterChild({ declaredRedactionValues: [] }),
    );
  });

  itUnix(
    'rejects hard-linked artifacts without receipt or outside-byte disclosure',
    async ({ skip }) => {
      const fixture = await createFixture('lease-hardlink');
      const outside = createTempDir('planner-artifact-provenance-hardlink-outside');
      roots.push(outside);
      const outsidePath = join(outside, 'result');
      const outsideBytes = 'hardlink-outside-canary';
      writeFileSync(outsidePath, outsideBytes);
      unlinkSync(fixture.path);
      try {
        linkSync(outsidePath, fixture.path);
      } catch (cause) {
        if (isHardlinkUnavailable(cause)) {
          skip();
          return;
        }
        throw cause;
      }

      const rejection = await expectInvalid(() =>
        fixture.lease.readWithReceiptAfterChild({ declaredRedactionValues: [] }),
      );
      expect(String(rejection)).not.toContain(outsideBytes);
      expect(fixture.lease.getReceipt()).toBeUndefined();
      expect(readFileSync(outsidePath, 'utf8')).toBe(outsideBytes);
    },
  );

  it('rejects non-UTF-8 and one byte over the bound before receipt creation', async () => {
    const malformed = await createFixture('lease-utf8');
    writeFileSync(malformed.path, Buffer.from([0xc3, 0x28]));
    await expectInvalid(() =>
      malformed.lease.readWithReceiptAfterChild({ declaredRedactionValues: [] }),
    );

    const oversized = await createFixture('lease-oversize');
    writeFileSync(oversized.path, Buffer.alloc(ARTIFACT_BOUND + 1, 0x61));
    await expectInvalid(() =>
      oversized.lease.readWithReceiptAfterChild({ declaredRedactionValues: [] }),
    );
    expect(oversized.lease.getReceipt()).toBeUndefined();
  });

  it('keeps concurrent invocation leases from cross-reading', async () => {
    const firstRoot = createTempDir('planner-artifact-provenance-concurrent-first');
    const secondRoot = createTempDir('planner-artifact-provenance-concurrent-second');
    roots.push(firstRoot, secondRoot);
    const programId = createTaskCompilationProgramId({ feature: 'provenance-concurrent' });
    const firstAttemptId = createTaskCompilationAttemptId();
    const secondAttemptId = createTaskCompilationAttemptId();
    const semanticId = TaskCompilationSemanticIdSchema.parse('semantic-concurrent');
    const first = {
      lease: await prepareArtifactStageLease({
        stagedProjectDir: firstRoot,
        provenance: {
          semanticId,
          programId,
          batchId: createTaskCompilationBatchId(programId, 0, [0]),
          attemptId: firstAttemptId,
          transport: {
            kind: 'declared-file',
            lease: {
              leaseId: 'lease-first',
              attemptId: firstAttemptId,
              relativePath: '.splitbrief-runner/output/lease-first/result',
            },
          },
          maxBytes: ARTIFACT_BOUND,
          relativePath: '.splitbrief-runner/output/lease-first/result',
        },
      }),
    };
    const second = {
      lease: await prepareArtifactStageLease({
        stagedProjectDir: secondRoot,
        provenance: {
          semanticId,
          programId,
          batchId: createTaskCompilationBatchId(programId, 1, [1]),
          attemptId: secondAttemptId,
          transport: {
            kind: 'declared-file',
            lease: {
              leaseId: 'lease-second',
              attemptId: secondAttemptId,
              relativePath: '.splitbrief-runner/output/lease-second/result',
            },
          },
          maxBytes: ARTIFACT_BOUND,
          relativePath: '.splitbrief-runner/output/lease-second/result',
        },
      }),
    };
    leases.push(first.lease, second.lease);
    const firstPath = first.lease.artifactPath;
    const secondPath = second.lease.artifactPath;
    writeFileSync(firstPath, 'first');
    writeFileSync(secondPath, 'second');

    const firstRead = await first.lease.readWithReceiptAfterChild({ declaredRedactionValues: [] });
    const secondRead = await second.lease.readWithReceiptAfterChild({
      declaredRedactionValues: [],
    });

    expect(firstRead.text).toBe('first');
    expect(secondRead.text).toBe('second');
    expect(firstRead.receipt.attemptId).not.toBe(secondRead.receipt.attemptId);
    expect(firstRead.receipt.leaseReceiptDigest).not.toBe(secondRead.receipt.leaseReceiptDigest);
  });
});
