import { describe, expect, it } from 'vitest';
import {
  TASK_REVIEW_COMMANDS,
  type TaskReviewRequest,
} from '../../engine/events/workflow-events.js';
import { taskId } from '../../core/schemas/task.js';
import { glyph } from '../../lib/glyphs.js';
import type { PromptRow } from './recovery-prompt.js';
import {
  buildTaskReviewPromptRows,
  formatTaskReviewPrompt,
  parseTaskReviewAnswer,
} from './task-review-prompt.js';

function factItems(rows: PromptRow[]): string[] {
  const row = rows.find((r): r is Extract<PromptRow, { kind: 'facts' }> => r.kind === 'facts');
  return row?.items ?? [];
}

function actionRows(rows: PromptRow[]): Extract<PromptRow, { kind: 'action' }>[] {
  return rows.filter((r): r is Extract<PromptRow, { kind: 'action' }> => r.kind === 'action');
}

const request: TaskReviewRequest = {
  taskId: taskId('T001'),
  taskTitle: 'Add auth',
  status: 'done',
  filesTouched: ['src/auth.ts'],
  validation: {
    passed: true,
    summary: 'validation passed',
    stages: [{ stage: 'test', passed: true }],
  },
  evidence: {
    path: '/tmp/project/.diptych/sessions/s1/evidence.json',
    summary: 'task reached done; test passed',
    expected: ['auth works'],
    observed: ['task reached done'],
  },
  cost: {
    tokenUsage: {
      plannerInput: 0,
      plannerOutput: 0,
      implementerInput: 10,
      implementerOutput: 5,
      escalationInput: 0,
      escalationOutput: 0,
    },
    taskTokens: {
      taskId: taskId('T001'),
      taskTitle: 'Add auth',
      method: 'local',
      implementerTokens: 15,
      escalationTokens: 0,
      retryCount: 0,
    },
    tool: 'ollama',
    model: 'qwen',
    implementerProfile: 'local-small',
  },
  routing: {
    selectedProfile: 'local-small',
    fit: 'fits',
    estimatedTokens: 120,
    untruncatedEstimatedTokens: 120,
    contextLength: 1000,
    currentCodeTruncated: false,
    currentCodeContextMode: 'none',
    costPosture: 'local',
    reason: 'Selected cheapest capable profile local-small.',
  },
  availableCommands: [...TASK_REVIEW_COMMANDS],
};

describe('task review prompt', () => {
  it('builds task metadata, evidence, cost, routing, and commands', () => {
    const rows = buildTaskReviewPromptRows(request);

    expect(rows[0]).toEqual({
      kind: 'headline',
      tone: 'pass',
      text: 'T001 ready for review · Add auth',
    });
    const facts = factItems(rows);
    expect(facts).toContain('status done');
    expect(facts).toContain('files src/auth.ts');
    expect(facts).toContain('checks validation passed');
    expect(facts).toContain('evidence path /tmp/project/.diptych/sessions/s1/evidence.json');
    expect(facts.some((f) => f.includes('15 implementer, 0 escalation'))).toBe(true);
    expect(facts.some((f) => f.startsWith('route fits 120/1000 tokens'))).toBe(true);

    const commands = actionRows(rows).map((r) => r.text);
    expect(commands).toContain('[c]  continue');
    expect(commands).toContain('[r]  redo task');
    expect(commands).toContain('[p]  revise-plan <notes>');
    expect(commands).toContain('[a]  abort');
    expect(rows.some((r) => r.kind === 'note' && r.text.includes('notes <text>'))).toBe(true);
    expect(actionRows(rows).find((r) => r.recommended)?.text).toBe('[c]  continue');
  });

  it('flags a failed review headline with the task title detail', () => {
    const rows = buildTaskReviewPromptRows({
      ...request,
      validation: { ...request.validation, passed: false, summary: 'tests failed' },
    });

    expect(rows[0]).toEqual({
      kind: 'headline',
      tone: 'failed',
      text: 'T001',
      detail: 'Add auth',
    });
    expect(factItems(rows)).toContain('checks tests failed');
  });

  it('serializes the passing review rows into a flat prompt with the ✓ and accent markers', () => {
    const prompt = formatTaskReviewPrompt(request);

    expect(prompt).toContain(`${glyph('check')} T001 ready for review · Add auth`);
    expect(prompt).toContain(`${glyph('liveBar')} [c]  continue`);
    expect(prompt).toContain('[r]  redo task');
  });

  it('serializes a failed review headline with its cause', () => {
    const prompt = formatTaskReviewPrompt({
      ...request,
      validation: { ...request.validation, passed: false, summary: 'tests failed' },
    });

    expect(prompt).toContain('T001 failed review · Add auth');
  });

  it('parses review commands into public task review decisions', () => {
    expect(parseTaskReviewAnswer('')).toEqual({ action: 'continue' });
    expect(parseTaskReviewAnswer('redo')).toEqual({ action: 'redo-task' });
    expect(parseTaskReviewAnswer('revise-plan split this task')).toEqual({
      action: 'revise-plan',
      notes: 'split this task',
    });
    expect(parseTaskReviewAnswer('notes looks fine')).toEqual({
      action: 'continue',
      notes: 'looks fine',
    });
    expect(parseTaskReviewAnswer('edit keep this context for the next recovery')).toEqual({
      action: 'continue',
      notes: 'keep this context for the next recovery',
    });
    expect(parseTaskReviewAnswer('abort')).toEqual({ action: 'abort' });
  });

  it('rejects commands outside the request-scoped available command set', () => {
    expect(parseTaskReviewAnswer('', ['abort'])).toBeNull();
    expect(parseTaskReviewAnswer('redo', ['continue'])).toBeNull();
    expect(parseTaskReviewAnswer('revise-plan split this task', ['continue'])).toBeNull();
    expect(parseTaskReviewAnswer('abort', ['continue'])).toBeNull();
    expect(parseTaskReviewAnswer('notes keep this context', ['continue'])).toBeNull();
    expect(parseTaskReviewAnswer('notes keep this context', ['edit-notes'])).toEqual({
      action: 'continue',
      notes: 'keep this context',
    });
  });

  it('returns null for unrecognized non-empty input instead of accepting', () => {
    expect(parseTaskReviewAnswer('rdo')).toBeNull();
    expect(parseTaskReviewAnswer('redo it please')).toBeNull();
    expect(parseTaskReviewAnswer('!!!')).toBeNull();
  });

  it('treats bare Enter as the only implicit accept', () => {
    expect(parseTaskReviewAnswer('')).toEqual({ action: 'continue' });
    expect(parseTaskReviewAnswer('   ')).toEqual({ action: 'continue' });
  });

  it('does not expose notes as a blank shortcut action key', () => {
    const rows = buildTaskReviewPromptRows(request);
    expect(actionRows(rows).some((r) => r.text.includes('[ ]'))).toBe(false);
    expect(rows.some((r) => r.kind === 'note' && r.text.includes('notes <text>'))).toBe(true);
  });
});
