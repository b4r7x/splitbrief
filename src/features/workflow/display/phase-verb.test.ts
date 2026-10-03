import { describe, expect, it } from 'vitest';
import { PHASES } from '../../../core/schemas/enums.js';
import { activeVerb, inlineActiveVerb } from './phase-verb.js';

describe('activeVerb', () => {
  it('says one verb for the planning session and names an old chain briefs call', () => {
    expect(activeVerb('planning', null, 'plan')).toBe('Planning…');
    expect(activeVerb('planning', null, 'tasks')).toBe('Compiling briefs…');
  });

  it('says only that it is planning until the engine names the call', () => {
    expect(activeVerb('planning', null, null)).toBe('Planning…');
    expect(activeVerb('planning', null, 'research')).toBe('Planning…');
  });

  it('never claims briefs are being compiled while the plan is still being written', () => {
    for (const call of ['plan', null] as const) {
      expect(activeVerb('planning', null, call)).not.toContain('briefs');
    }
  });

  it('names the call a gate runs to rewrite its document with the verb it has outside the gate', () => {
    expect(activeVerb('reviewing-spec', null, 'spec')).toBe(activeVerb('specifying', null, 'spec'));
    expect(activeVerb('reviewing-plan', null, 'plan')).toBe('Planning…');
    expect(activeVerb('reviewing-plan', null, null)).toBe('Reviewing plan…');
    expect(activeVerb('reviewing-briefs', null, 'tasks')).toBe('Compiling briefs…');
    expect(activeVerb('reviewing-briefs', null, null)).toBe('Reviewing briefs…');
  });

  it('leaves every other phase to its own verb, whatever call is named', () => {
    for (const phase of PHASES) {
      if (
        phase === 'planning' ||
        phase === 'reviewing-spec' ||
        phase === 'reviewing-plan' ||
        phase === 'reviewing-briefs'
      )
        continue;
      expect(activeVerb(phase, null, 'tasks')).toBe(activeVerb(phase, null, null));
    }
    expect(activeVerb('final-review', 'Sonnet 4.5', null)).toBe('Review… Sonnet 4.5');
    expect(activeVerb('final-review', null, null)).toBe('Review…');
  });
});

describe('inlineActiveVerb', () => {
  it('lowers the heading into a sentence with no ellipsis and no call', () => {
    expect(inlineActiveVerb('implementing')).toBe('implementing');
    expect(inlineActiveVerb('planning')).toBe('planning');
    expect(inlineActiveVerb('final-review')).toBe('review');
  });
});
