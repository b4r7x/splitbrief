import { existsSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import XtermHeadless from '@xterm/headless';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { loadConfig, writeConfig } from '../../../src/core/config/load/io.js';
import { sessionsRoot } from '../../../src/core/paths.js';
import type { IsolationStrategy } from '../../../src/core/schemas/enums.js';
import { deriveRunStatus } from '../../../src/core/sessions/run-status.js';
import { loadState } from '../../../src/core/state/persistence.js';
import { reapOrphanRunners } from '../../../src/engine/orchestrator/run/orphan-reaper.js';
import { PROMPT_TYPEAHEAD_GRACE_MS } from '../../../src/lib/terminal/typeahead-grace.js';
import { trustDeclaredRunners } from '#testing/helpers/runner-trust.js';
import { cleanupTempDir } from '#testing/helpers/temp-dir.js';
import { useTrustHome } from '#testing/helpers/trust-home.js';
import { passingVerdict } from '#testing/helpers/typed-planner.js';
import type { PtyExitEvent, PtyProcess } from '../../integration/cli/pty/capability.js';
import { terminatePtyProcessGroup } from '../../integration/cli/pty/monitor.js';
import { runWithPtyChild, safeChildEnvironment } from '../../integration/cli/pty/run.js';
import { buildSteeringCli, STEERING_WAIT } from '../helpers/steer-e2e-workflow.js';
import {
  applyRun,
  createStopContinueFixture,
  GREET_FILE,
  GREET_SOURCE,
  MARKER_FILE,
  MARKER_SOURCE,
  type StopContinueFixture,
} from '../helpers/stop-continue-fixture.js';

const REPO_ROOT = resolve(import.meta.dirname, '../../..');
const COLS = 120;
const ROWS = 40;

const QUESTION = 'Should greet keep the lowercase hello?';
const WHY = 'The plan does not say which casing the greeting uses.';
const ANSWER = 'ANSWER_KEEP_LOWERCASE_HELLO';

/** The fixture plan's one task and one criterion (`createStopContinueFixture`'s typed plan). */
const REVIEW_SCOPE = { kind: 'final', taskIds: ['T001'], criterionIds: ['C1'] } as const;

/** The first review passes every id and asks the user one question about what is built. */
const ASKING_REVIEW = JSON.stringify({
  ...passingVerdict(REVIEW_SCOPE),
  ask: { question: QUESTION, whyOnlyUserCanAnswer: WHY },
});

/**
 * The review after the answer: the answer is pending input `A1` (the first input the
 * question adds, `A${inputs.length + 1}`), and it needs no work, so the review rejects it.
 */
const ANSWERED_REVIEW = JSON.stringify({
  ...passingVerdict(REVIEW_SCOPE),
  rejected: [{ findingId: 'A1', reason: 'The answer keeps the greeting as built.' }],
});

const ReviewCallSchema = z.object({ prompt: z.string() });

/** Writes both declared files at once, so the one brief passes on its first attempt. */
const IMPLEMENTER_SCRIPT = `import { mkdirSync, writeFileSync } from 'node:fs';
for await (const chunk of process.stdin) void chunk;
mkdirSync('src', { recursive: true });
writeFileSync(${JSON.stringify(MARKER_FILE)}, ${JSON.stringify(MARKER_SOURCE)});
writeFileSync(${JSON.stringify(GREET_FILE)}, ${JSON.stringify(GREET_SOURCE)});
`;

/**
 * The PLAN seat also holds the review seat (the fixture has no `reviewer:` block). A shell
 * runner has no session resume, so each review call carries its whole prompt: the script
 * logs it and branches on the answer's presence in it. Every other call goes to the
 * fixture's own planner script.
 */
function plannerScript(target: StopContinueFixture, callsPath: string): string {
  return `import { spawnSync } from 'node:child_process';
import { appendFileSync } from 'node:fs';
const chunks = [];
for await (const chunk of process.stdin) chunks.push(chunk);
const prompt = Buffer.concat(chunks).toString('utf8');
if (prompt.includes('Final Implementation Review')) {
  appendFileSync(${JSON.stringify(callsPath)}, JSON.stringify({ prompt }) + '\\n');
  process.stdout.write(
    prompt.includes(${JSON.stringify(ANSWER)})
      ? ${JSON.stringify(ANSWERED_REVIEW)}
      : ${JSON.stringify(ASKING_REVIEW)},
  );
} else {
  const reply = spawnSync(process.execPath, [${JSON.stringify(join(target.projectDir, 'tools/planner.mjs'))}], {
    input: prompt,
    encoding: 'utf8',
  });
  if (reply.status !== 0) throw new Error(reply.stderr);
  process.stdout.write(reply.stdout);
}
`;
}

function readReviewPrompts(callsPath: string): string[] {
  if (!existsSync(callsPath)) return [];
  return readFileSync(callsPath, 'utf8')
    .split('\n')
    .filter((line) => line !== '')
    .map((line) => ReviewCallSchema.parse(JSON.parse(line)).prompt);
}

type CliSession = Readonly<{
  child: PtyProcess;
  screen: () => string;
  outcome: () => PtyExitEvent | undefined;
}>;

type Scenario = Readonly<{
  target: StopContinueFixture;
  home: string;
  offlinePath: string;
  callsPath: string;
}>;

/** One built CLI in a pseudoterminal, read through a headless terminal, reaped on the way out. */
async function withCli(
  scenario: Scenario,
  args: readonly string[],
  observe: (session: CliSession) => Promise<void>,
): Promise<void> {
  const { target } = scenario;
  await runWithPtyChild(
    {
      requirement: 'required',
      argv: [
        '--import',
        scenario.offlinePath,
        'dist/cli.js',
        ...args,
        '--allow-repo-runners',
        '--project',
        target.projectDir,
      ],
      spawnOptions: {
        name: 'xterm-256color',
        cols: COLS,
        rows: ROWS,
        cwd: REPO_ROOT,
        env: { ...safeChildEnvironment(scenario.home), XDG_STATE_HOME: target.stateHome },
      },
    },
    async (child) => {
      const exit = Promise.withResolvers<PtyExitEvent>();
      let outcome: PtyExitEvent | undefined;
      const terminal = new XtermHeadless.Terminal({
        cols: COLS,
        rows: ROWS,
        allowProposedApi: true,
        convertEol: true,
        scrollback: 0,
        logLevel: 'off',
      });
      const screen = () =>
        Array.from(
          { length: ROWS },
          (_, row) => terminal.buffer.active.getLine(row)?.translateToString(true) ?? '',
        ).join('\n');
      const exitListener = child.onExit((event) => {
        outcome = event;
        exit.resolve(event);
      });
      const dataListener = child.onData((data) => {
        terminal.write(data);
      });
      try {
        await observe({ child, screen, outcome: () => outcome });
      } catch (cause) {
        throw new Error(
          `Reviewer question E2E failed (${args[0]}); CLI exit: ${outcome?.exitCode}\n${screen()}`,
          { cause },
        );
      } finally {
        try {
          if (outcome === undefined) await terminatePtyProcessGroup(child, exit.promise);
          await reapOrphanRunners(target.projectDir);
        } finally {
          dataListener.dispose();
          exitListener.dispose();
          terminal.dispose();
        }
      }
    },
  );
}

/** The question prompt counts its questions; no transcript row replayed on resume reads so. */
const QUESTION_PROMPT = 'Question 1 of 1';

beforeAll(buildSteeringCli, 120_000);

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('e2e: a reviewer question survives a stop and a crash', { timeout: 240_000 }, () => {
  it.each<{ signal: 'SIGINT' | 'SIGKILL'; isolation: IsolationStrategy | undefined }>([
    { signal: 'SIGINT', isolation: undefined },
    { signal: 'SIGKILL', isolation: 'none' },
  ])(
    'asks the saved question again after $signal and sends the answer to the reviewer (isolation $isolation)',
    async ({ signal, isolation }) => {
      const target = createStopContinueFixture(
        () => IMPLEMENTER_SCRIPT,
        isolation === undefined ? {} : { isolation },
      );
      const trustHome = useTrustHome('e2e-reviewer-question-home');
      try {
        const callsPath = join(target.tmpDir, 'review-calls.jsonl');
        const plannerPath = join(target.tmpDir, 'planner.mjs');
        writeFileSync(plannerPath, plannerScript(target, callsPath));
        const offlinePath = join(target.tmpDir, 'offline.mjs');
        writeFileSync(
          offlinePath,
          "globalThis.fetch = async () => { throw new Error('Network disabled in reviewer question E2E'); };\n",
        );
        vi.stubEnv('NODE_OPTIONS', `--import=${offlinePath}`);
        const config = loadConfig(target.projectDir).config;
        writeConfig(target.projectDir, {
          ...config,
          planner: {
            ...config.planner,
            kind: 'shell' as const,
            command: process.execPath,
            args: [plannerPath],
          },
          implementer: {
            ...config.implementer,
            kind: 'agent' as const,
            command: process.execPath,
            args: ['./tools/implementer.mjs'],
            model: 'fixture',
          },
        });
        await trustDeclaredRunners({
          projectDir: target.projectDir,
          config: loadConfig(target.projectDir).config,
        });
        const scenario: Scenario = { target, home: trustHome.home, offlinePath, callsPath };
        let sessionId = '';

        await withCli(scenario, ['start', 'smoke'], async ({ child, screen, outcome }) => {
          await expect.poll(() => readReviewPrompts(callsPath).length, STEERING_WAIT).toBe(1);
          const found = readdirSync(sessionsRoot(target.projectDir))[0];
          if (found === undefined) throw new Error('REVIEW ran without a run session');
          sessionId = found;
          const ref = { projectDir: target.projectDir, sessionId };
          await expect
            .poll(() => loadState(ref)?.pendingTriage?.question?.question, STEERING_WAIT)
            .toBe(QUESTION);
          await expect.poll(screen, STEERING_WAIT).toContain(QUESTION_PROMPT);
          expect(screen()).toContain(QUESTION);

          process.kill(-child.pid, signal);
          await expect.poll(outcome, STEERING_WAIT).toBeDefined();
          if (signal === 'SIGINT') expect(outcome()?.exitCode).toBe(130);
        });

        const ref = { projectDir: target.projectDir, sessionId };
        const stopped = loadState(ref);
        if (stopped === null) throw new Error('the stopped run left no state');
        expect(stopped.phase).toBe('final-review');
        expect(stopped.pendingTriage?.question).toEqual({
          question: QUESTION,
          whyOnlyUserCanAnswer: WHY,
        });
        expect(stopped.pendingTriage?.inputs).toEqual([]);
        expect(stopped.triage?.at(-1)?.result.ask?.question).toBe(QUESTION);
        expect(stopped.pendingRecovery).toBeUndefined();
        expect(stopped.closed).toBeUndefined();
        expect(deriveRunStatus({ state: stopped, liveness: 'not-alive' }).kind).toBe('open');
        const [asked] = readReviewPrompts(callsPath);
        expect(readReviewPrompts(callsPath)).toHaveLength(1);
        expect(asked).not.toContain(ANSWER);

        await withCli(scenario, ['continue', sessionId], async ({ child, screen, outcome }) => {
          await expect.poll(screen, STEERING_WAIT).toContain(QUESTION_PROMPT);
          expect(screen()).toContain(QUESTION);
          // The question came back from the saved state, not from another review call.
          expect(readReviewPrompts(callsPath)).toHaveLength(1);
          expect(loadState(ref)?.pendingTriage?.question?.question).toBe(QUESTION);

          // The prompt drops keys typed within its grace window after it opens.
          await delay(PROMPT_TYPEAHEAD_GRACE_MS * 2);
          child.write(ANSWER);
          await expect.poll(screen, STEERING_WAIT).toContain(ANSWER);
          child.write('\r');

          await expect.poll(() => readReviewPrompts(callsPath).length, STEERING_WAIT).toBe(2);
          await expect
            .poll(() => {
              const state = loadState(ref);
              return state === null ? null : deriveRunStatus({ state, liveness: 'not-alive' });
            }, STEERING_WAIT)
            .toEqual(
              isolation === 'none'
                ? { kind: 'closed', as: 'complete' }
                : { kind: 'ready-to-apply', override: false },
            );

          child.write('\x11');
          await expect.poll(outcome, STEERING_WAIT).toBeDefined();
          expect(outcome()?.exitCode, screen()).toBe(0);
        });

        const prompts = readReviewPrompts(callsPath);
        expect(prompts).toHaveLength(2);
        const reviewed = prompts[1];
        expect(reviewed).toContain('**A1** (user · answer)');
        expect(reviewed).toContain(ANSWER);
        expect(reviewed).toContain(`asked: ${QUESTION}`);

        const passed = loadState(ref);
        expect(passed?.reviewStatus).toBe('passed');
        expect(passed?.pendingTriage).toBeUndefined();
        expect(passed?.userAnswers).toContainEqual({
          reply: QUESTION,
          answer: expect.stringContaining(ANSWER),
        });

        if (isolation !== 'none') {
          const applied = await applyRun(target, sessionId);
          expect(applied.exitCode, applied.stderr).toBe(0);
          expect(loadState(ref)?.closed?.as).toBe('applied');
        }
        expect(readFileSync(target.greetPath, 'utf8')).toBe(GREET_SOURCE);
      } finally {
        trustHome.restore();
        cleanupTempDir(target.tmpDir);
      }
    },
  );
});
