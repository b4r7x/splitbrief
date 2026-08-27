import {
  closeSync,
  linkSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  rmSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
  writeSync,
} from 'node:fs';
import { createServer, type Server } from 'node:net';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  createTaskCompilationAttemptId,
  TaskCompilationSemanticIdSchema,
} from '../../../core/schemas/task-compilation.js';
import { cleanupTempDir, createTempDir } from '#testing/helpers/temp-dir.js';
import {
  DECLARED_ARTIFACT_STAGE_MAX_BYTES,
  prepareArtifactStageLease,
  type ArtifactStageLease,
} from './artifact-stage-manifest.js';

const itUnix = process.platform === 'win32' ? it.skip : it;
const itWindows = process.platform === 'win32' ? it : it.skip;

type Fixture = Readonly<{
  root: string;
  artifactPath: string;
  lease: ArtifactStageLease &
    Readonly<{
      readAfterChild: (
        input: Readonly<{ declaredRedactionValues: readonly string[] }>,
      ) => Promise<string>;
    }>;
}>;

let tempDirs: string[] = [];
let leases: ArtifactStageLease[] = [];

afterEach(async () => {
  const activeLeases = leases;
  leases = [];
  await Promise.all(
    activeLeases.map(async (lease) => {
      try {
        await lease.dispose();
      } catch {
        // Cleanup must continue for the remaining real-file-system fixtures.
      }
    }),
  );

  const dirs = tempDirs;
  tempDirs = [];
  for (const dir of dirs) cleanupTempDir(dir);
});

function trackedTempDir(prefix: string): string {
  const dir = createTempDir(prefix);
  tempDirs.push(dir);
  return dir;
}

async function createFixture(): Promise<Fixture> {
  const root = trackedTempDir('artifact-stage-manifest');
  mkdirSync(join(root, 'src'));
  writeFileSync(join(root, 'src', 'baseline.ts'), 'export const baseline = true;\n');
  const attemptId = createTaskCompilationAttemptId();
  const leaseId = `fixture-${attemptId}`;
  const relativePath = `.splitbrief-runner/output/${leaseId}/result`;
  const lease = await prepareArtifactStageLease({
    stagedProjectDir: root,
    provenance: {
      semanticId: TaskCompilationSemanticIdSchema.parse('artifact-stage-test'),
      programId: null,
      batchId: null,
      attemptId,
      transport: {
        kind: 'declared-file',
        lease: { leaseId, attemptId, relativePath },
      },
      maxBytes: 96 * 1_024,
      relativePath,
    },
  });
  leases.push(lease);
  const textLease = Object.assign(lease, {
    readAfterChild: async ({
      declaredRedactionValues,
    }: Readonly<{
      declaredRedactionValues: readonly string[];
    }>) => (await lease.readWithReceiptAfterChild({ declaredRedactionValues })).text,
  });
  return {
    root,
    artifactPath: lease.artifactPath,
    lease: textLease,
  };
}

function writeArtifact(fixture: Fixture, bytes: string | Buffer): void {
  writeFileSync(fixture.artifactPath, bytes);
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

function writeArtifactInChunks(fixture: Fixture, chunks: readonly Buffer[]): void {
  const descriptor = openSync(fixture.artifactPath, 'w');
  try {
    let position = 0;
    for (const chunk of chunks) {
      position += writeSync(descriptor, chunk, 0, chunk.byteLength, position);
    }
  } finally {
    closeSync(descriptor);
  }
}

async function listenUnixSocket(path: string): Promise<Server> {
  const server = createServer();
  await new Promise<void>((resolve, reject) => {
    const onError = (err: Error) => {
      server.off('listening', onListening);
      reject(err);
    };
    const onListening = () => {
      server.off('error', onError);
      resolve();
    };
    server.once('error', onError);
    server.once('listening', onListening);
    server.listen(path);
  });
  return server;
}

async function closeServer(server: Server): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    server.close((err) => (err === undefined ? resolve() : reject(err)));
  });
}

function isWindowsSwapBlock(err: unknown): boolean {
  return (
    typeof err === 'object' &&
    err !== null &&
    'code' in err &&
    typeof err.code === 'string' &&
    ['EACCES', 'EBUSY', 'EPERM'].includes(err.code)
  );
}

