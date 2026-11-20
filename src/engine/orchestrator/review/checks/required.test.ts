import { expect, it } from 'vitest';
import { TriageInputSchema } from '../../../../core/schemas/review/verdict.js';
import { reviewInputsSection } from '../../../spec/prompts/review/changes.js';
import { buildPreReviewInputs } from './required.js';

it('stores the failing command and count in the finding and preserves the output separately', () => {
  const output = 'FAIL src/cart.test.ts > removes an item';
  const [finding] = buildPreReviewInputs({
    failed: [
      {
        checkId: 'V1',
        command: 'npm test',
        status: 'fail',
        output,
        failure: { keys: ['src/cart.test.ts::removes an item'] },
      },
    ],
    registry: new Map(),
    tasks: [],
    ledger: null,
    workspaceDir: '/project',
  });
  expect(finding?.output).toBe(output);
  expect(finding?.text).toContain('npm test failed · 1 failure');
  expect(finding?.text).not.toMatch(/Failures:|\(fail\)|Output tail:/);
});

it('keeps file-specific assertions in the review prompt after saving the input', () => {
  const inputs = buildPreReviewInputs({
    failed: [
      {
        checkId: 'V1',
        command: 'npm test',
        status: 'fail',
        output: 'runner cleanup',
        failure: {
          keys: ['src/cart.test.ts::removes an item', 'src/list.test.ts::adds a row'],
          messages: new Map([
            ['src/cart.test.ts::removes an item', 'AssertionError: expected 1 to be 0'],
            ['src/list.test.ts::adds a row', 'AssertionError: expected 2 to be 3'],
          ]),
        },
      },
    ],
    registry: new Map(),
    tasks: [],
    ledger: null,
    workspaceDir: '/project',
  });
  const cart = TriageInputSchema.parse(inputs[0]);
  const prompt = reviewInputsSection([cart]);
  expect(prompt).toContain('AssertionError: expected 1 to be 0');
  expect(prompt).not.toContain('src/list.test.ts');
  expect(cart.text).not.toContain('AssertionError');
  expect(cart.output).toBe('runner cleanup');
});
