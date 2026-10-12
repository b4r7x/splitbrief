import { describe, expect, it } from 'vitest';
import { makeTask } from '#testing/helpers/factories/task.js';
import type { EvidenceTask } from '../schemas/evidence.js';
import type { Task } from '../schemas/task.js';
import { emptyEvidenceTask } from './ledger-state.js';
import { hashTaskBrief } from './brief-hash.js';
import { sameCurrentBrief } from './same-brief.js';

const brief = makeTask({ id: 'T002', title: 'Second', suggestedFiles: ['src/b.ts'] });

function entry(task: Task, overrides: Partial<EvidenceTask>): EvidenceTask {
  return { ...emptyEvidenceTask(task), briefHash: hashTaskBrief([task]), ...overrides };
}

describe('sameCurrentBrief', () => {
  it.each([
    ['done', 'done', true],
    ['in_progress', 'in_progress', true],
    ['in_progress', 'failed', true],
    ['in_progress', 'pending', true],
    ['in_progress', 'done', false],
    ['pending', 'pending', true],
    ['pending', 'failed', false],
  ] as const)(
    'a %s brief and a %s entry of its own hash: %s',
    (taskStatus, entryStatus, joined) => {
      const task = { ...brief, status: taskStatus };
      expect(sameCurrentBrief(entry(brief, { status: entryStatus }), task)).toBe(joined);
    },
  );

  it('joins the entry after the run wrote check results onto the brief', () => {
    const checked = {
      ...brief,
      status: 'done' as const,
      checkResults: [{ id: 'K1', status: 'pass' as const }],
    };
    expect(sameCurrentBrief(entry(brief, { status: 'done' }), checked)).toBe(true);
  });

  it('keeps the entry of an earlier revision of the brief apart', () => {
    const revised = { ...brief, status: 'done' as const, description: 'Rewritten by the consult' };
    expect(sameCurrentBrief(entry(brief, { status: 'done' }), revised)).toBe(false);
  });

  it.each([
    ['the same title and anchor file', brief, true],
    ['another anchor file', makeTask({ ...brief, suggestedFiles: ['src/c.ts'] }), false],
  ] as const)('joins an unstamped entry by title and anchor file: %s', (_name, task, joined) => {
    const unstamped = entry(brief, { status: 'done', briefHash: null });
    expect(sameCurrentBrief(unstamped, { ...task, status: 'done' })).toBe(joined);
  });
});
