import { describe, expect, it } from 'vitest';
import { migrateEventLines, migrateState } from './legacy.js';

describe('migrateEventLines', () => {
  it('migrates valid event lines and skips corrupt lines', () => {
    const { lines, warnings } = migrateEventLines(
      ['{"type":"workflow_started"}', 'not-json', ''].join('\n'),
    );

    expect(lines).toEqual(['{"type":"workflow_started","kind":"event"}']);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain('corrupt');
  });
});

describe('migrateState', () => {
  it('bumps legacy state to the current version', () => {
    expect(migrateState({ sessionId: 'legacy', phase: 'idle' })).toMatchObject({
      stateVersion: 3,
      plannerSessionId: 'legacy',
      awaitingContinue: false,
      messageQueue: [],
    });
  });
});
