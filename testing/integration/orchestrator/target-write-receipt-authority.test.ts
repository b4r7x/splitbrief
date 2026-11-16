import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { recordedTargetOutput } from '../../../src/engine/orchestrator/evidence/target-writes.js';
import {
  applyTargetBundle,
  cleanupTargetWriteFixtures,
  createTargetWriteProject,
  type FixtureActor,
  startOperatorReplacementWhenWritten,
  TARGET_WRITE_FILE,
  TARGET_WRITE_SESSION_ID,
  writeApiReceipt,
  writePromotedReceipt,
} from '#testing/helpers/target-write-fixtures.js';

/** Marks the direct response's bytes; the operator actor waits for this exact head. */
const CANDIDATE_MARKER = 'direct-response-marker\n';

// The verification reads the target back after the write. While a case holds an operator, a
// read of the written response waits until the operator has replaced it, so the replacement
// always lands between the write and the read-back, however late the operator reacts.
const readBack = vi.hoisted(() => ({ operator: undefined as FixtureActor | undefined }));
vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>();
  const readFile = async (...args: Parameters<typeof actual.readFile>) => {
    const operator = readBack.operator;
    if (
      operator !== undefined &&
      (await actual.readFile(args[0], 'utf8')).startsWith(CANDIDATE_MARKER)
    ) {
      await operator.done();
    }
    return actual.readFile(...args);
  };
  return { ...actual, readFile, default: { ...actual, readFile } };
});

afterEach(() => {
  readBack.operator = undefined;
  cleanupTargetWriteFixtures();
});

describe('current receipt authority', () => {
  it('does not claim a direct API save an operator replaced before verification', async () => {
    const { projectDir, task } = createTargetWriteProject();
    writePromotedReceipt({ projectDir, task, content: 'old-worker' });
    // The operator overwrites the file once the write lands. The read-back then finds neither
    // the response nor the baseline, so no save can be claimed.
    const content = `${CANDIDATE_MARKER}direct-response`;
    const operator = startOperatorReplacementWhenWritten({
      targetPath: join(projectDir, TARGET_WRITE_FILE),
      writtenPrefix: CANDIDATE_MARKER,
      replacement: 'operator',
    });
    readBack.operator = operator;
    await operator.ready;
    const result = await applyTargetBundle({ projectDir, task, content });
    await operator.done();

    if (result.status !== 'failed') {
      throw new Error(`expected the application to fail verification, got ${result.status}`);
    }
    expect(result.code).toBe('write-uncertain');
    expect(result.failedPath).toBe(TARGET_WRITE_FILE);
    expect(readFileSync(join(projectDir, TARGET_WRITE_FILE), 'utf8')).toBe('operator');

    writeApiReceipt({ projectDir, task, result });
    expect(
      recordedTargetOutput({ projectDir, sessionId: TARGET_WRITE_SESSION_ID }, task).files,
    ).toEqual([]);
  });

  it('keeps worker-only API receipts outside target ownership', async () => {
    const { projectDir, task } = createTargetWriteProject();
    const result = await applyTargetBundle({ projectDir, task, content: 'workspace-worker' });
    writeApiReceipt({ projectDir, task, result, workspacePath: '/worker' });
    expect(recordedTargetOutput({ projectDir, sessionId: TARGET_WRITE_SESSION_ID }, task)).toEqual({
      files: [],
      hasOutput: false,
    });
  });
});
