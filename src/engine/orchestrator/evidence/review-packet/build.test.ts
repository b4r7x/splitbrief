import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { makeSummary } from '#testing/helpers/factories/summary.js';
import { makeTask } from '#testing/helpers/factories/task.js';
import { cleanupTempDir, createTempDir } from '#testing/helpers/temp-dir.js';
import { createEvidenceLedger } from '../../../../core/evidence/ledger-state.js';
import { writeEvidenceLedger } from '../../../../core/evidence/ledger-storage.js';
import type { TaskTokenUsage } from '../../../../core/schemas/tokens.js';
import { ensureSessionDir } from '../../../../core/sessions/spec-files.js';
import { createInitialState } from '../../../../core/state/machine.js';
import { NULL_CACHE } from '../../../providers/model/runtime-snapshot.js';
import { buildReviewPacket } from './build.js';
import { renderReviewPacketMarkdown } from './render.js';

describe('review packet after a rewind', () => {
  const sessionId = 'packet-after-rewind';
  let projectDir: string;

  beforeEach(() => {
    projectDir = createTempDir(sessionId);
    ensureSessionDir(projectDir, sessionId);
  });

  afterEach(() => cleanupTempDir(projectDir));

  it('prints each settlement with its own route and usage in settlement order', async () => {
    const task = makeTask({ id: 'T001', title: 'Add greeting', status: 'done' });
    const first: TaskTokenUsage = {
      taskId: task.id,
      taskTitle: task.title,
      method: 'local',
      retryCount: 0,
      implementerTokens: 10,
      escalationTokens: 0,
      tool: 'codex',
      model: 'gpt-5',
      implementerProfile: 'quick',
      routingReason: 'The quick profile fits.',
    };
    const second: TaskTokenUsage = {
      ...first,
      method: 'escalated-hint',
      retryCount: 1,
      implementerTokens: 25,
      tool: 'opencode',
      model: 'deepseek/deepseek-flash',
      implementerProfile: 'careful',
      routingReason: 'The careful profile fits.',
    };
    const packet = await buildReviewPacket({
      projectDir,
      workspaceDir: projectDir,
      sessionId,
      finalReviewStatus: 'written',
      state: { ...createInitialState('Greeting'), tasks: [task], taskBreakdowns: [first, second] },
      summary: makeSummary({ taskBreakdown: [{ ...second, implementerTokens: 35, cost: 0.02 }] }),
    });

    expect(packet.routing.taskRouting).toEqual([first, second]);
    const routes = renderReviewPacketMarkdown(packet, NULL_CACHE)
      .split('## Routing\n')[1]
      ?.split('\n## ')[0]
      ?.split('\n')
      .filter((line) => line.startsWith('- T001:'));
    expect(routes).toEqual([
      '- T001: codex · GPT-5 · quick · The quick profile fits.',
      '- T001: opencode · DeepSeek Flash · careful · The careful profile fits.',
    ]);
  });

  it('counts only the current validation rows even when the ledger holds earlier work', async () => {
    const earlier = makeTask({ id: 'T002', title: 'Add farewell', status: 'done' });
    const current = makeTask({ id: 'T001', title: 'Add greeting', status: 'done' });
    writeEvidenceLedger(
      { projectDir, sessionId },
      createEvidenceLedger({ sessionId, feature: 'Greeting', tasks: [earlier, current] }),
    );
    const packet = await buildReviewPacket({
      projectDir,
      workspaceDir: projectDir,
      sessionId,
      finalReviewStatus: 'written',
      state: { ...createInitialState('Greeting'), tasks: [current] },
      summary: makeSummary({ totalTasks: 1, completedByLocal: 1 }),
    });

    expect(packet.run.totalTasks).toBe(1);
    expect(packet.validation.tasks).toEqual([
      { taskId: current.id, title: current.title, status: 'done', checks: [] },
    ]);
    expect(packet.validation.summary).toEqual({ passed: 1, failed: 0, skipped: 0, escalated: 0 });
    const markdown = renderReviewPacketMarkdown(packet, NULL_CACHE).split('\n');
    expect(markdown).toContain('- Tasks: 1 total, 0 escalated, 0 skipped, 0 failed');
    expect(markdown).toContain('- Validation: 1 passed, 0 failed, 0 skipped, 0 escalated');
    expect(markdown).toContain('- T001 done: no checks');
  });
});
