import { existsSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import XtermHeadless from '@xterm/headless';
import { expect, it } from 'vitest';
import { loadConfig, writeConfig } from '../../../src/core/config/load/io.js';
import { sessionsRoot } from '../../../src/core/paths.js';
import { readRunEvents } from '../../../src/engine/events/replay.js';
import { reapOrphanRunners } from '../../../src/engine/orchestrator/run/orphan-reaper.js';
import { PROMPT_TYPEAHEAD_GRACE_MS } from '../../../src/lib/terminal/typeahead-grace.js';
import { trustDeclaredRunners } from '#testing/helpers/runner-trust.js';
import { cleanupTempDir } from '#testing/helpers/temp-dir.js';
import { useTrustHome } from '#testing/helpers/trust-home.js';
import { passingVerdict } from '#testing/helpers/typed-planner.js';
import type { PtyExitEvent } from '../../integration/cli/pty/capability.js';
import { terminatePtyProcessGroup } from '../../integration/cli/pty/monitor.js';
import { runWithPtyChild, safeChildEnvironment } from '../../integration/cli/pty/run.js';
import {
  cli,
  createStopContinueFixture,
  GREET_FILE,
  GREET_SOURCE,
  MARKER_FILE,
  MARKER_SOURCE,
} from '../helpers/stop-continue-fixture.js';

it('shows reviewing changes during the verdict-only call after a reviewer question', async () => {
  const target = createStopContinueFixture(
    () => `import { mkdirSync, writeFileSync } from 'node:fs';
for await (const chunk of process.stdin) void chunk;
mkdirSync('src', { recursive: true });
writeFileSync(${JSON.stringify(GREET_FILE)}, ${JSON.stringify(GREET_SOURCE)});
writeFileSync(${JSON.stringify(MARKER_FILE)}, ${JSON.stringify(MARKER_SOURCE)});
`,
    { isolation: 'none' },
  );
  const trustHome = useTrustHome('review-question-activity');
  const reviewer = join(target.tmpDir, 'reviewer.mjs');
  const started = join(target.tmpDir, 'verdict-started');
  const release = join(target.tmpDir, 'release-verdict');
  const question = 'Keep the lowercase greeting?';
  const answer = 'KEEP_LOWERCASE';
  const verdict = passingVerdict({ kind: 'final', taskIds: ['T001'], criterionIds: ['C1'] });
  writeFileSync(
    reviewer,
    `import { existsSync, writeFileSync } from 'node:fs';
import { setTimeout as delay } from 'node:timers/promises';
const chunks = [];
for await (const chunk of process.stdin) chunks.push(chunk);
const prompt = Buffer.concat(chunks).toString('utf8');
if (prompt.includes('# Choose the checks for this review')) {
  console.log(JSON.stringify({ commands: [], declined: [], reason: 'The recorded plan checks verify the greeting.' }));
} else if (!prompt.includes(${JSON.stringify(answer)})) {
  console.log(${JSON.stringify(JSON.stringify({ ...verdict, ask: { question, whyOnlyUserCanAnswer: 'The user chooses the casing.' } }))});
} else {
  writeFileSync(${JSON.stringify(started)}, '');
  while (!existsSync(${JSON.stringify(release)})) await delay(25);
  console.log(${JSON.stringify(JSON.stringify({ ...verdict, rejected: [{ findingId: 'A1', reason: 'The answer keeps the greeting as built.' }] }))});
}
`,
  );
  const config = loadConfig(target.projectDir).config;
  writeConfig(target.projectDir, {
    ...config,
    validation: { ...config.validation, endChecks: true },
    reviewer: { kind: 'shell', command: process.execPath, args: [reviewer], outputFormat: 'text' },
  });
  try {
    await trustDeclaredRunners({
      projectDir: target.projectDir,
      config: loadConfig(target.projectDir).config,
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
          env: { ...safeChildEnvironment(trustHome.home), XDG_STATE_HOME: target.stateHome },
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
        const dataListener = child.onData((data) => terminal.write(data));
        const exitListener = child.onExit((event) => {
          outcome = event;
          exit.resolve(event);
        });
        try {
          await expect.poll(screen, { timeout: 45_000 }).toContain(question);
          await delay(PROMPT_TYPEAHEAD_GRACE_MS * 2);
          child.write(answer);
          await expect.poll(screen).toContain(answer);
          child.write('\r');
          await expect.poll(() => existsSync(started), { timeout: 45_000 }).toBe(true);
          await expect.poll(screen).toContain('reviewing changes');
          expect(screen()).not.toContain('choosing checks');
          writeFileSync(release, '');
          await expect.poll(screen, { timeout: 45_000 }).toContain('Final review re-run passed');
          child.write('\x11');
          await expect.poll(() => outcome, { timeout: 10_000 }).toBeDefined();
          expect(outcome?.exitCode, screen()).toBe(0);
        } finally {
          writeFileSync(release, '');
          if (outcome === undefined) await terminatePtyProcessGroup(child, exit.promise);
          await reapOrphanRunners(target.projectDir);
          dataListener.dispose();
          exitListener.dispose();
          terminal.dispose();
        }
      },
    );
    const sessionId = readdirSync(sessionsRoot(target.projectDir))[0];
    if (sessionId === undefined) throw new Error('CLI started without a run');
    const { events } = await readRunEvents({ projectDir: target.projectDir, sessionId });
    expect(events.filter((event) => event.type === 'review_checks')).toHaveLength(1);
    const steps = events.filter((event) => event.type === 'review_step');
    expect(steps.map((event) => event.step)).toEqual(['choosing-checks', 'verdict', 'verdict']);
    const status = await cli(target, ['status']);
    expect(status.exitCode, status.stderr).toBe(0);
    expect(readFileSync(target.greetPath, 'utf8')).toBe(GREET_SOURCE);
  } finally {
    trustHome.restore();
    cleanupTempDir(target.tmpDir);
  }
});
