import { readdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import XtermHeadless from '@xterm/headless';
import { expect, it } from 'vitest';
import { loadConfig, writeConfig } from '../../../src/core/config/load/io.js';
import { sessionsRoot } from '../../../src/core/paths.js';
import { readRunEvents } from '../../../src/engine/events/replay.js';
import { reapOrphanRunners } from '../../../src/engine/orchestrator/run/orphan-reaper.js';
import { formatDuration } from '../../../src/utils/format-time.js';
import { makePlanProposal, makeTaskSpec } from '#testing/helpers/factories/plan.js';
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
} from '../helpers/stop-continue-fixture.js';

const VIEWPORT = { cols: 120, rows: 40 };
const RUN = { timeout: 120_000 };
const PAINT = { timeout: 15_000 };
const CTRL_A = '\u0001';
/** The header of the group: six green checks, one of them reused, and the time of the five that ran. */
const HEADER = /● Checks {2}6 passed · 1 reused · \d+\.\ds$/mu;

/** The final review runs the five plan checks and then the brief's check, each its own command. */
const PLAN_CHECKS = [
  { id: 'K1', kind: 'cmd', value: `test -e ${GREET_FILE}` },
  { id: 'K2', kind: 'cmd', value: `test -e ${MARKER_FILE}` },
  { id: 'K3', kind: 'cmd', value: `test -f ${MARKER_FILE}` },
  { id: 'K4', kind: 'cmd', value: 'test -e .gitignore' },
  { id: 'K5', kind: 'cmd', value: 'test -f .gitignore' },
] as const;
const BRIEF_CHECK = { id: 'T001-K1', kind: 'cmd', value: `test -f ${GREET_FILE}` } as const;
/** Each check's id and command, in the order the final review runs them. */
const CHECKS = [...PLAN_CHECKS, BRIEF_CHECK].map(({ id, value }) => [id, value] as const);
const brief = makeTaskSpec({
  id: 'T001',
  title: 'Add a greeting helper',
  intent: 'Add a standalone greeting helper plus the run marker constant beside it.',
  criteria: ['C1'],
  suggestedFiles: [GREET_FILE, MARKER_FILE],
  checks: [BRIEF_CHECK],
});
const plan = makePlanProposal({
  summary: 'Add a greeting helper with the run marker beside it.',
  decisions: [],
  criteria: [
    {
      id: 'C1',
      text: 'greet returns a greeting',
      checkIds: CHECKS.map(([id]) => id),
    },
  ],
  checks: [...PLAN_CHECKS],
  tasks: [brief],
});
const REVIEW_REPLY = JSON.stringify(
  passingVerdict({ kind: 'final', taskIds: [brief.id], criterionIds: ['C1'] }),
);

function plannerScript(): string {
  return `const chunks = [];
for await (const chunk of process.stdin) chunks.push(chunk);
const prompt = Buffer.concat(chunks).toString('utf8');
if (prompt.includes('# Final Implementation Review')) {
  process.stdout.write(${JSON.stringify(REVIEW_REPLY)});
} else {
  process.stdout.write(${JSON.stringify(JSON.stringify({ result: plan }))});
}
`;
}

/** The brief writes both declared files at once and finishes. */
function implementerScript(): string {
  return `import { mkdirSync, writeFileSync } from 'node:fs';
for await (const chunk of process.stdin) void chunk;
mkdirSync('src', { recursive: true });
writeFileSync(${JSON.stringify(GREET_FILE)}, ${JSON.stringify(GREET_SOURCE)});
writeFileSync(${JSON.stringify(MARKER_FILE)}, ${JSON.stringify(MARKER_SOURCE)});
`;
}

