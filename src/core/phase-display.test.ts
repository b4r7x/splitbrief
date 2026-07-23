import { describe, expect, it } from 'vitest';
import { formatRoleLabel, formatStageLabel } from './phase-display.js';
import { PHASES, type Phase } from './schemas/enums.js';

// Literal expected labels, not recomputed with the implementation's algorithm, so
// a formatting regression fails the loop instead of mirroring into it. The Record
// type forces an entry for every Phase member added later.
const EXPECTED_PHASE_LABELS: Record<Phase, string> = {
  idle: 'Idle',
  researching: 'Researching',
  specifying: 'Specifying',
  'reviewing-spec': 'Reviewing Spec',
  clarifying: 'Clarifying',
  'constitution-check': 'Constitution Check',
  planning: 'Planning',
  'reviewing-plan': 'Reviewing Plan',
  'reviewing-briefs': 'Reviewing Briefs',
  analyzing: 'Analyzing',
  implementing: 'Implementing',
  'validating-task': 'Validating Task',
  escalating: 'Escalating',
  'final-review': 'Final Review',
  complete: 'Complete',
};

describe('formatStageLabel', () => {
  it('title-cases arbitrary identifiers', () => {
    expect(formatStageLabel('build-step')).toBe('Build Step');
    expect(formatStageLabel('build')).toBe('Build');
  });

  it('title-cases every Phase member', () => {
    for (const phase of PHASES) {
      expect(formatStageLabel(phase)).toBe(EXPECTED_PHASE_LABELS[phase]);
    }
  });
});

describe('formatRoleLabel', () => {
  it('capitalizes planner, implementer, validator', () => {
    expect(formatRoleLabel('planner')).toBe('Planner');
    expect(formatRoleLabel('implementer')).toBe('Implementer');
    expect(formatRoleLabel('validator')).toBe('Validator');
  });
});
