import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { defaultContext } from '#testing/helpers/factories/config.js';
import { makeBaseConfig } from '#testing/helpers/factories/implementer-base.js';
import { makeRunnerCallResult } from '#testing/helpers/factories/runner-call.js';
import { readEvidenceLedger } from '../../../src/core/evidence/ledger-storage.js';
import { createImplementerBase } from '../../../src/engine/implementers/pipeline/run.js';
import { getChangedFilesSnapshot } from '../../../src/engine/orchestrator/approval/file-snapshots/capture.js';
import { makeImplementerRetryInvoker } from '../../../src/engine/orchestrator/escalation/make-implementer-retry-invoker.js';
import { recordedTargetOutput } from '../../../src/engine/orchestrator/evidence/task.js';
import { buildLanguageContext } from '../../../src/engine/spec/prompts/language-context.js';
import { sha256Hex } from '../../../src/utils/sha256.js';
import {
  cleanupTargetWriteFixtures,
  createTargetWriteProject,
  createTargetWriteWorkspace,
  runTargetWriteRetry,
  TARGET_WRITE_FILE,
  TARGET_WRITE_SESSION_ID,
  writePromotedReceipt,
} from '#testing/helpers/target-write-fixtures.js';

afterEach(() => {
  cleanupTargetWriteFixtures();
});

describe('retry target provenance', () => {
  it('leaves an operator-settled API target unowned', async () => {
    const { projectDir, task } = createTargetWriteProject();
    const ref = { projectDir, sessionId: TARGET_WRITE_SESSION_ID };
    const snapshot = await getChangedFilesSnapshot(projectDir);
    const workspace = await createTargetWriteWorkspace(projectDir);
    const invokeRetry = makeImplementerRetryInvoker({
      context: defaultContext,
      kind: 'local',
      sessionId: TARGET_WRITE_SESSION_ID,
      languageContext: buildLanguageContext('typescript'),
      phase: 'implementing',
      implementer: createImplementerBase(
        makeBaseConfig({
          outputContract: 'file-bundle-v1',
          invoke: async () =>
            makeRunnerCallResult({
              status: 'completed',
              text: JSON.stringify({
                version: 1,
                files: [
                  {
                    path: TARGET_WRITE_FILE,
                    action: 'modify',
                    content: 'operator-and-worker-same',
                  },
                ],
              }),
            }),
        }),
      ),
    });

    await runTargetWriteRetry({
      projectDir,
      task,
      workspace,
      taskStartSnapshot: snapshot,
      invokeRetry: async (args) => {
        const result = await invokeRetry(args);
        writeFileSync(join(projectDir, TARGET_WRITE_FILE), 'operator-and-worker-same');
        return result;
      },
    });

    // The target is the operator's: an identical staged entry settles the promotion without
    // rewriting the file, and nothing records it as this task's own output.
    expect(readFileSync(join(projectDir, TARGET_WRITE_FILE), 'utf8')).toBe(
      'operator-and-worker-same',
    );
    expect(recordedTargetOutput(ref, task).files).toEqual([]);
    expect(readEvidenceLedger(ref)?.tasks[0]?.apiApply).toMatchObject({
      status: 'applied',
      workspacePath: workspace.projectDir,
      applied: [
        {
          path: TARGET_WRITE_FILE,
          action: 'modify',
          beforeSha256: sha256Hex('original'),
          afterSha256: sha256Hex('operator-and-worker-same'),
        },
      ],
    });
  });

  it('keeps ownership when additional current-code context refreshes', async () => {
    const { projectDir, task: initial } = createTargetWriteProject();
    const ref = { projectDir, sessionId: TARGET_WRITE_SESSION_ID };
    const task = {
      ...initial,
      files: [TARGET_WRITE_FILE, 'src/second.ts'],
      currentCodeByFile: { 'src/second.ts': 'before' },
    };
    writePromotedReceipt({ projectDir, task, content: 'worker' });
    writeFileSync(join(projectDir, TARGET_WRITE_FILE), 'worker');
    const refreshed = { ...task, currentCodeByFile: { 'src/second.ts': 'after' } };
    expect(recordedTargetOutput(ref, refreshed).files).toEqual([
      { path: TARGET_WRITE_FILE, sha256: sha256Hex('worker'), mode: 0o644 },
    ]);
  });
});
