import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { createEventBus } from '../../../src/engine/events/bus.js';
import { checkFailureText } from '../../../src/engine/orchestrator/validation/failure-text.js';
import { runChecks } from '../../../src/engine/orchestrator/validation/run-checks.js';
import { defaultContext, makeConfig } from '#testing/helpers/factories/config.js';
import { makeTask } from '#testing/helpers/factories/task.js';
import { makeImplementer } from '#testing/helpers/orchestrator-factories.js';
import { withTempDir } from '#testing/helpers/temp-dir.js';
import { FAILING_BASE_FIXTURE, withHiddenRetryCheck } from './live-paths.js';

describe('hidden retry acceptance', () => {
  it.each(['complete', 'broken subtotal', 'narrowed', 'deleted'])(
    'forces retry after a %s first output',
    async (firstOutput) => {
      await withTempDir('hidden-retry-check', async (root) => {
        const projectDir = join(root, 'project');
        const checkFile = join(root, 'hidden acceptance.mjs');
        for (const [file, content] of Object.entries(FAILING_BASE_FIXTURE.files)) {
          mkdirSync(dirname(join(projectDir, file)), { recursive: true });
          writeFileSync(join(projectDir, file), content);
        }
        const sourceFile = join(projectDir, 'src/cart.mjs');
        const completeSource = [
          '// Retry acceptance acknowledged.',
          'export function subtotal(items) { return items.reduce((sum, item) => sum + item.price * item.qty, 0); }',
          'export function applyDiscount(amount, percent) { return Math.round(amount * (1 - percent / 100) * 100) / 100; }',
        ].join('\n');
        const hidden = withHiddenRetryCheck(
          makeImplementer({
            implement: async ({ task }) => {
              expect(task.checks).toBeUndefined();
              expect(existsSync(checkFile)).toBe(false);
              writeFileSync(
                sourceFile,
                firstOutput === 'broken subtotal'
                  ? completeSource.replace('item.price * item.qty', 'item.price')
                  : completeSource,
              );
              if (firstOutput === 'narrowed') {
                writeFileSync(join(projectDir, 'test/other.test.mjs'), '');
                writeFileSync(
                  join(projectDir, 'package.json'),
                  JSON.stringify({
                    type: 'module',
                    scripts: { test: 'node --test test/other.test.mjs' },
                  }),
                );
              }
              expect(spawnSync('npm', ['test'], { cwd: projectDir }).status).toBe(
                firstOutput === 'broken subtotal' ? 1 : 0,
              );
              if (firstOutput === 'deleted') unlinkSync(sourceFile);
              return { success: true, output: 'Implemented' };
            },
            retry: async ({ error }) => {
              const marker = error.match(/\/\/ Retry acceptance acknowledged\.+/)?.[0];
              expect(marker).toBe(
                firstOutput === 'deleted'
                  ? '// Retry acceptance acknowledged.'
                  : '// Retry acceptance acknowledged..',
              );
              writeFileSync(sourceFile, `${completeSource}\n${marker}\n`);
              return { success: true, output: 'Fixed' };
            },
          }),
          checkFile,
        );
        const task = makeTask({ suggestedFiles: ['src/cart.mjs', 'test/cart.test.mjs'] });
        const config = makeConfig();
        const options = {
          task,
          projectDir,
          config,
          context: { ...defaultContext, dir: projectDir },
          onOutput: () => {},
        };
        const checkOptions = {
          task,
          projectDir,
          config,
          bus: createEventBus(),
          phase: 'implementing' as const,
          npmScriptsApproved: false,
        };
        await hidden.implementer.implement(options);
        const [failed] = await runChecks(['hidden-retry-acceptance'], checkOptions);
        if (failed?.status !== 'fail') throw new Error('The hidden check must fail attempt one');
        const error = checkFailureText(failed);
        expect(error).toContain('Hidden acceptance check:');
        if (firstOutput === 'broken subtotal') {
          expect(error).toContain('The project test suite must pass.');
          expect(error).toContain('subtotal multiplies each price by its quantity');
        }
        await hidden.implementer.retry({ ...options, error, attempt: 1, kind: 'local' });
        expect(hidden.feedback).toEqual([error]);
        const [passed] = await runChecks(['hidden-retry-acceptance'], checkOptions);
        expect(passed?.status).toBe('pass');
      });
    },
  );
});
