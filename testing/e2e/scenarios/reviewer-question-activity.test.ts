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
import { useTrustHome as createTrustHome } from '#testing/helpers/trust-home.js';
import { passingVerdict } from '#testing/helpers/typed-planner.js';
import type { PtyExitEvent, PtyProcess } from '../../integration/cli/pty/capability.js';
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

/**
 * Runs the build in a PTY until the shell reviewer asks `Keep the lowercase greeting?`, lets `type`
 * write the answer, and sends ⏎. The reviewer's next call holds its verdict until the release, so
 * `check` reads the screen during that verdict-only call. Returns the prompt of that call.
 */
async function answerReviewerQuestion(input: {
  answer: string;
  type: (child: PtyProcess, screen: () => string) => Promise<void>;
  check?: (screen: () => string) => Promise<void>;
}): Promise<string> {
  const target = createStopContinueFixture(
    () => `import { mkdirSync, writeFileSync } from 'node:fs';
for await (const chunk of process.stdin) void chunk;
mkdirSync('src', { recursive: true });
writeFileSync(${JSON.stringify(GREET_FILE)}, ${JSON.stringify(GREET_SOURCE)});
writeFileSync(${JSON.stringify(MARKER_FILE)}, ${JSON.stringify(MARKER_SOURCE)});
`,
    { isolation: 'none' },
  );
  const trustHome = createTrustHome('review-question-activity');
  const reviewer = join(target.tmpDir, 'reviewer.mjs');
  const answeredPrompt = join(target.tmpDir, 'answered-prompt');
  const started = join(target.tmpDir, 'verdict-started');
  const release = join(target.tmpDir, 'release-verdict');
  const question = 'Keep the lowercase greeting?';
  const verdict = passingVerdict({ kind: 'final', taskIds: ['T001'], criterionIds: ['C1'] });
  writeFileSync(
    reviewer,
    `import { existsSync, writeFileSync } from 'node:fs';
import { setTimeout as delay } from 'node:timers/promises';
const chunks = [];
for await (const chunk of process.stdin) chunks.push(chunk);
const prompt = Buffer.concat(chunks).toString('utf8');
if (!prompt.includes(${JSON.stringify(input.answer)})) {
  console.log(${JSON.stringify(JSON.stringify({ ...verdict, ask: { question, whyOnlyUserCanAnswer: 'The user chooses the casing.' } }))});
} else {
  writeFileSync(${JSON.stringify(answeredPrompt)}, prompt);
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
        const dataListener = child.onData((data) => terminal.write(data));
        const exitListener = child.onExit((event) => {
          outcome = event;
          exit.resolve(event);
        });
        try {
          await expect.poll(screen, { timeout: 45_000 }).toContain(question);
          await delay(PROMPT_TYPEAHEAD_GRACE_MS * 2);
          await input.type(child, screen);
          child.write('\r');
          await expect.poll(() => existsSync(started), { timeout: 45_000 }).toBe(true);
          await expect.poll(screen).toContain('reviewing changes');
          await input.check?.(screen);
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
    expect(events.filter((event) => event.type === 'review_checks')).toMatchObject([
      { status: 'none' },
    ]);
    const steps = events.filter((event) => event.type === 'review_step');
    expect(steps.map((event) => event.step)).toEqual(['verdict', 'verdict']);
    const status = await cli(target, ['status']);
    expect(status.exitCode, status.stderr).toBe(0);
    expect(readFileSync(target.greetPath, 'utf8')).toBe(GREET_SOURCE);
    return readFileSync(answeredPrompt, 'utf8');
  } finally {
    trustHome.restore();
    cleanupTempDir(target.tmpDir);
  }
}

it('shows reviewing changes during the verdict-only call after a reviewer question', async () => {
  const answer = 'KEEP_LOWERCASE';
  await answerReviewerQuestion({
    answer,
    type: async (child, screen) => {
      child.write(answer);
      await expect.poll(screen).toContain(answer);
    },
  });
});

it('paints no blank row when a later answer line starts with a space and its first word fills the answer column', async () => {
  const answer = 'Pin it';
  const prompt = await answerReviewerQuestion({
    answer,
    type: async (child, screen) => {
      child.write(answer);
      await expect.poll(screen).toContain(answer);
      child.write('\x1b[13;2u');
      child.write(` ${'a'.repeat(113)} now`);
      await expect.poll(screen).toContain(' now');
    },
    check: async (screen) => {
      await expect.poll(() => screen().includes('You → Pin it'), { timeout: 10_000 }).toBe(true);
      const answered = screen()
        .split('\n')
        .map((line) => line.trim());
      const anchor = answered.indexOf('You → Pin it');
      expect(anchor, screen()).toBeGreaterThan(-1);
      const wrapped = answered.slice(anchor + 1, anchor + 3);
      expect(wrapped, screen()).toEqual(['a'.repeat(113), 'now']);
    },
  });
  expect(prompt).toContain(`Pin it\n ${'a'.repeat(113)} now`);
});
