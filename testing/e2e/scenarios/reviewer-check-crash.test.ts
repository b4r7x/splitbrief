import { existsSync, mkdirSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { loadConfig, writeConfig } from '../../../src/core/config/load/io.js';
import { sessionsRoot } from '../../../src/core/paths.js';
import { groupEventsIntoSections } from '../../../src/core/sections/event-sections.js';
import { readRunEvents } from '../../../src/engine/events/replay.js';
import { reapOrphanRunners } from '../../../src/engine/orchestrator/run/orphan-reaper.js';
import { mergeEventLog } from '../../../src/stores/workflow/events.js';
import { prependPath, writeFakeNodeCli } from '#testing/helpers/command-shim.js';
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

it('settles the first review separately when the CLI crashes during a reviewer check', async () => {
  const target = createStopContinueFixture(
    () => `import { mkdirSync, writeFileSync } from 'node:fs';
for await (const chunk of process.stdin) void chunk;
mkdirSync('src', { recursive: true });
writeFileSync(${JSON.stringify(GREET_FILE)}, ${JSON.stringify(GREET_SOURCE)});
writeFileSync(${JSON.stringify(MARKER_FILE)}, ${JSON.stringify(MARKER_SOURCE)});
`,
    { isolation: 'none' },
  );
  const started = join(target.tmpDir, 'check-started');
  const shims = join(target.tmpDir, 'bin');
  mkdirSync(shims);
  writeFakeNodeCli(
    shims,
    'make',
    `
const { existsSync, writeFileSync } = require('node:fs');
if (!existsSync(${JSON.stringify(started)})) {
  writeFileSync(${JSON.stringify(started)}, '');
  setInterval(() => {}, 1000);
}
`,
  );
  const restorePath = prependPath(shims);
  const reviewer = join(target.tmpDir, 'reviewer.mjs');
  const checks = {
    commands: [{ id: 'V1', command: 'make check', reason: 'Verify the greeting.' }],
    declined: [],
    reason: null,
  };
  const verdict = passingVerdict({ kind: 'final', taskIds: ['T001'], criterionIds: ['C1'] });
  writeFileSync(
    reviewer,
    `const chunks = [];
for await (const chunk of process.stdin) chunks.push(chunk);
const prompt = Buffer.concat(chunks).toString('utf8');
console.log(prompt.includes('# Choose the checks for this review') ? ${JSON.stringify(JSON.stringify(checks))} : ${JSON.stringify(JSON.stringify(verdict))});
`,
  );
  const config = loadConfig(target.projectDir).config;
  writeConfig(target.projectDir, {
    ...config,
    validation: { ...config.validation, endChecks: true },
    reviewer: { kind: 'shell', command: 'node', args: [reviewer], outputFormat: 'text' },
  });
  let pid: number | undefined;
  let running: ReturnType<typeof cli> | undefined;
  try {
    running = cli(target, ['start', 'smoke'], {
      timeoutMs: 60_000,
      onSpawn: (value) => {
        pid = value;
      },
    });
    await expect.poll(() => existsSync(started), { timeout: 45_000, interval: 25 }).toBe(true);
    if (pid === undefined) throw new Error('CLI started without a process id');
    process.kill(-pid, 'SIGKILL');
    await running;
    pid = undefined;
    await reapOrphanRunners(target.projectDir);
    const sessionId = readdirSync(sessionsRoot(target.projectDir))[0];
    if (sessionId === undefined) throw new Error('CLI started without a run');
    const before = (await readRunEvents({ projectDir: target.projectDir, sessionId })).events;
    const firstStart = before.find((event) => event.type === 'review_started');
    const last = before.at(-1);
    if (firstStart === undefined || last === undefined) throw new Error('Missing review attempt');
    expect(
      before.some(
        (event) => event.type === 'full_suite' && event.id === 'V1' && event.status === 'running',
      ),
    ).toBe(true);
    expect(before.some((event) => event.type === 'review_completed')).toBe(false);
    expect(
      before.some((event) => event.type === 'runner_call_error' && event.role === 'review'),
    ).toBe(false);
    const resumed = await cli(target, ['continue', sessionId]);
    expect(resumed.exitCode, resumed.stderr).toBe(0);
    const { events } = await readRunEvents({ projectDir: target.projectDir, sessionId });
    const attempts = groupEventsIntoSections(events).filter(
      (section) => section.type === 'settled-stage' && section.summary.stage === 'review',
    );
    expect(attempts).toHaveLength(2);
    expect(attempts[0]).toMatchObject({
      summary: { outcome: 'stopped', duration: last.ts - firstStart.ts, rerunsBefore: 0 },
    });
    expect(attempts[1]).toMatchObject({ summary: { outcome: 'passed', rerunsBefore: 1 } });
    const resumedAt = events.findIndex((event) => event.type === 'workflow_resumed');
    expect(attempts[0]?.items).not.toContainEqual(events[resumedAt]);
    const completion = events.find((event) => event.type === 'review_completed');
    if (completion?.type !== 'review_completed') throw new Error('Missing completed review');
    expect(attempts[1]).toMatchObject({ summary: { duration: completion.duration } });
    const replayed = groupEventsIntoSections(mergeEventLog(events)).filter(
      (section) => section.type === 'settled-stage' && section.summary.stage === 'review',
    );
    expect(replayed[0]).toMatchObject({
      summary: { outcome: 'stopped', duration: last.ts - firstStart.ts },
    });
    expect(replayed[0]?.items).toContainEqual(
      expect.objectContaining({ type: 'full_suite', id: 'V1', status: 'stopped' }),
    );
    expect(replayed[1]?.items).toContainEqual(
      expect.objectContaining({ type: 'full_suite', id: 'V1', status: 'done', passed: true }),
    );
  } finally {
    if (pid !== undefined) process.kill(-pid, 'SIGKILL');
    if (running !== undefined) await running;
    await reapOrphanRunners(target.projectDir);
    restorePath();
    cleanupTempDir(target.tmpDir);
  }
});
