import { expect, it } from 'vitest';
import { apiContextError } from './context-diagnostic.js';

it('names the missing check results and scope report in the review error', () => {
  const diagnostic = apiContextError({
    code: 'insufficient-context',
    seat: 'review',
    cause: 'missing-required',
    missingSections: ['evidence.json', 'drift-report.json'],
  });
  expect(diagnostic.message).toMatch(/check results/i);
  expect(diagnostic.message).toMatch(/scope/i);
  expect(diagnostic.message).not.toMatch(/\.json/);
});
