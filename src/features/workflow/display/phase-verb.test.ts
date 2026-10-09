import { describe, expect, it } from 'vitest';
import { PHASES } from '../../../core/schemas/enums.js';
import {
  activeVerb,
  inlineActiveVerb,
  suiteStageText,
  REVIEW_WAITING_VERDICT,
} from './phase-verb.js';

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
    expect(activeVerb('final-review', null, null)).toBe('Review · waiting for the verdict');
  });
});

describe('inlineActiveVerb', () => {
  it('lowers the heading into a sentence with no ellipsis and no call', () => {
    expect(inlineActiveVerb('implementing')).toBe('implementing');
    expect(inlineActiveVerb('planning')).toBe('planning');
    expect(inlineActiveVerb('final-review')).toBe('review');
  });
});

describe('suiteStageText', () => {
  it('names the moment of the full suite and the command it runs', () => {
    expect(suiteStageText({ moment: 'base', command: 'npm test -- src/legacy.test.ts' })).toBe(
      'Base re-run · npm test -- src/legacy.test.ts',
    );
    expect(suiteStageText({ moment: 'pre-review', command: 'npm run lint' })).toBe(
      'Pre-review suite · npm run lint',
    );
    expect(suiteStageText({ moment: 'pre-review', command: 'npm test' })).toBe(
      'Pre-review suite · npm test',
    );
  });

  it('names a reviewer check and its re-run at the run base by the check id', () => {
    expect(suiteStageText({ id: 'V2', moment: 'pre-review', command: 'npm test' })).toBe(
      'Reviewer check V2 · npm test',
    );
    expect(suiteStageText({ id: 'V2', moment: 'base', command: 'npm test' })).toBe(
      'Base re-run V2 · npm test',
    );
  });

  it('names a reviewer check a fix brief runs again as a fix check', () => {
    expect(suiteStageText({ id: 'V2', moment: 'brief', command: 'npm test' })).toBe(
      'Fix check V2 · npm test',
    );
  });
});

describe('REVIEW_WAITING_VERDICT', () => {
  it('is the status text while waiting for the verdict in final review', () => {
    expect(REVIEW_WAITING_VERDICT).toBe('Review · waiting for the verdict');
  });
});
