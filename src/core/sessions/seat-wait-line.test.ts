import { describe, expect, it } from 'vitest';
import type { SeatWait, WorkflowState } from '../schemas/workflow.js';
import { createInitialState } from '../state/machine.js';
import { seatWaitToolWord } from './seat-wait-line.js';

describe('seatWaitToolWord', () => {
  const resetAt = '2026-09-01T17:00:00.000Z';
  function waitTool(started: Partial<WorkflowState>, wait: SeatWait): string {
    return seatWaitToolWord({ ...createInitialState('feat'), ...started }, wait);
  }

  it.each([
    { tool: 'codex', kind: 'cli', word: 'OpenAI Codex CLI' },
    { tool: 'claude-code', kind: 'cli', word: 'Claude Code CLI' },
    { tool: 'opencode', kind: 'cli', word: 'OpenCode CLI' },
    { tool: 'ollama', kind: 'api', word: 'Ollama' },
    { tool: 'my-endpoint', kind: 'api', word: 'my-endpoint' },
    { tool: 'shell', kind: 'shell', word: 'Custom Shell' },
    { tool: 'agent', kind: 'agent', word: 'Agent' },
  ] as const)(
    'names the recorded $kind runner $tool by its catalog name',
    ({ tool, kind, word }) => {
      expect(
        waitTool(
          { plannerTool: 'claude-code', implementerTool: 'claude-code' },
          { seat: 'build', resetAt, tool, kind },
        ),
      ).toBe(word);
    },
  );

  it.each([
    {
      seat: 'plan',
      started: { plannerTool: 'codex', plannerKind: 'cli' },
      word: 'OpenAI Codex CLI',
    },
    {
      seat: 'build',
      started: { implementerTool: 'ollama', implementerKind: 'api' },
      word: 'Ollama',
    },
    {
      seat: 'build',
      started: { implementerTool: 'shell', implementerKind: 'shell' },
      word: 'Custom Shell',
    },
    {
      seat: 'review',
      started: { reviewerTool: 'agent', reviewerKind: 'agent', plannerTool: 'codex' },
      word: 'Agent',
    },
    {
      seat: 'review',
      started: { plannerTool: 'codex', plannerKind: 'cli' },
      word: 'OpenAI Codex CLI',
    },
  ] as const)(
    'names the $seat tool the run started on when an older wait recorded none',
    ({ seat, started, word }) => {
      expect(waitTool(started, { seat, resetAt })).toBe(word);
    },
  );

  it('names the seat when neither the wait nor the run recorded a tool', () => {
    expect(waitTool({}, { seat: 'build', resetAt })).toBe('BUILD');
  });
});