it('folds the checks of a passed final review into one group, and opens and closes it on ctrl+a', {
  timeout: 200_000,
}, async () => {
  const target = createStopContinueFixture(() => '');
  const trustHome = useTrustHome('review-checks-fold');
  const plannerPath = join(target.tmpDir, 'planner.mjs');
  const implementerPath = join(target.tmpDir, 'implementer.mjs');
  const offlinePath = join(target.tmpDir, 'offline.mjs');
  writeFileSync(plannerPath, plannerScript());
  writeFileSync(implementerPath, implementerScript());
  writeFileSync(offlinePath, "globalThis.fetch = async () => { throw new Error('offline'); };\n");
  const config = loadConfig(target.projectDir).config;
  if (config.planner.kind !== 'shell' || config.implementer.kind !== 'agent') {
    throw new Error('Expected local shell and agent fixture runners');
  }
  writeConfig(target.projectDir, {
    ...config,
    planner: { ...config.planner, args: [plannerPath] },
    implementer: { ...config.implementer, args: [implementerPath] },
    workflow: { ...config.workflow, approve: 'none' },
    validation: { ...config.validation, endChecks: false },
  });
  let header: string | undefined;
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
          offlinePath,
          'dist/cli.js',
          'start',
          'greet',
          '--allow-repo-runners',
          '--project',
          target.projectDir,
        ],
        spawnOptions: {
          name: 'xterm-256color',
          ...VIEWPORT,
          cwd: resolve(import.meta.dirname, '../../..'),
          env,
        },
      },
      async (child) => {
        const exit = Promise.withResolvers<PtyExitEvent>();
        let outcome: PtyExitEvent | undefined;
        const terminal = new XtermHeadless.Terminal({
          ...VIEWPORT,
          allowProposedApi: true,
          convertEol: true,
          scrollback: 0,
          logLevel: 'off',
        });
        const screen = () =>
          Array.from(
            { length: VIEWPORT.rows },
            (_, row) => terminal.buffer.active.getLine(row)?.translateToString(true) ?? '',
          ).join('\n');
        const dataListener = child.onData((data) => terminal.write(data));
        const exitListener = child.onExit((event) => {
          outcome = event;
          exit.resolve(event);
        });
        try {
          await expect.poll(screen, RUN).toContain('▌ Apply');
          await expect.poll(screen, PAINT).toContain('● Final review passed');
          // A done, green group hides every row: its header counts them, and its fold names the key.
          const folded = screen();
          expect(folded).toMatch(HEADER);
          header = HEADER.exec(folded)?.[0];
          expect(folded).toContain('└ +6 checks · ctrl+a');
          expect(folded).not.toContain('Plan check');
          // The group is the lowest fold, and only the lowest fold names the key.
          expect(folded.match(/ctrl\+a/gu)).toHaveLength(1);

          child.write(CTRL_A);
          await expect.poll(screen, PAINT).toContain('├ collapse · ctrl+a');
          // Ink paints a frame from the top down in chunks: poll until every check row is painted.
          await expect
            .poll(() => {
              const lines = screen().split('\n');
              return CHECKS.map(
                ([id, command]) =>
                  lines.filter((line) => line.includes(`Plan check ${id} · ${command} · passed · `))
                    .length,
              );
            }, PAINT)
            .toEqual(CHECKS.map(() => 1));
          expect(screen()).toContain(header);

          child.write(CTRL_A);
          await expect.poll(screen, PAINT).toContain('└ +6 checks · ctrl+a');
          const foldedAgain = screen();
          expect(foldedAgain).toContain(header);
          expect(foldedAgain).not.toContain('Plan check');
          expect(foldedAgain).not.toContain('collapse');

          child.write('\x11');
          await expect.poll(() => outcome, { timeout: 10_000 }).toBeDefined();
          expect(outcome?.exitCode, screen()).toBe(0);
        } catch (cause) {
          throw new Error(`Review checks fold E2E failed\n${screen()}`, { cause });
        } finally {
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
    const checks = events.flatMap((event) =>
      event.type === 'full_suite' && event.status === 'done' ? [event] : [],
    );
    // The header counts the checks of the review, and sums the times of the five that ran their command.
    expect(checks.map((check) => check.id)).toEqual(CHECKS.map(([id]) => id));
    const ran = checks.flatMap((check) =>
      check.reusedAt === undefined && check.duration !== undefined ? [check.duration] : [],
    );
    expect(ran).toHaveLength(5);
    expect(header).toBe(
      `● Checks  6 passed · 1 reused · ${formatDuration(ran.reduce((sum, time) => sum + time, 0))}`,
    );
  } finally {
    trustHome.restore();
    cleanupTempDir(target.tmpDir);
  }
});
