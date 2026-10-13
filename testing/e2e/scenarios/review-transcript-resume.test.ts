import { existsSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { createElement, Fragment } from 'react';
import { renderToString } from 'ink';
import { ConversationRowView } from '../../../src/features/workflow/components/conversation-flow/row-view.js';
import { loadConfig, writeConfig } from '../../../src/core/config/load/io.js';
import { sessionsRoot } from '../../../src/core/paths.js';
import { readRunEvents } from '../../../src/engine/events/replay.js';
import { reapOrphanRunners } from '../../../src/engine/orchestrator/run/orphan-reaper.js';
import { groupEventsIntoSections } from '../../../src/core/sections/event-sections.js';
import { resetWorkflow } from '../../../src/stores/workflow/actions/reset.js';
import { addEvent } from '../../../src/stores/workflow/actions/event.js';
import { getSections } from '../../../src/stores/workflow/actions/sections.js';
import { operationsStore } from '../../../src/stores/workflow/operations/state.js';
import {
  reviewActivityParts,
  reviewActivitySpans,
} from '../../../src/features/workflow/display/phase-verb.js';
import { buildConversationRows } from '#testing/helpers/event-rows.js';
import { passingVerdict } from '#testing/helpers/typed-planner.js';
import { cleanupTempDir } from '#testing/helpers/temp-dir.js';
import {
  cli,
  createStopContinueFixture,
  GREET_FILE,
  GREET_SOURCE,
  MARKER_FILE,
  MARKER_SOURCE,
} from '../helpers/stop-continue-fixture.js';

it('keeps both review attempts and their elapsed times after a CLI crash and continue', async () => {
  const target = createStopContinueFixture(
    () => `import { mkdirSync, writeFileSync } from 'node:fs';
for await (const chunk of process.stdin) void chunk;
mkdirSync('src', { recursive: true });
writeFileSync(${JSON.stringify(GREET_FILE)}, ${JSON.stringify(GREET_SOURCE)});
writeFileSync(${JSON.stringify(MARKER_FILE)}, ${JSON.stringify(MARKER_SOURCE)});
`,
    { isolation: 'none' },
  );
  const started = join(target.tmpDir, 'review-started');
  const reviewer = join(target.tmpDir, 'reviewer.mjs');
  const answer = passingVerdict({ kind: 'final', taskIds: ['T001'], criterionIds: ['C1'] });
  writeFileSync(
    reviewer,
    `import { existsSync, writeFileSync } from 'node:fs';
for await (const chunk of process.stdin) void chunk;
if (!existsSync(${JSON.stringify(started)})) {
  writeFileSync(${JSON.stringify(started)}, '');
  setInterval(() => {}, 1000);
} else {
  console.log(${JSON.stringify(JSON.stringify(answer))});
}
`,
  );
  const config = loadConfig(target.projectDir).config;
  writeConfig(target.projectDir, {
    ...config,
    reviewer: { kind: 'shell', command: 'node', args: [reviewer], outputFormat: 'text' },
  });
  let pid: number | undefined;
  let running: ReturnType<typeof cli> | undefined;
  try {
    running = cli(target, ['start', 'smoke'], {
      timeoutMs: 60_000,
      onSpawn: (startedPid) => {
        pid = startedPid;
      },
    });
    await expect.poll(() => existsSync(started), { timeout: 45_000, interval: 25 }).toBe(true);
    if (pid === undefined) throw new Error('CLI started without a process id');
    process.kill(pid, 'SIGKILL');
    await running;
    pid = undefined;
    await reapOrphanRunners(target.projectDir);
    const sessionId = readdirSync(sessionsRoot(target.projectDir))[0];
    if (sessionId === undefined) throw new Error('CLI started without a run');
    const resumed = await cli(target, ['continue', sessionId]);
    expect(resumed.exitCode, resumed.stderr).toBe(0);
    const { events } = await readRunEvents({ projectDir: target.projectDir, sessionId });
    resetWorkflow();
    for (const event of events) {
      addEvent(event);
      if (event.type === 'review_checks' && event.status === 'off') {
        expect(
          reviewActivitySpans(reviewActivityParts(operationsStore.get().active, null))
            .map((part) => part.text)
            .join(''),
        ).not.toContain('choosing checks');
      }
    }
    expect(events.flatMap((event) => (event.type === 'review_step' ? [event.step] : []))).toEqual([
      'verdict',
      'verdict',
    ]);
    const attempts = groupEventsIntoSections(events).filter(
      (section) => section.type === 'settled-stage' && section.summary.stage === 'review',
    );
    expect(attempts).toHaveLength(2);
    expect(attempts[0]).toMatchObject({ summary: { outcome: 'stopped' } });
    expect(attempts[1]).toMatchObject({ summary: { outcome: 'passed', rerunsBefore: 1 } });
    const { rows } = buildConversationRows({
      sections: getSections(),
      cols: 120,
      viewportHeight: 100,
      expandedDiffs: new Set(),
      expandedActivityBatches: new Set(),
      streaming: { taskId: null, lines: [], active: false },
    });
    const text = renderToString(
      createElement(
        Fragment,
        null,
        ...rows.map((row) => createElement(ConversationRowView, { key: row.key, row })),
      ),
    );
    expect(text).toContain('Final review stopped');
    expect(text).toContain('Run continued');
    expect(text).toContain('Final review re-run passed');
    expect(text.indexOf('Final review stopped')).toBeLessThan(text.indexOf('Run continued'));
    expect(text.indexOf('Run continued')).toBeLessThan(text.indexOf('Final review re-run passed'));
    const completed = events.find(
      (event) => event.type === 'review_completed' && event.verdict === 'pass',
    );
    if (completed?.type !== 'review_completed') throw new Error('Missing completed review');
    expect(attempts[1]).toMatchObject({ summary: { duration: completed.duration } });
  } finally {
    if (pid !== undefined) process.kill(pid, 'SIGKILL');
    if (running !== undefined) await running;
    await reapOrphanRunners(target.projectDir);
    resetWorkflow();
    cleanupTempDir(target.tmpDir);
  }
});
