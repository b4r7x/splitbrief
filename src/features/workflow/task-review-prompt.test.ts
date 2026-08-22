import { describe, expect, it } from 'vitest';
import { createElement } from 'react';
import {
  TASK_REVIEW_COMMANDS,
  type TaskReviewRequest,
} from '../../engine/events/workflow-events.js';
import { taskId } from '../../core/schemas/task.js';
import { glyph } from '../../lib/glyphs.js';
import { renderFeature, tick } from '#testing/helpers/ink.js';
import { stripAnsiStyles } from '#testing/helpers/ansi.js';
import { PromptBody } from './components/prompt-body.js';
import { formatTaskReviewPrompt, parseTaskReviewAnswer } from './task-review-prompt.js';
import { makeUsage } from '#testing/helpers/factories/summary.js';

async function renderPromptBody(prompt: string): Promise<string> {
  const ui = renderFeature(createElement(PromptBody, { prompt, height: 40, width: 120 }));
  await tick(20);
  const text = stripAnsiStyles(ui.lastFrame() ?? '');
  ui.unmount();
  return text;
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
    path: '/tmp/project/.splitbrief/sessions/s1/evidence.json',
    summary: 'task reached done; test passed',
    expected: ['auth works'],
    observed: ['task reached done'],
  },
  cost: {
    tokenUsage: makeUsage({ implementerInput: 10, implementerOutput: 5 }),
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
  it('builds task metadata, evidence, cost, routing, and commands', async () => {
    const visible = await renderPromptBody(formatTaskReviewPrompt(request));

    expect(visible).toContain('T001 ready for review · Add auth');
    expect(visible).toContain('status done');
    expect(visible).toContain('files src/auth.ts');
    expect(visible).toContain('checks validation passed');
    expect(visible).toContain('evidence task reached done; test passed');
    expect(visible).toMatch(/15 implementer, 0 escalation/);
    expect(visible).toMatch(/route fits 120\/1000 tokens/);
    expect(visible).toContain('[c]  continue');
    expect(visible).toContain('[r]  redo task');
    expect(visible).toContain('[p]  revise-plan <notes>');
    expect(visible).toContain('[a]  abort');
    expect(visible).toContain('notes <text>');
    expect(visible).toContain(`${glyph('liveBar')} [c]  continue`);
  });

  it('flags a failed review headline with the task title detail', async () => {
    const visible = await renderPromptBody(
      formatTaskReviewPrompt({
        ...request,
        validation: { ...request.validation, passed: false, summary: 'tests failed' },
      }),
    );

    expect(visible).toContain('T001');
    expect(visible).toContain('failed');
    expect(visible).toContain('review · Add auth');
    expect(visible).toContain('checks tests failed');
  });

  it('serializes the passing review rows into a flat prompt with the ✓ and accent markers', () => {
    const prompt = formatTaskReviewPrompt(request);

    expect(prompt).toContain(`${glyph('check')} T001 ready for review · Add auth`);
    expect(prompt).toContain('evidence path /tmp/project/.splitbrief/sessions/s1/evidence.json');
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

  it('does not expose notes as a blank shortcut action key', async () => {
    const visible = await renderPromptBody(formatTaskReviewPrompt(request));
    expect(visible).not.toContain('[ ]');
    expect(visible).toContain('notes <text>');
  });
});