describe('prepareArtifactStageLease', () => {
  it('creates an exclusive invalid-UTF-8 sentinel and rejects it when untouched', async () => {
    const fixture = await createFixture();

    expect(readFileSync(fixture.artifactPath)).toEqual(Buffer.from([0xff]));
    await expectInvalid(() => fixture.lease.readAfterChild({ declaredRedactionValues: [] }));
  });

  it('rejects preparation when a control parent already exists', async () => {
    const root = trackedTempDir('artifact-stage-existing-control');
    mkdirSync(join(root, '.splitbrief-runner'));

    await expectInvalid(() =>
      prepareArtifactStageLease({ stagedProjectDir: root, provenance: undefined }),
    );
  });

  it('returns an exact multibyte UTF-8 artifact and revalidates its retained descriptor', async () => {
    const fixture = await createFixture();
    const expected = 'Żółw 🦊\n漢字\n';
    writeArtifact(fixture, expected);

    const reviewed = await fixture.lease.readAfterChild({ declaredRedactionValues: [] });
    const promoted = await fixture.lease.revalidateBeforePromotion();

    expect(reviewed).toBe(expected);
    expect(Buffer.from(reviewed, 'utf8')).toEqual(Buffer.from(expected, 'utf8'));
    expect(promoted).toBe(expected);
  });

  it('rejects a missing result', async () => {
    const fixture = await createFixture();
    unlinkSync(fixture.artifactPath);

    await expectInvalid(() => fixture.lease.readAfterChild({ declaredRedactionValues: [] }));
  });

  it('rejects malformed UTF-8 before exposing text', async () => {
    const fixture = await createFixture();
    writeArtifact(fixture, Buffer.from([0xc3, 0x28]));

    await expectInvalid(() => fixture.lease.readAfterChild({ declaredRedactionValues: [] }));
  });

  it('rejects an oversized result before reading it', async () => {
    const fixture = await createFixture();
    writeArtifact(fixture, Buffer.alloc(DECLARED_ARTIFACT_STAGE_MAX_BYTES + 1));

    await expectInvalid(() => fixture.lease.readAfterChild({ declaredRedactionValues: [] }));
  });

  it('rejects an exact declared secret without including it in the error', async () => {
    const fixture = await createFixture();
    const secret = 'planner-secret-value';
    writeArtifact(fixture, `result ${secret}`);

    const failure = await expectInvalid(() =>
      fixture.lease.readAfterChild({ declaredRedactionValues: [secret] }),
    );

    expect(failure.message).not.toContain(secret);
    expect(JSON.stringify(failure)).not.toContain(secret);
  });

  it('rejects overlapping declared secret values', async () => {
    const fixture = await createFixture();
    writeArtifact(fixture, 'token=alpha-bravo-charlie');

    await expectInvalid(() =>
      fixture.lease.readAfterChild({
        declaredRedactionValues: ['alpha-bravo', 'alpha-bravo-charlie'],
      }),
    );
  });

  it('rejects a Unicode declared secret as raw UTF-8 bytes', async () => {
    const fixture = await createFixture();
    const secret = 'żółw🔐';
    writeArtifact(fixture, `contains ${secret}`);

    const failure = await expectInvalid(() =>
      fixture.lease.readAfterChild({ declaredRedactionValues: [secret] }),
    );

    expect(failure.message).not.toContain(secret);
  });

  it('rejects a declared secret that was written across file-write chunks', async () => {
    const fixture = await createFixture();
    const secret = Buffer.from('chunk-boundary-secret');
    writeArtifactInChunks(fixture, [
      Buffer.from('prefix-'),
      secret.subarray(0, 7),
      secret.subarray(7),
      Buffer.from('-suffix'),
    ]);

    await expectInvalid(() =>
      fixture.lease.readAfterChild({ declaredRedactionValues: [secret.toString('utf8')] }),
    );
  });

  itUnix('rejects a persistent symlink ancestor without following its result', async () => {
    const fixture = await createFixture();
    const outside = trackedTempDir('artifact-stage-outside');
    const output = join(fixture.root, '.splitbrief-runner', 'output');
    const parkedOutput = join(fixture.root, '.splitbrief-runner', 'parked-output');
    renameSync(output, parkedOutput);
    symlinkSync(outside, output);
    writeFileSync(join(outside, 'result'), 'outside canary');

    await expectInvalid(() => fixture.lease.readAfterChild({ declaredRedactionValues: [] }));
  });

  itUnix('rejects a transiently swapped result ancestor without exposing its canary', async () => {
    const fixture = await createFixture();
    const expected = 'retained-descriptor-result';
    const canary = 'outside-host-canary';
    const outside = trackedTempDir('artifact-stage-transient-outside');
    const output = join(fixture.root, '.splitbrief-runner', 'output');
    const parkedOutput = join(fixture.root, '.splitbrief-runner', 'parked-output');
    writeArtifact(fixture, expected);

    renameSync(output, parkedOutput);
    symlinkSync(outside, output);
    writeFileSync(join(outside, 'result'), canary);
    rmSync(output);
    renameSync(parkedOutput, output);

    const failure = await expectInvalid(() =>
      fixture.lease.readAfterChild({ declaredRedactionValues: [] }),
    );
    expect(failure.message).not.toContain(canary);
    expect(JSON.stringify(failure)).not.toContain(canary);
  });

  itUnix('rejects an atomic replacement of the leased result inode', async () => {
    const fixture = await createFixture();
    const replacement = join(fixture.root, '.splitbrief-runner', 'output', 'replacement');
    writeFileSync(replacement, 'replacement inode');
    renameSync(replacement, fixture.artifactPath);

    await expectInvalid(() => fixture.lease.readAfterChild({ declaredRedactionValues: [] }));
  });

  itUnix('rejects a hard-linked leased result', async () => {
    const fixture = await createFixture();
    writeArtifact(fixture, 'hard-link attempt');
    linkSync(fixture.artifactPath, join(fixture.root, 'artifact-hard-link'));

    await expectInvalid(() => fixture.lease.readAfterChild({ declaredRedactionValues: [] }));
  });

  it('rejects an added empty directory', async () => {
    const fixture = await createFixture();
    writeArtifact(fixture, 'valid result');
    mkdirSync(join(fixture.root, 'late-empty-directory'));

    await expectInvalid(() => fixture.lease.readAfterChild({ declaredRedactionValues: [] }));
  });

  it('rejects an added ordinary file', async () => {
    const fixture = await createFixture();
    writeArtifact(fixture, 'valid result');
    writeFileSync(join(fixture.root, 'late-file'), 'drift');

    await expectInvalid(() => fixture.lease.readAfterChild({ declaredRedactionValues: [] }));
  });

  it('rejects a create-delete churn that leaves the entry set unchanged', async () => {
    const fixture = await createFixture();
    writeArtifact(fixture, 'valid result');
    const transientPath = join(fixture.root, 'transient-entry');
    writeFileSync(transientPath, 'transient drift');
    unlinkSync(transientPath);

    await expectInvalid(() => fixture.lease.readAfterChild({ declaredRedactionValues: [] }));
  });

  it('rejects deletion of a baseline entry', async () => {
    const fixture = await createFixture();
    writeArtifact(fixture, 'valid result');
    unlinkSync(join(fixture.root, 'src', 'baseline.ts'));

    await expectInvalid(() => fixture.lease.readAfterChild({ declaredRedactionValues: [] }));
  });

  itUnix('rejects a nonregular socket entry', async () => {
    const fixture = await createFixture();
    writeArtifact(fixture, 'valid result');
    const server = await listenUnixSocket(join(fixture.root, 'late.sock'));
    try {
      await expectInvalid(() => fixture.lease.readAfterChild({ declaredRedactionValues: [] }));
    } finally {
      await closeServer(server);
    }
  });

  it('rejects a result changed after review', async () => {
    const fixture = await createFixture();
    writeArtifact(fixture, 'first result');
    await fixture.lease.readAfterChild({ declaredRedactionValues: [] });
    writeArtifact(fixture, 'second result');

    await expectInvalid(() => fixture.lease.revalidateBeforePromotion());
  });

  it('rejects unrelated drift after review', async () => {
    const fixture = await createFixture();
    writeArtifact(fixture, 'reviewed result');
    await fixture.lease.readAfterChild({ declaredRedactionValues: [] });
    writeFileSync(join(fixture.root, 'late-after-review'), 'drift');

    await expectInvalid(() => fixture.lease.revalidateBeforePromotion());
  });

  it('disposes idempotently and never permits a post-disposal read', async () => {
    const fixture = await createFixture();
    writeArtifact(fixture, 'would otherwise be valid');

    await fixture.lease.dispose();
    await fixture.lease.dispose();

    await expectInvalid(() => fixture.lease.readAfterChild({ declaredRedactionValues: [] }));
  });

  itWindows('has an explicit Windows junction confinement contract', async () => {
    const fixture = await createFixture();
    const outside = trackedTempDir('artifact-stage-junction-outside');
    const output = join(fixture.root, '.splitbrief-runner', 'output');
    const parkedOutput = join(fixture.root, '.splitbrief-runner', 'parked-output');
    writeArtifact(fixture, 'retained result');

    try {
      renameSync(output, parkedOutput);
    } catch (err) {
      expect(isWindowsSwapBlock(err)).toBe(true);
      return;
    }

    symlinkSync(outside, output, 'junction');
    writeFileSync(join(outside, 'result'), 'junction canary');
    await expectInvalid(() => fixture.lease.readAfterChild({ declaredRedactionValues: [] }));
  });
});

