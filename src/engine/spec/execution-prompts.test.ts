import { describe, it, expect } from 'vitest';
import { makeTask } from '#testing/helpers/fixtures.js';
import { buildHintPrompt, buildEscalationPrompt } from './execution-prompts.js';

describe('buildHintPrompt', () => {
  it('contains task id, title, and file', () => {
    const task = makeTask({ id: 'T005', title: 'Add validation', file: 'src/validate.ts' });
    const result = buildHintPrompt(task, 'TS2322: Type error');

    expect(result).toContain('T005');
    expect(result).toContain('Add validation');
    expect(result).toContain('src/validate.ts');
  });

  it('contains the validation error', () => {
    const task = makeTask();
    const result = buildHintPrompt(task, 'TypeError: cannot read property');

    expect(result).toContain('TypeError: cannot read property');
    expect(result).toContain('## Validation Error');
  });

  it('contains task description', () => {
    const task = makeTask({ description: 'Implement the validation pipeline' });
    const result = buildHintPrompt(task, 'error');

    expect(result).toContain('Implement the validation pipeline');
  });

  it('includes signature when present', () => {
    const task = makeTask({ signature: 'export function validate(input: string): boolean' });
    const result = buildHintPrompt(task, 'error');

    expect(result).toContain('export function validate(input: string): boolean');
    expect(result).toContain('### Expected Signature');
  });

  it('omits signature section when not present', () => {
    const task = makeTask({ signature: undefined });
    const result = buildHintPrompt(task, 'error');

    expect(result).not.toContain('### Expected Signature');
  });

  it('lists constraints when present', () => {
    const task = makeTask({ constraints: ['ESM only', 'No classes'] });
    const result = buildHintPrompt(task, 'error');

    expect(result).toContain('- ESM only');
    expect(result).toContain('- No classes');
  });

  it('shows "None specified" when no constraints', () => {
    const task = makeTask({ constraints: [] });
    const result = buildHintPrompt(task, 'error');

    expect(result).toContain('None specified.');
  });

  it('instructs not to write code', () => {
    const result = buildHintPrompt(makeTask(), 'error');
    expect(result).toContain('Do NOT write code');
  });
});

describe('buildEscalationPrompt', () => {
  it('contains task details', () => {
    const task = makeTask({ id: 'T003', title: 'Fix parser', file: 'src/parser.ts', action: 'modify' });
    const result = buildEscalationPrompt(task, 'bad code', 'parse error');

    expect(result).toContain('T003');
    expect(result).toContain('Fix parser');
    expect(result).toContain('src/parser.ts');
    expect(result).toContain('modify');
  });

  it('contains the last attempt code', () => {
    const task = makeTask();
    const result = buildEscalationPrompt(task, 'const x = bad;', 'error');

    expect(result).toContain('const x = bad;');
    expect(result).toContain('## Last Failed Attempt');
  });

  it('contains the validation error', () => {
    const task = makeTask();
    const result = buildEscalationPrompt(task, 'code', 'TS2322: type mismatch');

    expect(result).toContain('TS2322: type mismatch');
    expect(result).toContain('## Validation Error');
  });

  it('includes tests when present', () => {
    const task = makeTask({ tests: ['should return true for valid input', 'should throw for null'] });
    const result = buildEscalationPrompt(task, 'code', 'error');

    expect(result).toContain('should return true for valid input');
    expect(result).toContain('should throw for null');
    expect(result).toContain('### Tests That Must Pass');
  });

  it('omits tests section when empty', () => {
    const task = makeTask({ tests: [] });
    const result = buildEscalationPrompt(task, 'code', 'error');

    expect(result).not.toContain('### Tests That Must Pass');
  });

  it('contains ESM convention instruction', () => {
    const task = makeTask();
    const result = buildEscalationPrompt(task, 'code', 'error');

    expect(result).toContain('ESM imports with .js extensions');
  });
});
