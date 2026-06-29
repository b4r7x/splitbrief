import { describe, it, expect } from 'vitest';
import { buildSummary } from './summary.js';
import { taskId } from '../../core/schemas/task.js';
import { makeUsage } from '#testing/helpers/factories/summary.js';
import { makeTask } from '#testing/helpers/factories/task.js';
import { TRANSCRIPT_OMITTED_MESSAGE } from '../../core/transcript-policy.js';

const SENTINEL = 'summary-breakdown-sentinel-90412';

function breakdownWithProse() {
  return [
    {
      taskId: taskId('T001'),
      taskTitle: `secret title ${SENTINEL}`,
      method: 'local' as const,
      implementerTokens: 100,
      escalationTokens: 0,
      retryCount: 0,
      tool: 'ollama',
      model: 'qwen-local',
      implementerProfile: 'local-small',
      routingReason: `routing prose ${SENTINEL}`,
      costPosture: `posture prose ${SENTINEL}`,
    },
  ];
}

describe('buildSummary taskBreakdown transcript policy', () => {
  it('redacts title, routing reason, and cost posture when transcript persistence is disabled', () => {
    const summary = buildSummary({
      feature: 'redacted',
      state: { tasks: [makeTask({ id: 'T001', status: 'done' })], tokenUsage: makeUsage() },
      startTime: Date.now(),
      taskBreakdowns: breakdownWithProse(),
      plannerTool: 'claude-code',
      implementerTool: 'ollama',
      persistTranscript: false,
    });

    const row = summary.taskBreakdown?.[0];
    if (!row) throw new Error('expected a task breakdown row');
    expect(row.taskTitle).toBe(TRANSCRIPT_OMITTED_MESSAGE);
    expect(row.routingReason).toBe(TRANSCRIPT_OMITTED_MESSAGE);
    expect(row.costPosture).toBe(TRANSCRIPT_OMITTED_MESSAGE);
    expect(JSON.stringify(summary.taskBreakdown)).not.toContain(SENTINEL);
  });

  it('keeps non-prose routing metadata intact when redacting', () => {
    const summary = buildSummary({
      feature: 'redacted',
      state: { tasks: [makeTask({ id: 'T001', status: 'done' })], tokenUsage: makeUsage() },
      startTime: Date.now(),
      taskBreakdowns: breakdownWithProse(),
      plannerTool: 'claude-code',
      implementerTool: 'ollama',
      persistTranscript: false,
    });

    const row = summary.taskBreakdown?.[0];
    if (!row) throw new Error('expected a task breakdown row');
    expect(row.taskId).toBe(taskId('T001'));
    expect(row.tool).toBe('ollama');
    expect(row.model).toBe('qwen-local');
    expect(row.implementerProfile).toBe('local-small');
    expect(row.implementerTokens).toBe(100);
  });

  it('preserves task breakdown prose when transcript persistence is enabled', () => {
    const summary = buildSummary({
      feature: 'kept',
      state: { tasks: [makeTask({ id: 'T001', status: 'done' })], tokenUsage: makeUsage() },
      startTime: Date.now(),
      taskBreakdowns: breakdownWithProse(),
      plannerTool: 'claude-code',
      implementerTool: 'ollama',
      persistTranscript: true,
    });

    const row = summary.taskBreakdown?.[0];
    if (!row) throw new Error('expected a task breakdown row');
    expect(row.taskTitle).toBe(`secret title ${SENTINEL}`);
    expect(row.routingReason).toBe(`routing prose ${SENTINEL}`);
    expect(row.costPosture).toBe(`posture prose ${SENTINEL}`);
  });
});
