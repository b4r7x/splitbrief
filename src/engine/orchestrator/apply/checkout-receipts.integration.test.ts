import { symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { withApplyRun } from '#testing/helpers/apply-run.js';
import { makeWorkflowState } from '#testing/helpers/factories/workflow-state.js';
import { makeBusRecorder } from '#testing/helpers/orchestrator-factories.js';
import { saveState } from '../../../core/state/persistence.js';
import { sha256Hex } from '../../../utils/sha256.js';
import { checkoutWriterRevision, expectedForeignCheckoutWrites } from '../../checkout-writers.js';
import { ABSENT_CHECKOUT_ENTRY, fileCheckoutFingerprint } from '../isolation/checkout-entries.js';
import { undoApply } from './restore.js';
import { runApply } from './run.js';

it.each(['apply', 'undo'] as const)(
  'records the exact entry transition on %s for another run',
  async (action) => {
    await withApplyRun(
      { 'app.txt': 'before\n' },
      { sessionId: 'apply-checkout-receipts' },
      async (run) => {
        const ref = { projectDir: run.dir, sessionId: run.sessionId };
        const observer = { projectDir: run.dir, sessionId: 'observer' };
        const before = new Map([
          ['app.txt', fileCheckoutFingerprint(sha256Hex('before\n'), 0o644)],
          ['app-link', ABSENT_CHECKOUT_ENTRY],
        ]);
        const after = new Map([
          ['app.txt', fileCheckoutFingerprint(sha256Hex('after\n'), 0o644)],
          ['app-link', 'symlink:app.txt'],
        ]);
        const beforeApply = checkoutWriterRevision(run.dir);
        writeFileSync(join(run.ws, 'app.txt'), 'after\n');
        symlinkSync('app.txt', join(run.ws, 'app-link'));
        const state = makeWorkflowState({
          phase: 'complete',
          reviewStatus: 'passed',
          workspace: run.workspace,
        });
        saveState(ref, state);

        const applied = await runApply({
          wctx: { ...ref, bus: makeBusRecorder().bus },
          state,
          reviewNone: false,
        });
        expect(applied.outcome).toBe('applied');
        if (action === 'apply') {
          expect(expectedForeignCheckoutWrites(observer, beforeApply, before)).toEqual(after);
          return;
        }

        const beforeUndo = checkoutWriterRevision(run.dir);
        expect(await undoApply(ref, applied.state)).toMatchObject({
          restored: ['app-link', 'app.txt'],
          conflicts: [],
        });
        expect(expectedForeignCheckoutWrites(observer, beforeUndo, after)).toEqual(before);
      },
    );
  },
);
