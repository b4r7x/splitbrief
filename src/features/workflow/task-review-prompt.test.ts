import { describe, expect, it } from 'vitest';
import {
  TASK_REVIEW_COMMANDS,
  type TaskReviewRequest,
} from '../../engine/events/workflow-events.js';
import { taskId } from '../../core/schemas/task.js';
import { formatTaskReviewPrompt, parseTaskReviewAnswer } from './task-review-prompt.js';

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
  it('renders task metadata, evidence, cost, routing, and commands', () => {
    const prompt = formatTaskReviewPrompt(request);

    expect(prompt).toContain('T001 - Add auth');
    expect(prompt).toContain('Status: done');
    expect(prompt).toContain('src/auth.ts');
    expect(prompt).toContain('Validation: validation passed');
    expect(prompt).toContain('Evidence path: /tmp/project/.diptych/sessions/s1/evidence.json');
    expect(prompt).toContain('15 implementer, 0 escalation');
    expect(prompt).toContain('Route: fits 120/1000 tokens');
    expect(prompt).toContain('continue, redo, notes <text>, revise-plan <notes>, abort');
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

  it('returns null for unrecognized non-empty input instead of accepting', () => {
    expect(parseTaskReviewAnswer('rdo')).toBeNull();
    expect(parseTaskReviewAnswer('redo it please')).toBeNull();
    expect(parseTaskReviewAnswer('!!!')).toBeNull();
  });

  it('treats bare Enter as the only implicit accept', () => {
    expect(parseTaskReviewAnswer('   ')).toEqual({ action: 'continue' });
  });
});
