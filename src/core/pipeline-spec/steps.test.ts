import { describe, expect, it } from 'vitest';
import { APPROVE_LEVELS, WORKFLOW_MODES } from '../schemas/enums.js';
import { opensPlanGate } from './steps.js';

describe('opensPlanGate', () => {
  it('opens the plan gate outside quick mode at the plan level only', () => {
    const opened = WORKFLOW_MODES.flatMap((mode) =>
      APPROVE_LEVELS.filter((level) => opensPlanGate(mode, level)).map((level) => [mode, level]),
    );
    expect(opened).toEqual(
      WORKFLOW_MODES.filter((mode) => mode !== 'quick').map((mode) => [mode, 'plan']),
    );
  });
});
