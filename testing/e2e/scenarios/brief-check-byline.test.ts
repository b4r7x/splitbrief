import { existsSync, mkdirSync, readdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import XtermHeadless from '@xterm/headless';
import { beforeAll, expect, it } from 'vitest';
import { loadConfig, writeConfig } from '../../../src/core/config/load/io.js';
import { sessionsRoot } from '../../../src/core/paths.js';
import { reapOrphanRunners } from '../../../src/engine/orchestrator/run/orphan-reaper.js';
import { trustDeclaredRunners } from '#testing/helpers/runner-trust.js';
import { passingVerdict } from '#testing/helpers/typed-planner.js';
import { cleanupTempDir } from '#testing/helpers/temp-dir.js';
import { useTrustHome } from '#testing/helpers/trust-home.js';
import type { PtyExitEvent } from '../../integration/cli/pty/capability.js';
import { terminatePtyProcessGroup } from '../../integration/cli/pty/monitor.js';
import { runWithPtyChild, safeChildEnvironment } from '../../integration/cli/pty/run.js';
import { buildSteeringCli, readSteeringLog, STEERING_WAIT } from '../helpers/steer-e2e-workflow.js';
import {
  createStopContinueFixture,
  GREET_FILE,
  GREET_SOURCE,
  MARKER_FILE,
  MARKER_SOURCE,
} from '../helpers/stop-continue-fixture.js';

const REPO_ROOT = resolve(import.meta.dirname, '../../..');
const COLS = 120;
const ROWS = 40;

beforeAll(buildSteeringCli, 120_000);

/** The brief writes both declared files at once and finishes. */
function implementer(): string {
  return `import { mkdirSync, writeFileSync } from 'node:fs';
for await (const chunk of process.stdin) void chunk;
mkdirSync('src', { recursive: true });
writeFileSync(${JSON.stringify(GREET_FILE)}, ${JSON.stringify(GREET_SOURCE)});
writeFileSync(${JSON.stringify(MARKER_FILE)}, ${JSON.stringify(MARKER_SOURCE)});
`;
}

/** The review the brief's task cadence asks for: T001 met and C1 passed. */
const TASK_REVIEW = JSON.stringify(
  passingVerdict({ kind: 'task', taskIds: ['T001'], criterionIds: ['C1'] }),
);

/** The brief's test command: it says it started, then holds until the test releases it. */
function slowCheck(started: string, release: string): string {
  return `import { existsSync, writeFileSync } from 'node:fs';
import { setTimeout as delay } from 'node:timers/promises';
writeFileSync(${JSON.stringify(started)}, '');
const deadline = Date.now() + 60_000;
while (!existsSync(${JSON.stringify(release)}) && Date.now() < deadline) await delay(50);
`;
}

// RC6 run C2: while the brief's check K2 ran, the byline read `Implementing… 0:11` and the composer
// offered `Message BUILD on T001 · read when its call ends…` with no BUILD call running.
it('names the brief check it runs and offers no running BUILD call while it runs', async () => {
  const target = createStopContinueFixture(implementer, {
    isolation: 'none',
    // Anchored to the heading line: the plan prompt's repo map quotes this line of the script.
    consult: () =>
      `(prompt) => /^# Task Implementation Review$/m.test(prompt) ? ${JSON.stringify(TASK_REVIEW)} : undefined`,
  });
  const home = useTrustHome('brief-check-home');
  const started = join(target.tmpDir, 'check-started');
  const release = join(target.tmpDir, 'check-release');
  const script = join(target.tmpDir, 'slow-check.mjs');
  try {
    writeFileSync(script, slowCheck(started, release));
    const config = loadConfig(target.projectDir).config;
    writeConfig(target.projectDir, {
      ...config,
      validation: { ...config.validation, testCommand: `node ${script}` },
      workflow: { ...config.workflow, review: 'task', git: { createBranch: false } },
    });
    await trustDeclaredRunners({
      projectDir: target.projectDir,
      config: loadConfig(target.projectDir).config,
    });
    const offline = join(target.tmpDir, 'offline.mjs');
    writeFileSync(
      offline,
      "globalThis.fetch = async () => { throw new Error('Network disabled in brief check E2E'); };\n",
    );
    const bin = join(target.tmpDir, 'bin');
    mkdirSync(bin);
    await runWithPtyChild(
      {
        requirement: 'required',
        argv: [
          '--import',
          offline,
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
          env: { ...safeChildEnvironment(home.home, [bin]), XDG_STATE_HOME: target.stateHome },
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
        const byline = () => screen().split('\n').at(-1)?.trim() ?? '';
        const exitListener = child.onExit((event) => {
          outcome = event;
          exit.resolve(event);
        });
        const dataListener = child.onData((data) => {
          terminal.write(data);
        });
        try {
          await expect.poll(() => existsSync(started), STEERING_WAIT).toBe(true);
          const sessionId = readdirSync(sessionsRoot(target.projectDir))[0];
          if (sessionId === undefined) throw new Error('the check started without a run session');
          const events = (type: string) =>
            readSteeringLog(target.projectDir, sessionId).filter(
              (entry) => entry.kind === 'event' && entry.type === type,
            );

          await expect.poll(byline, STEERING_WAIT).toContain('Plan check T001-K1 · node ');
          expect(screen()).toContain('Message BUILD on T001 · read after its checks…');
          expect(screen()).not.toContain('read when its call ends');
          expect(screen()).not.toContain('Implementing…');
          expect(events('task_validating')).toMatchObject([
            { phase: 'validating-task', taskId: 'T001', data: {} },
            {
              phase: 'validating-task',
              taskId: 'T001',
              data: { check: { id: 'T001-K1', command: expect.stringContaining(script) } },
            },
          ]);
          expect(events('checks_run')).toEqual([]);

          writeFileSync(release, '');
          await expect.poll(() => events('workflow_complete'), STEERING_WAIT).toHaveLength(1);
          expect(
            events('checks_run').filter(
              (entry) => entry.kind === 'event' && entry.phase === 'validating-task',
            ),
          ).toHaveLength(1);
          child.write('\x11');
          await expect.poll(() => outcome, STEERING_WAIT).toBeDefined();
          expect(outcome?.exitCode, screen()).toBe(0);
        } catch (cause) {
          throw new Error(`Brief check E2E failed; CLI exit: ${outcome?.exitCode}\n${screen()}`, {
            cause,
          });
        } finally {
          writeFileSync(release, '');
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
    home.restore();
    cleanupTempDir(target.tmpDir);
  }
});
