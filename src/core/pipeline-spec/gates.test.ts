import { describe, expect, it } from 'vitest';
import { VALIDATION_STAGES } from '../schemas/enums.js';
import { NARROWING_KINDS } from '../validation/stacks/types.js';
import {
  CAPTURE_LIMITS,
  GATE_ORDER,
  NARROWING_RULE,
  NO_GATES_WARNING,
  STAGE_TIMEOUT_MS,
} from './gates.js';

describe('GATE_ORDER', () => {
  it('matches the validation stage order', () => {
    expect(GATE_ORDER).toEqual([...VALIDATION_STAGES]);
  });
});

describe('CAPTURE_LIMITS', () => {
  it('caps captured output and the test tail', () => {
    expect(CAPTURE_LIMITS).toEqual({ outputChars: 4096, testTailLines: 40 });
  });
});

describe('STAGE_TIMEOUT_MS', () => {
  it('gives a validation stage one hour when validation.timeoutMs is unset', () => {
    expect(STAGE_TIMEOUT_MS).toBe(3_600_000);
  });
});

describe('NO_GATES_WARNING', () => {
  it('carries the code the validator publishes for an unrecognised stack', () => {
    expect(NO_GATES_WARNING).toEqual({ category: 'validation', code: 'no_gates_unknown_stack' });
  });
});

describe('NARROWING_RULE', () => {
  it('names every narrowing kind', () => {
    expect(NARROWING_RULE.kinds).toEqual(NARROWING_KINDS);
    expect(NARROWING_RULE.text).toContain('stack default');
  });
});
