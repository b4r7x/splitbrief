import { readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { SESSIONS_DIR, SPLITBRIEF_DIR, reviewPacketMarkdownPath } from '../../../src/core/paths.js';
import { readinessCheckLines } from '../../../src/core/readiness/format.js';
import { groupEventsIntoSections } from '../../../src/core/sections/group.js';
import { readRunEvents } from '../../../src/engine/events/replay.js';
import { buildConversationRows } from '#testing/helpers/event-rows.js';
import { rowText } from '../../../src/features/workflow/conversation-rows/row-format/rows.js';
import { buildConversationRowActions } from '../../../src/features/workflow/conversation-rows/row-actions/build.js';
import { readReadinessArtifact } from '../../../src/engine/orchestrator/evidence/review-packet/artifacts.js';
import { makeE2eScenarioConfig } from '../helpers/config.js';
import { runE2eWorkflow, setupE2eScenario } from '../helpers/harness.js';

const scenario = {
  name: 'checkout mode - start warning on a dirty checkout',
  cassetteName: 'quick-trivial-edit',
  feature: 'fix typo in README',
  config: makeE2eScenarioConfig({ workflow: { isolation: 'none' } }),
};

describe('e2e: a checkout-mode run started on uncommitted edits', () => {
  const ctx = setupE2eScenario(scenario);

  it('states the readiness warning under the request and keeps its fix in the run record', async () => {
    writeFileSync(join(ctx.projectDir, 'my-notes.txt'), 'my own notes\n', 'utf-8');

    await runE2eWorkflow(ctx, scenario);

    const [sessionId = ''] = readdirSync(join(ctx.projectDir, SPLITBRIEF_DIR, SESSIONS_DIR));
    const REVERTED = `${SPLITBRIEF_DIR}/${SESSIONS_DIR}/${sessionId}/reverted/`;
    const record = readReadinessArtifact(ctx.projectDir, sessionId);
    if (record === null) throw new Error('Missing readiness.json');
    expect(record.checks).toContainEqual({
      id: 'repo.dirty-worktree',
      severity: 'warning',
      summary: 'Working tree has 1 untracked file.',
      details: [
        'Examples: my-notes.txt',
        'A revert keeps shared changes and changes it cannot attribute to this run.',
      ],
      remediation: `The run edits this checkout. A revert saves the files it replaces in ${REVERTED}. Commit or stash the edits you do not want this run to touch.`,
    });

    const stated = record.checks
      .filter((check) => check.severity === 'warning')
      .map((check) => readinessCheckLines(check).join('\n'));
    expect(stated).toContainEqual(expect.stringContaining('The run edits this checkout.'));
    const request = ctx.events.findIndex((event) => event.type === 'user_message');
    expect(
      ctx.events
        .slice(request + 1, request + 1 + stated.length)
        .map((event) => (event.type === 'warning' ? event.message : event.type)),
    ).toEqual(stated);
    const warnings = ctx.events.filter(
      (event) => event.type === 'warning' && event.message.includes(REVERTED),
    );
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toMatchObject({
      message: expect.stringContaining('\nExamples: my-notes.txt\n'),
    });

    const replay = await readRunEvents({ projectDir: ctx.projectDir, sessionId });
    for (const events of [ctx.events, replay.events]) {
      const index = events.findIndex(
        (event) => event.type === 'warning' && event.message.includes(REVERTED),
      );
      const event = events[index];
      if (event?.type !== 'warning') throw new Error('The saved checkout warning is missing');
      const input = {
        sections: groupEventsIntoSections(events.slice(0, index + 1)),
        expandedDiffs: new Set<string>(),
        expandedActivityBatches: new Set<string>(),
        cols: 80,
        viewportHeight: 24,
        streaming: { taskId: null, lines: [], active: false },
      };
      const collapsed = buildConversationRows(input).rows.map(rowText).join('\n');
      expect(collapsed).toContain('This run edits your checkout');
      expect(collapsed).toContain('1 untracked file');
      expect(collapsed).not.toContain('my-notes.txt');
      expect(collapsed).toContain('ctrl+a');
      expect(collapsed.split('This run edits your checkout')).toHaveLength(2);
      const disclosure = buildConversationRows(input).rows.find((row) =>
        rowText(row).includes('Files and backup'),
      );
      if (!disclosure) throw new Error('Missing checkout disclosure');
      const action = buildConversationRowActions(input).get(disclosure.key);
      if (action?.type !== 'toggle-activity-batch') throw new Error('Checkout details must fold');
      const key = action.key;
      const expanded = buildConversationRows({ ...input, expandedActivityBatches: new Set([key]) })
        .rows.map(rowText)
        .join(' ');
      expect(expanded).toContain('Examples: my-notes.txt');
      expect(expanded).toContain('Backup on revert:');
      expect(expanded).not.toContain('Fix: The run edits this checkout.');
      expect(expanded.replaceAll(' ', '')).toContain(REVERTED);
    }

    const packet = readFileSync(
      reviewPacketMarkdownPath({ projectDir: ctx.projectDir, sessionId }),
      'utf-8',
    );
    expect(packet).toContain('- warning repo.dirty-worktree: Working tree has 1 untracked file.');
    expect(packet).toContain(`  - Fix: The run edits this checkout.`);
    expect(packet).toContain(REVERTED);
  });
});
