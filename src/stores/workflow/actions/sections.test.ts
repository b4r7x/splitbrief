import { describe, it, expect, beforeEach } from 'vitest';
import { addEvent } from './event.js';
import { resetWorkflow } from './reset.js';
import { getSections } from './sections.js';
import { makeRetry } from '#testing/helpers/events/task.js';
import { makePlannerText } from '#testing/helpers/events/planner.js';

describe('getSections', () => {
  beforeEach(() => resetWorkflow());

  it('reflects the current event stream', () => {
    addEvent(makeRetry());
    expect(getSections()).toHaveLength(1);
  });

  it('clears derived sections after workflow reset', () => {
    addEvent(makeRetry());
    expect(getSections()).toHaveLength(1);
    resetWorkflow();
    expect(getSections()).toEqual([]);
  });

  it('section cache returns same reference for unchanged events', () => {
    addEvent(makePlannerText({ text: 'hello' }));
    const a = getSections();
    const b = getSections();
    expect(a).toBe(b);
  });
});
