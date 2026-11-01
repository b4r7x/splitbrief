import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import XtermHeadless from '@xterm/headless';
import { expect, it } from 'vitest';
import { loadConfig, writeConfig } from '../../../src/core/config/load/io.js';
import { sessionsRoot } from '../../../src/core/paths.js';
import { readRunEvents } from '../../../src/engine/events/replay.js';
import { reapOrphanRunners } from '../../../src/engine/orchestrator/run/orphan-reaper.js';
import { trustDeclaredRunners } from '#testing/helpers/runner-trust.js';
import { cleanupTempDir } from '#testing/helpers/temp-dir.js';
import { useTrustHome } from '#testing/helpers/trust-home.js';
import { passingVerdict } from '#testing/helpers/typed-planner.js';
import type { PtyExitEvent } from '../../integration/cli/pty/capability.js';
import { terminatePtyProcessGroup } from '../../integration/cli/pty/monitor.js';
import { runWithPtyChild, safeChildEnvironment } from '../../integration/cli/pty/run.js';
import {
  createStopContinueFixture,
  GREET_FILE,
  GREET_SOURCE,
  MARKER_FILE,
  MARKER_SOURCE,
  PLAN_ANSWER,
} from '../helpers/stop-continue-fixture.js';

it('shows reviewing changes, not answering again, on the first review after a refused planner answer', async () => {
  const target = createStopContinueFixture(
    () => `import { mkdirSync, writeFileSync } from 'node:fs';
for await (const chunk of process.stdin) void chunk;
mkdirSync('src', { recursive: true });
writeFileSync(${JSON.stringify(GREET_FILE)}, ${JSON.stringify(GREET_SOURCE)});
writeFileSync(${JSON.stringify(MARKER_FILE)}, ${JSON.stringify(MARKER_SOURCE)});
`,
    { isolation: 'none' },
  );
  const trustHome = useTrustHome('planner-refusal-review-activity');
  const planner = join(target.tmpDir, 'planner.mjs');
  const reviewer = join(target.tmpDir, 'reviewer.mjs');
  const plannerCalls = join(target.tmpDir, 'planner-calls');
  const started = join(target.tmpDir, 'review-started');
  const release = join(target.tmpDir, 'release-review');
  const releaseRepair = join(target.tmpDir, 'release-repair');
  const verdict = passingVerdict({ kind: 'final', taskIds: ['T001'], criterionIds: ['C1'] });
  writeFileSync(
    planner,
    `import { appendFileSync, existsSync } from 'node:fs';
import { setTimeout as delay } from 'node:timers/promises';
const chunks = [];
for await (const chunk of process.stdin) chunks.push(chunk);
const prompt = Buffer.concat(chunks).toString('utf8');
const repair = prompt.includes('It failed validation:');
appendFileSync(${JSON.stringify(plannerCalls)}, (repair ? 'repair' : 'plan') + '\\n');
while (repair && !existsSync(${JSON.stringify(releaseRepair)})) await delay(25);
process.stdout.write(repair ? ${JSON.stringify(JSON.stringify(PLAN_ANSWER))} : '{"result":{"kind":"plan"}}');
`,
  );
  writeFileSync(
    reviewer,
    `import { existsSync, writeFileSync } from 'node:fs';
import { setTimeout as delay } from 'node:timers/promises';
for await (const chunk of process.stdin) void chunk;
writeFileSync(${JSON.stringify(started)}, '');
while (!existsSync(${JSON.stringify(release)})) await delay(25);
console.log(${JSON.stringify(JSON.stringify(verdict))});
`,
  );
  const config = loadConfig(target.projectDir).config;
  if (config.planner.kind !== 'shell') throw new Error('Expected the shell planner fixture');
  writeConfig(target.projectDir, {
    ...config,
    planner: { ...config.planner, args: [planner] },
    reviewer: { kind: 'shell', command: process.execPath, args: [reviewer], outputFormat: 'text' },
  });
  try {
    const env: Readonly<Record<string, string>> = {
      ...safeChildEnvironment(trustHome.home),
      XDG_STATE_HOME: target.stateHome,
    };
    await trustDeclaredRunners({
      projectDir: target.projectDir,
      config: loadConfig(target.projectDir).config,
      pathEnv: env.PATH ?? '',
    });
    await runWithPtyChild(
      {
        requirement: 'required',
        argv: [
          '--import',
          'tsx',
          'src/cli.ts',
          'start',
          'smoke',
          '--allow-repo-runners',
          '--project',
          target.projectDir,
        ],
        spawnOptions: {
          name: 'xterm-256color',
          cols: 120,
          rows: 40,
          cwd: resolve(import.meta.dirname, '../../..'),
          env,
        },
      },
      async (child) => {
        const exit = Promise.withResolvers<PtyExitEvent>();
        let outcome: PtyExitEvent | undefined;
        const terminal = new XtermHeadless.Terminal({
          cols: 120,
          rows: 40,
          allowProposedApi: true,
          convertEol: true,
          scrollback: 0,
          logLevel: 'off',
        });
        const screen = () =>
          Array.from(
            { length: 40 },
            (_, row) => terminal.buffer.active.getLine(row)?.translateToString(true) ?? '',
          ).join('\n');
        let answeringAgainFrame: string | undefined;
        const dataListener = child.onData((data) =>
          terminal.write(data, () => {
            if (screen().includes('answering again')) answeringAgainFrame = screen();
          }),
        );
        const exitListener = child.onExit((event) => {
          outcome = event;
          exit.resolve(event);
        });
        // Each sample is one read of the screen, so a later paint cannot change what it asserts on.
        let frame = '';
        const sample = () => {
          frame = screen();
          return frame;
        };
        try {
          await expect
            .poll(sample, { timeout: 60_000 })
            .toMatch(/The planner seat answer did not match its contract\.[\s\S]*Planning…/);
          expect(frame.match(/seat answer did not match its contract/g)).toHaveLength(1);
          expect(frame).toContain('Wrong or missing value in result. Asking the seat again.');
          expect(frame).not.toContain('reviewing changes');
          writeFileSync(releaseRepair, '');
          await expect.poll(() => existsSync(started), { timeout: 60_000 }).toBe(true);
          await expect
            .poll(sample, { timeout: 10_000 })
            .toMatch(/Custom Shell · auto · (reviewing changes|answering again)/);
          expect(frame).toContain('Review · Custom Shell · auto · reviewing changes');
          expect(frame).not.toContain('answering again');
          writeFileSync(release, '');
          await expect.poll(screen, { timeout: 45_000 }).toContain('Complete · 1/1 briefs passed');
          child.write('\x11');
          await expect.poll(() => outcome, { timeout: 10_000 }).toBeDefined();
          expect(outcome?.exitCode, screen()).toBe(0);
          expect(answeringAgainFrame).toBeUndefined();
        } finally {
          writeFileSync(releaseRepair, '');
          writeFileSync(release, '');
          if (outcome === undefined) await terminatePtyProcessGroup(child, exit.promise);
          await reapOrphanRunners(target.projectDir);
          dataListener.dispose();
          exitListener.dispose();
          terminal.dispose();
        }
      },
    );
    expect(readFileSync(plannerCalls, 'utf8')).toBe('plan\nrepair\n');
    const sessionId = readdirSync(sessionsRoot(target.projectDir))[0];
    if (sessionId === undefined) throw new Error('CLI started without a run');
    const { events } = await readRunEvents({ projectDir: target.projectDir, sessionId });
    expect(
      events.filter((event) => event.type === 'warning' && event.code === 'seat_answer_refused'),
    ).toMatchObject([{ category: 'planner' }]);
  } finally {
    trustHome.restore();
    cleanupTempDir(target.tmpDir);
  }
});
