import { resolve } from 'node:path';
import XtermHeadless from '@xterm/headless';
import { beforeAll, expect, it } from 'vitest';
import { canonicalizeProjectDir } from '../../../src/cli/setup.js';
import { loadConfig } from '../../../src/core/config/load/io.js';
import { readActive } from '../../../src/core/sessions/active-pointer.js';
import { loadState } from '../../../src/core/state/persistence.js';
import { reapOrphanRunners } from '../../../src/engine/orchestrator/run/orphan-reaper.js';
import { trustDeclaredRunners } from '#testing/helpers/runner-trust.js';
import { cleanupTempDir } from '#testing/helpers/temp-dir.js';
import { useTrustHome } from '#testing/helpers/trust-home.js';
import { passingVerdict } from '#testing/helpers/typed-planner.js';
import type { PtyExitEvent } from '../../integration/cli/pty/capability.js';
import { terminatePtyProcessGroup } from '../../integration/cli/pty/monitor.js';
import { runWithPtyChild, safeChildEnvironment } from '../../integration/cli/pty/run.js';
import { buildSteeringCli, STEERING_WAIT } from '../helpers/steer-e2e-workflow.js';
import {
  createStopContinueFixture,
  GREET_FILE,
  GREET_SOURCE,
  MARKER_FILE,
  MARKER_SOURCE,
} from '../helpers/stop-continue-fixture.js';

const REPO_ROOT = resolve(import.meta.dirname, '../../..');
const COLS = 80;
const ROWS = 9;
const QUESTION = 'Which file or module do you want refactored?';
const MARK = '· ↓ more';

const ASKING_REVIEW = JSON.stringify({
  ...passingVerdict({ kind: 'final', taskIds: ['T001'], criterionIds: ['C1'] }),
  ask: { question: QUESTION, whyOnlyUserCanAnswer: 'The plan names no file to refactor.' },
});

const IMPLEMENTER = `import { mkdirSync, writeFileSync } from 'node:fs';
for await (const chunk of process.stdin) void chunk;
mkdirSync('src', { recursive: true });
writeFileSync(${JSON.stringify(MARKER_FILE)}, ${JSON.stringify(MARKER_SOURCE)});
writeFileSync(${JSON.stringify(GREET_FILE)}, ${JSON.stringify(GREET_SOURCE)});
`;

/**
 * The final review asks the question the one-row panel shows. Its body is braced and it matches the
 * title line itself: the plan prompt's repository map quotes this declaration up to its first `{`,
 * so a phrase in it would reach the plan call and answer it with a review.
 */
function askingReview(): string {
  return `(prompt) => {
  return prompt.split('\\n').includes('# Final Implementation Review')
    ? ${JSON.stringify(ASKING_REVIEW)}
    : undefined;
}`;
}

beforeAll(buildSteeringCli, 120_000);

it('keeps the question next to the empty answer of a one-row planner question panel', {
  timeout: 240_000,
}, async () => {
  const target = createStopContinueFixture(() => IMPLEMENTER, { consult: askingReview });
  const trustHome = useTrustHome('e2e-planner-question-short-panel');
  try {
    const projectDir = await canonicalizeProjectDir({ project: target.projectDir });
    /** The halt the run saved, in its own words, or null while none waits. */
    const savedHalt = (): string | null => {
      const sessionId = readActive(projectDir);
      if (sessionId === null) return null;
      const issue = loadState({ projectDir, sessionId })?.pendingRecovery;
      return issue === undefined ? null : `${issue.reason}: ${issue.message}`;
    };
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
          'dist/cli.js',
          'start',
          'smoke',
          '--allow-repo-runners',
          '--project',
          target.projectDir,
        ],
        spawnOptions: {
          name: 'xterm-256color',
          cols: COLS,
          rows: ROWS,
          cwd: REPO_ROOT,
          env,
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
          await expect
            .poll(() => {
              const halt = savedHalt();
              if (halt !== null) throw new Error(`The run halted before the question: ${halt}`);
              return screen();
            }, STEERING_WAIT)
            .toContain(QUESTION);
          const row = screen()
            .split('\n')
            .find((line) => line.includes('›') && line.includes(MARK));
          expect(row, screen()).toBeDefined();
          const asked = row ?? '';
          const between = asked.slice(asked.indexOf('› ') + 2, asked.indexOf(MARK));
          expect(between.length, screen()).toBeLessThanOrEqual(2);

          child.write('\x11');
          await expect.poll(() => outcome, STEERING_WAIT).toBeDefined();
          expect(outcome?.exitCode, screen()).toBe(0);
        } catch (cause) {
          throw new Error(
            `One-row planner question E2E failed; CLI exit: ${outcome?.exitCode}; saved halt: ${savedHalt() ?? 'none'}\n${screen()}`,
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
  } finally {
    trustHome.restore();
    cleanupTempDir(target.tmpDir);
  }
});