describe('R7 terminal manifest cleanup', () => {
  it('returns no artifact text for missing, extra, malformed, or declared-secret terminal state', async () => {
    const secret = 'r7-terminal-manifest-secret';
    const rows = [
      {
        name: 'missing result',
        mutate: (fixture: Fixture) => unlinkSync(fixture.artifactPath),
        values: [] as const,
      },
      {
        name: 'extra stage write',
        mutate: (fixture: Fixture) => {
          writeArtifact(fixture, 'declared result');
          writeFileSync(join(fixture.root, 'r7-extra-stage-write'), 'reject');
        },
        values: [] as const,
      },
      {
        name: 'malformed UTF-8',
        mutate: (fixture: Fixture) => writeArtifact(fixture, Buffer.from([0xc3, 0x28])),
        values: [] as const,
      },
      {
        name: 'declared secret',
        mutate: (fixture: Fixture) => writeArtifact(fixture, `result ${secret}`),
        values: [secret],
      },
    ] as const;

    for (const row of rows) {
      const fixture = await createFixture();
      row.mutate(fixture);
      const failure = await expectInvalid(() =>
        fixture.lease.readAfterChild({ declaredRedactionValues: row.values }),
      );

      expect(failure.message, row.name).not.toContain(secret);
      expect(JSON.stringify(failure), row.name).not.toContain(secret);
      await fixture.lease.dispose();
      await expectInvalid(() => fixture.lease.readAfterChild({ declaredRedactionValues: [] }));
    }
  });
});
