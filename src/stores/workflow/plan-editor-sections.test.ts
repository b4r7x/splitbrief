import { describe, expect, it } from 'vitest';
import { makeTask } from '#testing/helpers/factories/task.js';
import {
  TASK_BRIEF_SECTIONS,
  getTaskBriefSectionLabel,
  getTaskBriefSectionText,
  updateTaskBriefSection,
} from './plan-editor-sections.js';

describe('plan editor task brief sections', () => {
  it('exposes Evidence as an editable Task Brief section', () => {
    const task = makeTask({ evidence: ['npm test passes'] });

    expect(TASK_BRIEF_SECTIONS).toContain('evidence');
    expect(getTaskBriefSectionLabel('evidence')).toBe('Evidence');
    expect(getTaskBriefSectionText(task, 'evidence')).toBe('npm test passes');
  });

  it('updates and clears Evidence entries through the section updater', () => {
    const task = makeTask({ evidence: [] });

    const updated = updateTaskBriefSection(task, 'evidence', '- typecheck passes\n- UI smoke done');
    expect(updated.evidence).toEqual(['typecheck passes', 'UI smoke done']);

    const cleared = updateTaskBriefSection(updated, 'evidence', '');
    expect(cleared.evidence).toBeUndefined();
  });
});
