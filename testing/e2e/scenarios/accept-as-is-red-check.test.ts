import { execFileSync } from 'node:child_process';
import { readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import XtermHeadless from '@xterm/headless';
import { expect, it, vi } from 'vitest';
import { loadConfig, writeConfig } from '../../../src/core/config/load/io.js';
import { REVIEW_FILE, sessionDir, sessionsRoot } from '../../../src/core/paths.js';
import { reapOrphanRunners } from '../../../src/engine/orchestrator/run/orphan-reaper.js';
import { activateSafeCliShimPath } from '#testing/helpers/compatible-cli-shim.js';
import { makePlanProposal, makeTaskSpec } from '#testing/helpers/factories/plan.js';
import { createTestGitRepo } from '#testing/helpers/git.js';
import { trustDeclaredRunners } from '#testing/helpers/runner-trust.js';
import { cleanupTempDir } from '#testing/helpers/temp-dir.js';
import { useTrustHome } from '#testing/helpers/trust-home.js';
import { passingVerdict } from '#testing/helpers/typed-planner.js';
import type { PtyExitEvent } from '../../integration/cli/pty/capability.js';
import { terminatePtyProcessGroup } from '../../integration/cli/pty/monitor.js';
import { runWithPtyChild, safeChildEnvironment } from '../../integration/cli/pty/run.js';
import { moveCursorTo } from '../helpers/move-cursor.js';
import { cli, createStopContinueFixture, readState } from '../helpers/stop-continue-fixture.js';
import { wholeFrames } from '../helpers/whole-frames.js';

const VIEWPORT = { cols: 120, rows: 40 };

/**
 * The project gate: red in the run and at the run base, with one output line that names no failing
 * test and no file position, so SPLITBRIEF cannot show it is the same failure.
 */
const RED_FILE = 'tools/run-specs.mjs';
const RED_COMMAND = `node ${RED_FILE}`;
const RED_LINE = 'Error: 2 specs failed';
const RED_SOURCE = `console.error(${JSON.stringify(RED_LINE)});
process.exitCode = 1;
`;
const RED_CHECK = `V1 failed · ${RED_COMMAND} · ${RED_LINE}`;

const TOTAL_FILE = 'src/total.mjs';
const TOTAL_TEST_FILE = 'src/total.test.mjs';
const TOTAL_SOURCE = 'export const total = (a, b) => a + b;\n';
const TOTAL_TEST_SOURCE = `import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { total } from './total.mjs';

test('total adds two numbers', () => {
  assert.equal(total(1, 2), 3);
});
`;
const QUESTION = 'Is V1 the right gate command?';

const brief = makeTaskSpec({
  id: 'T001',
  title: 'Add the total helper',
  intent: 'Return the sum of two numbers.',
  criteria: ['C1'],
  suggestedFiles: [TOTAL_FILE, TOTAL_TEST_FILE],
  checks: [{ id: 'T001-K1', kind: 'test', value: TOTAL_TEST_FILE }],
});
const plan = makePlanProposal({
  summary: 'Add a total helper with its test.',
  decisions: [],
  criteria: [{ id: 'C1', text: 'total returns the sum.', checkIds: ['T001-K1'] }],
  gate: [RED_COMMAND],
  tasks: [brief],
});
/** The reviewer passes every task and criterion, rejects no red input and asks a question. */
const review = {
  ...passingVerdict({ kind: 'final', taskIds: [brief.id], criterionIds: ['C1'] }),
  ask: { question: QUESTION, whyOnlyUserCanAnswer: 'Only you know the gate.' },
};

const PLANNER_SCRIPT = `const chunks = [];
for await (const chunk of process.stdin) chunks.push(chunk);
const prompt = Buffer.concat(chunks).toString('utf8');
if (prompt.includes('# Final Implementation Review')) {
  process.stdout.write(${JSON.stringify(JSON.stringify(review))});
} else if (prompt.includes('# Plan the change')) {
  process.stdout.write(${JSON.stringify(JSON.stringify({ result: plan }))});
} else {
  throw new Error('Unexpected prompt: ' + prompt);
}
`;

const IMPLEMENTER_SCRIPT = `import { mkdirSync, writeFileSync } from 'node:fs';
for await (const chunk of process.stdin) void chunk;
mkdirSync('src', { recursive: true });
writeFileSync(${JSON.stringify(TOTAL_FILE)}, ${JSON.stringify(TOTAL_SOURCE)});
writeFileSync(${JSON.stringify(TOTAL_TEST_FILE)}, ${JSON.stringify(TOTAL_TEST_SOURCE)});
console.log('Implemented ${brief.id}');
`;

/** Rewrites the fixture's one commit so the run base also holds the red script. */
function commitRedOnBase(projectDir: string): void {
  const tracked = execFileSync('git', ['ls-files', '-z'], { cwd: projectDir, encoding: 'utf8' })
    .split('\0')
    .filter((path) => path !== '');
  const files: Record<string, string> = {};
  for (const path of tracked) files[path] = readFileSync(join(projectDir, path), 'utf8');
  createTestGitRepo(projectDir, { ...files, [RED_FILE]: RED_SOURCE });
}

it('e2e: Accept as is at a final review that a red check blocks records the red check, and Apply as is names it before it writes the changes', {
  timeout: 300_000,
}, async () => {
  const target = createStopContinueFixture(() => '');
  const trustHome = useTrustHome('accept-as-is-red-check');
  commitRedOnBase(target.projectDir);
  const restorePath = activateSafeCliShimPath(target.tmpDir);
  const plannerPath = join(target.tmpDir, 'planner.mjs');
  const implementerPath = join(target.tmpDir, 'implementer.mjs');
  const offlinePath = join(target.tmpDir, 'offline.mjs');
  writeFileSync(plannerPath, PLANNER_SCRIPT);
  writeFileSync(implementerPath, IMPLEMENTER_SCRIPT);
  writeFileSync(
    offlinePath,
    "globalThis.fetch = async () => { throw new Error('E2E network disabled'); };\n",
  );
  vi.stubEnv('NODE_OPTIONS', `--import=${offlinePath}`);
  const config = loadConfig(target.projectDir).config;
  if (config.planner.kind !== 'shell' || config.implementer.kind !== 'agent') {
    throw new Error('Expected local shell and agent fixture runners');
  }
  writeConfig(target.projectDir, {
    ...config,
    planner: { ...config.planner, args: [plannerPath] },
    implementer: { ...config.implementer, args: [implementerPath] },
    workflow: { ...config.workflow, approve: 'none' },
    validation: { ...config.validation, endChecks: true, testCommand: 'node --test' },
  });
  let halted = '';
  let ready = '';
  let confirm: string[] = [];
  try {
    const run = await cli(target, ['start', 'total'], { timeoutMs: 150_000 });
    expect(run.exitCode, `${run.stdout}\n${run.stderr}`).toBe(1);
    const sessions = readdirSync(sessionsRoot(target.projectDir));
    expect(sessions).toHaveLength(1);
    const sessionId = sessions[0];
    if (sessionId === undefined) throw new Error('Missing session');
    const lines = run.stdout.split('\n').map((line) => line.trim());
    expect(lines).toContain('review: failed (1 blocking)');
    expect(run.stderr).toContain(`Question: ${QUESTION}`);
    expect(run.stderr).toContain(
      `Continue with: splitbrief continue ${sessionId}, then choose Review again in the recovery panel`,
    );
    const halt = readState(target, sessionId).pendingRecovery;
    expect(halt?.reason).toBe('review-failed');
    expect(halt?.availableActions).toContain('accept-as-is');
    expect(lines).toContain('done: 1 tasks');

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
          '--import',
          offlinePath,
          'src/cli.ts',
          'continue',
          sessionId,
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
        const frames = wholeFrames((data) => terminal.write(data));
        const dataListener = child.onData(frames.feed);
        const exitListener = child.onExit((event) => {
          frames.flush();
          outcome = event;
          exit.resolve(event);
        });
        const write = (keys: string) => child.write(keys);
        try {
          await expect.poll(screen, { timeout: 60_000 }).toContain(`Question: ${QUESTION}`);
          await expect.poll(screen).toMatch(/▌.*Review again/);
          halted = screen();
          expect(halted).toContain('Accept as is');
          expect(halted).toContain(RED_CHECK);

          await moveCursorTo(screen, write, '\x1b[B', /▌.*Accept as is/);
          write('\r');
          await expect
            .poll(screen, { timeout: 60_000 })
            .toContain('Ready to apply as is · 1 red check');
          // The mark shows only while the menu holds the keyboard.
          await expect.poll(screen).toContain('▌ Apply as is');
          ready = screen();

          write('\r');
          await expect.poll(screen).toContain('Apply with 1 red check?');
          await expect.poll(screen).toContain('▌ Apply as is');
          confirm = screen().split('\n');

          write('\r');
          await expect
            .poll(() => readState(target, sessionId).closed?.as, { timeout: 60_000 })
            .toBe('applied');
          await expect.poll(screen, { timeout: 30_000 }).toContain('Applied to your checkout');
        } finally {
          if (outcome === undefined) await terminatePtyProcessGroup(child, exit.promise);
          await reapOrphanRunners(target.projectDir);
          dataListener.dispose();
          exitListener.dispose();
          terminal.dispose();
        }
      },
    );

    expect(halted).toContain('Decide for me');
    expect(halted).toContain('End run');
    expect(ready).toContain('write the changes with the red checks; asks once');
    expect(ready).not.toContain('open finding');

    const title = confirm.findIndex((row) => row.includes('Apply with 1 red check?'));
    expect(title, confirm.join('\n')).toBeGreaterThan(-1);
    expect(confirm[title + 1]).toContain(`- ${RED_CHECK}`);
    expect(confirm.join('\n')).toContain('write the changes; the red checks stay red');
    expect(confirm.join('\n')).not.toContain('open finding');

    expect(readFileSync(join(target.projectDir, TOTAL_FILE), 'utf8')).toBe(TOTAL_SOURCE);
    expect(readFileSync(join(target.projectDir, TOTAL_TEST_FILE), 'utf8')).toBe(TOTAL_TEST_SOURCE);
    const state = readState(target, sessionId);
    expect(state.acceptedAsIs).toMatchObject({
      findings: [],
      redChecks: [{ id: 'V1', command: RED_COMMAND, lastLine: RED_LINE }],
    });
    expect(state.pendingRecovery).toBeUndefined();
    expect(
      readFileSync(join(sessionDir(target.projectDir, sessionId), REVIEW_FILE), 'utf8'),
    ).toContain(
      [
        '**Accepted as is by you**',
        '',
        'The planner did not accept this result. You accepted it as is, with 1 red check:',
        '',
        `- ${RED_CHECK}`,
      ].join('\n'),
    );
  } finally {
    vi.unstubAllEnvs();
    restorePath();
    trustHome.restore();
    cleanupTempDir(target.tmpDir);
  }
});
