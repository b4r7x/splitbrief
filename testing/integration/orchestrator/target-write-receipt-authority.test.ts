import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { recordedTargetOutput } from '../../../src/engine/orchestrator/evidence/task.js';
import {
  applyTargetBundle,
  cleanupTargetWriteFixtures,
  createTargetWriteProject,
  startOperatorReplacementWhenWritten,
  TARGET_WRITE_FILE,
  TARGET_WRITE_SESSION_ID,
  writeApiReceipt,
  writePromotedReceipt,
} from '#testing/helpers/target-write-fixtures.js';

/** Marks the direct response's bytes; the operator actor waits for this exact head. */
const CANDIDATE_MARKER = 'direct-response-marker\n';
/** Enough bytes that the verification's hash outlasts the operator's reaction by design. */
const CANDIDATE_BYTES = 32 * 1024 * 1024;

afterEach(() => {
  cleanupTargetWriteFixtures();
});

describe('current receipt authority', () => {
  it('does not claim a direct API save an operator replaced before verification', async () => {
    const { projectDir, task } = createTargetWriteProject();
    writePromotedReceipt({ projectDir, task, content: 'old-worker' });
    // The response is large enough that the verification's own hashing is still ahead when
    // the operator overwrites the file the moment the write lands. The read-back then finds
    // neither the response nor the baseline, so no save can be claimed.
    const content = `${CANDIDATE_MARKER}${'x'.repeat(CANDIDATE_BYTES)}`;
    const operator = startOperatorReplacementWhenWritten({
      targetPath: join(projectDir, TARGET_WRITE_FILE),
      writtenPrefix: CANDIDATE_MARKER,
      replacement: 'operator',
    });
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
