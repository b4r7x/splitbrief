import { describe, it, expect } from 'vitest';
import { substituteEventFields } from './substitute.js';
import type { EngineEvent } from '../events/types.js';

const S = (s: string) => '$' + `{${s}}`;

const baseEvent: EngineEvent = {
  type: 'task_started',
  ts: 1700000000000,
  phase: 'implementing',
  taskId: 'T001' as never,
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
    expect(substituteEventFields(`${S('event.file')} for task ${S('event.taskId')}`, baseEvent))
      .toBe('src/login.ts for task T001');
  });

  it('replaces numeric fields as decimal strings', () => {
    expect(substituteEventFields(`${S('event.index')}/${S('event.total')}`, baseEvent)).toBe('0/5');
  });

  it('replaces missing fields with empty string', () => {
    expect(substituteEventFields(S('event.nonexistent'), baseEvent)).toBe('');
  });

  it('JSON-stringifies object/array values', () => {
    const event: EngineEvent = { type: 'validate', ts: 1, phase: 'validating-task', taskId: 'T1' as never, status: 'done', passed: true, stages: { typecheck: true, lint: true, test: true } };
    expect(substituteEventFields(S('event.stages'), event)).toBe('{"typecheck":true,"lint":true,"test":true}');
  });

  it('leaves non-event-placeholder text unchanged', () => {
    expect(substituteEventFields('plain text no substitutions', baseEvent)).toBe('plain text no substitutions');
  });

  it('does NOT use eval — preserves arbitrary characters in values', () => {
    const event: EngineEvent = { type: 'warning', ts: 1, phase: 'idle', message: '$(rm -rf /); echo pwned' };
    // Value is substituted as-is. Spawn layer (not us) handles argv quoting.
    expect(substituteEventFields(S('event.message'), event)).toBe('$(rm -rf /); echo pwned');
  });

  it('handles nested object access via dot path', () => {
    const event: EngineEvent = { type: 'cost_prediction', ts: 1, phase: 'planning', prediction: { totalCost: 1.23 } as never };
    expect(substituteEventFields(S('event.prediction.totalCost'), event)).toBe('1.23');
  });
});
