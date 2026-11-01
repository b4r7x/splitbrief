import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { loadConfig, writeConfig } from '../../../src/core/config/load/io.js';
import { sessionsRoot } from '../../../src/core/paths.js';
import { readRunEvents } from '../../../src/engine/events/replay.js';
import { reapOrphanRunners } from '../../../src/engine/orchestrator/run/orphan-reaper.js';
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
  PLAN_ANSWER,
} from '../helpers/stop-continue-fixture.js';

describe('e2e: a CLI that dies during the review', () => {
  it.each(['verify', 'reviewer'] as const)(
    'asks the reviewer again on continue (%s)',
    async (cut) => {
      const gatePlan = JSON.stringify({ result: { ...PLAN_ANSWER.result, gate: ['make check'] } });
      const target = createStopContinueFixture(
        () => `import { mkdirSync, writeFileSync } from 'node:fs';
for await (const chunk of process.stdin) void chunk;
mkdirSync('src', { recursive: true });
writeFileSync(${JSON.stringify(GREET_FILE)}, ${JSON.stringify(GREET_SOURCE)});
writeFileSync(${JSON.stringify(MARKER_FILE)}, ${JSON.stringify(MARKER_SOURCE)});
`,
        {
          isolation: 'none',
          consult: () =>
            `(prompt) => (prompt.includes('# Plan the change') ? ${JSON.stringify(gatePlan)} : undefined)`,
        },
      );
      const calls = join(target.tmpDir, 'reviewer-calls');
      const started = join(target.tmpDir, 'verify-started');
      const checkRuns = join(target.tmpDir, 'check-runs');
      const shims = join(target.tmpDir, 'bin');
      mkdirSync(shims);
      // The check writes its output into the tree, so its stored result never matches the next state.
      writeFakeNodeCli(
        shims,
        'make',
        `
const { appendFileSync, existsSync, readFileSync, writeFileSync } = require('node:fs');
appendFileSync(${JSON.stringify(checkRuns)}, 'run\\n');
writeFileSync('check-output.txt', readFileSync(${JSON.stringify(checkRuns)}, 'utf8'));
if (existsSync(${JSON.stringify(calls)}) && !existsSync(${JSON.stringify(started)})) {
  writeFileSync(${JSON.stringify(started)}, '');
  setInterval(() => {}, 1000);
}
`,
      );
      const restorePath = prependPath(shims);
      const passing = passingVerdict({ kind: 'final', taskIds: ['T001'], criterionIds: ['C1'] });
      const unverified = {
        ...passing,
        findings: [
          {
            id: 'F1',
            kind: 'unverified',
            severity: 'blocking',
            taskId: 'T001',
            file: null,
            line: null,
            text: 'the greeting may drop the name',
            acceptance: 'make check passes',
            checkIds: ['V1'],
            criterionId: null,
          },
        ],
      };
      const reviewer = join(target.tmpDir, 'reviewer.mjs');
      writeFileSync(
        reviewer,
        `import { appendFileSync, existsSync, writeFileSync } from 'node:fs';
for await (const chunk of process.stdin) void chunk;
const first = !existsSync(${JSON.stringify(calls)});
appendFileSync(${JSON.stringify(calls)}, 'call\\n');
if (first && ${JSON.stringify(cut)} === 'reviewer') {
  writeFileSync(${JSON.stringify(started)}, '');
  await new Promise(() => setInterval(() => {}, 1000));
}
console.log(first ? ${JSON.stringify(JSON.stringify(unverified))} : ${JSON.stringify(JSON.stringify(passing))});
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
        expect(
          before.some(
            (event) =>
              event.type === 'full_suite' &&
              event.id === 'V1' &&
              event.moment === 'verify' &&
              event.status === 'running',
          ),
        ).toBe(cut === 'verify');
        expect(before.some((event) => event.type === 'review_completed')).toBe(false);
        expect(readFileSync(calls, 'utf8')).toBe('call\n');

        const resumed = await cli(target, ['continue', sessionId]);

        expect(readFileSync(calls, 'utf8')).toBe('call\ncall\n');
        expect(resumed.exitCode, resumed.stderr).toBe(0);
        expect(resumed.stdout).toContain('review: passed\n');
        expect(resumed.stdout).not.toContain('review: stopped');
      } finally {
        if (pid !== undefined) process.kill(-pid, 'SIGKILL');
        if (running !== undefined) await running;
        await reapOrphanRunners(target.projectDir);
        restorePath();
        cleanupTempDir(target.tmpDir);
      }
    },
  );
});
