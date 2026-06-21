import { describe, it, expect } from 'vitest';
import { substituteEventFields } from './substitute.js';
import type { EngineEvent } from '../events/types.js';
import { taskId } from '../../core/schemas/task.js';
import {
  CALL_CONSUMER_STRING_TRUNCATION_PLACEHOLDER,
  CALL_HOOKS_MAX_PUBLIC_STRING_BYTES,
} from '../../core/consumer-policy.js';

const S = (s: string) => '$' + `{${s}}`;

const baseEvent: EngineEvent = {
  type: 'task_started',
  ts: 1700000000000,
  phase: 'implementing',
  taskId: taskId('T001'),
  title: 'Add login',
  index: 0,
  total: 5,
  file: 'src/login.ts',
  action: 'create',
};

describe('substituteEventFields', () => {
  it('replaces a simple field', () => {
    expect(substituteEventFields(S('event.title'), baseEvent)).toBe('Add login');
  });

  it('replaces multiple fields in one string', () => {
    expect(
      substituteEventFields(`${S('event.file')} for task ${S('event.taskId')}`, baseEvent),
    ).toBe('src/login.ts for task T001');
  });

  it('replaces numeric fields as decimal strings', () => {
    expect(substituteEventFields(`${S('event.index')}/${S('event.total')}`, baseEvent)).toBe('0/5');
  });

  it('replaces missing fields with empty string', () => {
    expect(substituteEventFields(S('event.nonexistent'), baseEvent)).toBe('');
  });

  it('JSON-stringifies object/array values', () => {
    const event: EngineEvent = {
      type: 'validate',
      ts: 1,
      phase: 'validating-task',
      taskId: taskId('T001'),
      status: 'done',
      passed: true,
      stages: { typecheck: true, lint: true, test: true },
    };
    expect(substituteEventFields(S('event.stages'), event)).toBe(
      '{"typecheck":true,"lint":true,"test":true}',
    );
  });

  it('leaves non-event-placeholder text unchanged', () => {
    expect(substituteEventFields('plain text no substitutions', baseEvent)).toBe(
      'plain text no substitutions',
    );
  });

  it('does NOT use eval — preserves arbitrary characters in values', () => {
    const event: EngineEvent = {
      type: 'warning',
      ts: 1,
      phase: 'idle',
      message: '$(rm -rf /); echo pwned',
    };
    // Value is substituted as-is. Spawn layer (not us) handles argv quoting.
    expect(substituteEventFields(S('event.message'), event)).toBe('$(rm -rf /); echo pwned');
  });

  it('redacts secret-looking placeholder values', () => {
    const event: EngineEvent = {
      type: 'warning',
      ts: 1,
      phase: 'idle',
      message: 'use sk-abcdefghijklmnopqrst',
    };
    expect(substituteEventFields(S('event.message'), event)).toBe('use sk-***REDACTED***');
  });

  it('bounds oversized placeholder values', () => {
    const event: EngineEvent = {
      type: 'warning',
      ts: 1,
      phase: 'idle',
      message: 'x'.repeat(CALL_HOOKS_MAX_PUBLIC_STRING_BYTES + 100),
    };
    const output = substituteEventFields(S('event.message'), event);
    expect(Buffer.byteLength(output, 'utf8')).toBeLessThanOrEqual(
      CALL_HOOKS_MAX_PUBLIC_STRING_BYTES,
    );
    expect(output).toContain(CALL_CONSUMER_STRING_TRUNCATION_PLACEHOLDER);
  });

  it('handles nested object access via dot path', () => {
    const event: EngineEvent = {
      type: 'cost_prediction',
      ts: 1,
      phase: 'planning',
      prediction: { totalCost: 1.23 } as never,
    };
    expect(substituteEventFields(S('event.prediction.totalCost'), event)).toBe('1.23');
  });
});
