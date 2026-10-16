import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { afterEach, describe, expect, it } from 'vitest';
import { buildCommandContext } from '../../../src/app/command-context.js';
import { sessionsRoot, sessionDir } from '../../../src/core/paths.js';
import { readRunRecord } from '../../../src/core/sessions/run-record-io.js';
import { loadState, saveState } from '../../../src/core/state/persistence.js';
import { formatRejectRunMessage } from '../../../src/core/runtime/commands/messages.js';
import { configStore } from '../../../src/stores/project/config.js';
import { routerStore } from '../../../src/stores/navigation/router.js';
import { feedbackStore } from '../../../src/stores/ui/feedback.js';
import { isLivePhase } from '../../../src/core/phases.js';
import { createRuntimeCommands } from '../../../src/core/runtime/commands/registry.js';
import { bylineParts } from '../../../src/features/workflow/closed/byline.js';
import { hydrateRun } from '../../../src/features/workflow/run-history.js';
import { lifecycleStore } from '../../../src/stores/workflow/lifecycle.js';
import { deriveSummaryView } from '../../../src/features/workflow/closed/view-model.js';
import { cleanupTempDir } from '#testing/helpers/temp-dir.js';
import { makeConfig } from '#testing/helpers/factories/config.js';
import { failedReviewVerdict } from '#testing/helpers/typed-planner.js';
import { resetAllStores } from '#testing/helpers/stores.js';
import { makePreparedExecution } from '#testing/helpers/factories/prepared-execution.js';
import { runCommandInTest } from '#testing/helpers/runtime-commands.js';
import {
  cli,
  createStopContinueFixture,
  ESCAPED_BRANCH,
  GREET_FILE,
  GREET_SOURCE,
  MARKER_FILE,
  MARKER_SOURCE,
  type StopContinueFixture,
} from '../helpers/stop-continue-fixture.js';

let fixture: StopContinueFixture | undefined;

afterEach(() => {
  resetAllStores();
  if (fixture !== undefined) cleanupTempDir(fixture.tmpDir);
  fixture = undefined;
});

const FIX_FILE = 'src/fix.ts';
const FIX_SOURCE = 'export const FIXED = true;\n';
const FIX_INTENT = 'Export the greeting constant beside greet.';
const FIXED_GREET_SOURCE = `${GREET_SOURCE}\nexport const GREETING = 'hello';\n`;

function implementer(): string {
  return `import { mkdirSync, writeFileSync } from 'node:fs';
for await (const chunk of process.stdin) void chunk;
mkdirSync('src', { recursive: true });
writeFileSync(${JSON.stringify(GREET_FILE)}, ${JSON.stringify(GREET_SOURCE)});
writeFileSync(${JSON.stringify(MARKER_FILE)}, ${JSON.stringify(MARKER_SOURCE)});
`;
}

function fixingImplementer(): string {
  return `import { mkdirSync, writeFileSync } from 'node:fs';
const chunks = [];
for await (const chunk of process.stdin) chunks.push(chunk);
mkdirSync('src', { recursive: true });
if (Buffer.concat(chunks).toString('utf-8').includes(${JSON.stringify(FIX_INTENT)})) {
  writeFileSync(${JSON.stringify(GREET_FILE)}, ${JSON.stringify(FIXED_GREET_SOURCE)});
  writeFileSync(${JSON.stringify(FIX_FILE)}, ${JSON.stringify(FIX_SOURCE)});
} else {
  writeFileSync(${JSON.stringify(GREET_FILE)}, ${JSON.stringify(GREET_SOURCE)});
  writeFileSync(${JSON.stringify(MARKER_FILE)}, ${JSON.stringify(MARKER_SOURCE)});
}
`;
}

const SECOND_FILE = 'src/second.ts';
const SECOND_SOURCE = 'export const SECOND = 2;\n';

/**
 * The first call writes T001's files. Every later call is T002: it moves the checkout's git state
 * (a new branch) and writes its own file, so the run halts `checkout-changed` in the task loop
 * after T001 passed.
 */
function haltingSecondBriefImplementer(checkoutDir: string): string {
  const countPath = join(checkoutDir, '..', 'implementer-invocations');
  return `import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
for await (const chunk of process.stdin) void chunk;
mkdirSync('src', { recursive: true });
if (existsSync(${JSON.stringify(countPath)})) {
  spawnSync('git', ['-C', ${JSON.stringify(checkoutDir)}, 'branch', ${JSON.stringify(ESCAPED_BRANCH)}]);
  writeFileSync(${JSON.stringify(GREET_FILE)}, 'T002 rewrote this\\n');
  writeFileSync(${JSON.stringify(SECOND_FILE)}, ${JSON.stringify(SECOND_SOURCE)});
} else {
  writeFileSync(${JSON.stringify(countPath)}, '1');
  writeFileSync(${JSON.stringify(GREET_FILE)}, ${JSON.stringify(GREET_SOURCE)});
  writeFileSync(${JSON.stringify(MARKER_FILE)}, ${JSON.stringify(MARKER_SOURCE)});
}
`;
}

/**
 * The first call writes T001's files. The second call is T002: it says it started, then holds
 * until the test kills the run or releases it.
 */
function holdingSecondBriefImplementer(checkoutDir: string): string {
  const tmpDir = join(checkoutDir, '..');
  const countPath = join(tmpDir, 'implementer-invocations');
  return `import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { setTimeout as delay } from 'node:timers/promises';
for await (const chunk of process.stdin) void chunk;
if (existsSync(${JSON.stringify(countPath)})) {
  writeFileSync(${JSON.stringify(join(tmpDir, 'second-brief-holding'))}, '');
  const deadline = Date.now() + 60_000;
  while (!existsSync(${JSON.stringify(join(tmpDir, 'release-second-brief'))}) && Date.now() < deadline) {
    await delay(50);
  }
} else {
  writeFileSync(${JSON.stringify(countPath)}, '1');
  mkdirSync('src', { recursive: true });
  writeFileSync(${JSON.stringify(GREET_FILE)}, ${JSON.stringify(GREET_SOURCE)});
  writeFileSync(${JSON.stringify(MARKER_FILE)}, ${JSON.stringify(MARKER_SOURCE)});
}
`;
}

/** The fixture's plan with a second brief, T002, that writes its own file after T001. */
function planTwoBriefs(target: StopContinueFixture): void {
  const plannerPath = join(target.projectDir, 'tools', 'planner.mjs');
  const script = readFileSync(plannerPath, 'utf8');
  const line = /^const PLAN = (.*);$/m.exec(script);
  if (line?.[1] === undefined) throw new Error('the fixture planner names no PLAN');
  const plan = JSON.parse(JSON.parse(line[1]));
  const first = plan.result.tasks[0];
  plan.result.criteria.push({ id: 'C2', text: 'second exists', checkIds: ['T002-K1'] });
  plan.result.tasks.push({
    ...first,
    id: 'T002',
    title: 'Add the second module',
    intent: 'Add the second module beside the greeting.',
    criteria: ['C2'],
    checks: [{ id: 'T002-K1', kind: 'test', value: 'SECOND === 2', required: true }],
    suggestedFiles: [GREET_FILE, SECOND_FILE],
    steps: [`Create \`${SECOND_FILE}\` exporting \`SECOND\`.`],
    dependsOn: ['T001'],
    batch: 2,
  });
  writeFileSync(
    plannerPath,
    script.replace(line[0], `const PLAN = ${JSON.stringify(JSON.stringify(plan))};`),
  );
}

function scriptReviews(target: StopContinueFixture, reviews: string): void {
  const plannerPath = join(target.projectDir, 'tools', 'planner.mjs');
  writeFileSync(
    plannerPath,
    readFileSync(plannerPath, 'utf8').replace(
      "process.stdout.write(prompt.includes('Final Implementation Review') ? REVIEW : PLAN);",
      reviews,
    ),
  );
}

function openRun(target: StopContinueFixture) {
  const ids = readdirSync(sessionsRoot(target.projectDir));
  expect(ids).toHaveLength(1);
  const sessionId = ids[0];
  if (sessionId === undefined) throw new Error('CLI left no session');
  const ref = { projectDir: target.projectDir, sessionId };
  const record = readRunRecord(ref);
  const config = makeConfig({ workflow: { isolation: 'none' } });
  configStore.__testReset({ projectDir: target.projectDir, config, diskConfig: config });
  routerStore.init({ screen: 'workflow', run: record, execution: { kind: 'at-rest' } });
  const commands = buildCommandContext({
    exit: () => {},
    workflow: {
      requestClearQueue: () => ({ status: 'cleared', count: 0 }),
      getRowActions: () => new Map(),
      readScrollMetrics: () => ({
        renderableCount: 0,
        totalHeight: 0,
        maxOffset: 0,
        viewportHeight: 0,
      }),
      resolveCopyValue: () => null,
    },
  });
  return { ref, record, commands };
}

describe('run rejection after a source CLI run', () => {
  it.each(['worktree', 'staged-copy'] as const)(
    'undoes a completed Apply recorded on a %s run and keeps later edits',
    async (kind) => {
      fixture = createStopContinueFixture(implementer, { isolation: 'staged-copy' });
      const started = await cli(fixture, ['start', 'smoke']);
      expect(started.exitCode, started.stderr).toBe(0);
      const opened = openRun(fixture);
      expect(opened.record.status.kind).toBe('ready-to-apply');
      const applied = await cli(fixture, ['continue', opened.ref.sessionId, '--action', 'apply']);
      expect(applied.exitCode, applied.stderr).toBe(0);
      const state = loadState(opened.ref);
      if (state?.workspace === undefined) throw new Error('applied run left no workspace record');
      saveState(opened.ref, { ...state, workspace: { ...state.workspace, kind } });
      const { ref, record, commands } = openRun(fixture);
      expect(record.status).toEqual({ kind: 'closed', as: 'applied' });
      const view = deriveSummaryView({ record });
      if (view === null) throw new Error('applied run left no closed view');
      expect(
        bylineParts(view, 120)
          .map((part) => part.text)
          .join(''),
      ).toBe('Undo the Apply with /run reject confirm');
      writeFileSync(fixture.greetPath, 'later user edit\n');

      expect(await commands.rejectRun()).toEqual({
        status: 'undone',
        restored: [MARKER_FILE],
        unchanged: [],
        conflicts: [GREET_FILE],
      });
      expect(readFileSync(fixture.greetPath, 'utf8')).toBe('later user edit\n');
      expect(existsSync(fixture.markerPath)).toBe(false);
      expect(loadState(ref)?.applied?.undone?.conflicts).toEqual([GREET_FILE]);
      expect(loadState(ref)?.closed?.as).toBe('applied');
    },
  );
  it('refuses rejection after a passing review closes the run', async () => {
    fixture = createStopContinueFixture(implementer, { isolation: 'none' });
    const started = await cli(fixture, ['start', 'smoke']);
    expect(started.exitCode, started.stderr).toBe(0);
    const { ref, record, commands } = openRun(fixture);
    expect(record.status).toEqual({ kind: 'closed', as: 'complete' });
    const view = deriveSummaryView({ record });
    if (view === null) throw new Error('completed run left no closed view');
    expect(
      bylineParts(view, 120)
        .map((part) => part.text)
        .join(''),
    ).not.toContain('/run');
    writeFileSync(fixture.greetPath, 'later user edit\n');
    writeFileSync(join(fixture.projectDir, 'user.txt'), 'later user file\n');

    expect(await commands.rejectRun()).toEqual({
      status: 'unavailable',
      message: 'Run is closed (complete).',
    });

    expect(readFileSync(fixture.greetPath, 'utf8')).toBe('later user edit\n');
    expect(readFileSync(join(fixture.projectDir, 'user.txt'), 'utf8')).toBe('later user file\n');
    expect(readFileSync(fixture.markerPath, 'utf8')).toBe(MARKER_SOURCE);
    expect(existsSync(join(sessionDir(ref.projectDir, ref.sessionId), 'reverted'))).toBe(false);
  });

  it('keeps later user work, rejects only unchanged run output and stays retryable', async () => {
    fixture = createStopContinueFixture(implementer, { isolation: 'none' });
    scriptReviews(
      fixture,
      "if (prompt.includes('Final Implementation Review')) process.exit(1);\nprocess.stdout.write(PLAN);",
    );
    const started = await cli(fixture, ['start', 'smoke']);
    expect(started.exitCode, started.stderr).toBe(1);
    const { ref, record, commands } = openRun(fixture);
    expect(record.status.kind).toBe('open');
    expect(readFileSync(fixture.greetPath, 'utf8')).toBe(GREET_SOURCE);
    writeFileSync(fixture.greetPath, 'later user edit\n');
    writeFileSync(join(fixture.projectDir, 'user.txt'), 'later user file\n');

    const result = await commands.rejectRun();

    expect(result).toMatchObject({
      status: 'rejected',
      conflictedPaths: [GREET_FILE],
      deletedPaths: [MARKER_FILE],
    });
    if (result.status !== 'rejected') throw new Error('run rejection failed');
    expect(formatRejectRunMessage(result)).toContain(`left as you changed them: ${GREET_FILE}.`);
    expect(readFileSync(fixture.greetPath, 'utf8')).toBe('later user edit\n');
    expect(readFileSync(join(fixture.projectDir, 'user.txt'), 'utf8')).toBe('later user file\n');
    expect(existsSync(fixture.markerPath)).toBe(false);
    expect(loadState(ref)?.closed).toBeUndefined();
    if (result.status !== 'rejected' || result.savedTo === undefined) {
      throw new Error('missing replaced file backup');
    }
    expect(readFileSync(join(fixture.projectDir, result.savedTo, MARKER_FILE), 'utf8')).toBe(
      MARKER_SOURCE,
    );
    expect(existsSync(join(fixture.projectDir, result.savedTo, GREET_FILE))).toBe(false);

    writeFileSync(fixture.greetPath, GREET_SOURCE);
    expect(await commands.rejectRun()).toMatchObject({ status: 'rejected', conflictedPaths: [] });
    expect(existsSync(fixture.greetPath)).toBe(false);
    expect(loadState(ref)?.closed?.as).toBe('discarded');
  });

  it('rejects a run halted in its review through /run reject confirm once it is at rest', async () => {
    fixture = createStopContinueFixture(implementer, { isolation: 'none' });
    scriptReviews(
      fixture,
      "if (prompt.includes('Final Implementation Review')) process.exit(1);\nprocess.stdout.write(PLAN);",
    );
    const started = await cli(fixture, ['start', 'smoke']);
    expect(started.exitCode, started.stderr).toBe(1);
    const { ref, record, commands } = openRun(fixture);
    expect(record.status.kind).toBe('open');
    await hydrateRun(record);
    const { phase } = lifecycleStore.get();
    expect(phase).toBe(loadState(ref)?.phase);
    expect(isLivePhase(phase)).toBe(true);
    const reject = () =>
      runCommandInTest({
        commands: createRuntimeCommands(commands),
        raw: '/run reject confirm',
        screen: 'workflow',
        phase,
        openRunAtRest: true,
        onError: (message) => {
          throw new Error(message);
        },
      });

    routerStore.updateRun({
      run: record,
      execution: {
        kind: 'local',
        prepared: makePreparedExecution({
          projectDir: ref.projectDir,
          sessionId: ref.sessionId,
          feature: 'smoke',
          config: makeConfig({ workflow: { isolation: 'none' } }),
        }),
      },
    });
    await reject();
    expect(feedbackStore.get()).toEqual({
      message: 'Run rejection is unavailable while the run is active.',
      isError: true,
    });
    expect(readFileSync(fixture.greetPath, 'utf8')).toBe(GREET_SOURCE);

    routerStore.updateRun({ run: record, execution: { kind: 'at-rest' } });
    await reject();
    expect(feedbackStore.get().isError).toBe(false);
    expect(existsSync(fixture.greetPath)).toBe(false);
    expect(existsSync(fixture.markerPath)).toBe(false);
    expect(loadState(ref)?.closed?.as).toBe('discarded');
  });

  it('rejects what a fix cycle wrote after a failed review', async () => {
    fixture = createStopContinueFixture(fixingImplementer, { isolation: 'none' });
    const failed = failedReviewVerdict(
      'Task ids: T001\nCriterion ids: C1',
      'The greeting needs its constant.',
      { taskId: 'T001', file: GREET_FILE, criterionId: 'C1' },
    );
    const fixTask = failed.fixTasks[0];
    if (fixTask === undefined) throw new Error('failed verdict carries no fix task');
    const verdict = {
      ...failed,
      fixTasks: [
        { ...fixTask, intent: FIX_INTENT, suggestedFiles: [GREET_FILE, FIX_FILE], checks: [] },
      ],
    };
    const reviewsPath = join(fixture.tmpDir, 'reviews');
    scriptReviews(
      fixture,
      `if (!prompt.includes('Final Implementation Review')) process.stdout.write(PLAN);
else {
  const { existsSync, writeFileSync } = await import('node:fs');
  if (existsSync(${JSON.stringify(reviewsPath)})) process.exit(1);
  writeFileSync(${JSON.stringify(reviewsPath)}, '1');
  process.stdout.write(${JSON.stringify(JSON.stringify(verdict))});
}`,
    );
    const started = await cli(fixture, ['start', 'smoke']);
    expect(started.exitCode, started.stderr).toBe(1);
    const { ref, record, commands } = openRun(fixture);
    expect(record.status.kind).toBe('open');
    expect(readFileSync(fixture.greetPath, 'utf8')).toBe(FIXED_GREET_SOURCE);
    expect(readFileSync(join(fixture.projectDir, FIX_FILE), 'utf8')).toBe(FIX_SOURCE);

    expect(await commands.rejectRun()).toMatchObject({
      status: 'rejected',
      conflictedPaths: [],
      missingSnapshotFiles: [],
      deletedPaths: [FIX_FILE, GREET_FILE, MARKER_FILE],
    });
    expect(existsSync(fixture.greetPath)).toBe(false);
    expect(existsSync(fixture.markerPath)).toBe(false);
    expect(existsSync(join(fixture.projectDir, FIX_FILE))).toBe(false);
    expect(loadState(ref)?.closed?.as).toBe('discarded');
  });

  it('rejects what a passed brief wrote when a later brief halts the run', async () => {
    fixture = createStopContinueFixture(haltingSecondBriefImplementer, { isolation: 'none' });
    planTwoBriefs(fixture);
    const halted = await cli(fixture, ['start', 'smoke']);
    expect(halted.exitCode, halted.stderr).toBe(1);
    expect(halted.stdout).toContain('task T001: done');
    expect(halted.stderr).toContain('Needs you (checkout-changed)');
    const { ref, record, commands } = openRun(fixture);
    expect(record.status.kind).toBe('open');
    expect(readFileSync(fixture.greetPath, 'utf8')).toBe(GREET_SOURCE);
    expect(readFileSync(fixture.markerPath, 'utf8')).toBe(MARKER_SOURCE);
    expect(existsSync(join(fixture.projectDir, SECOND_FILE))).toBe(false);
    const gitignore = join(fixture.projectDir, '.gitignore');
    writeFileSync(gitignore, `${readFileSync(gitignore, 'utf8')}coverage\n`);
    writeFileSync(join(fixture.projectDir, 'user.txt'), 'later user file\n');

    const result = await commands.rejectRun();

    expect(result).toMatchObject({
      status: 'rejected',
      restoredPaths: [],
      deletedPaths: [GREET_FILE, MARKER_FILE],
      conflictedPaths: [],
      missingSnapshotFiles: [],
    });
    expect(existsSync(fixture.greetPath)).toBe(false);
    expect(existsSync(fixture.markerPath)).toBe(false);
    expect(readFileSync(gitignore, 'utf8')).toBe('node_modules\ncoverage\n');
    expect(readFileSync(join(fixture.projectDir, 'user.txt'), 'utf8')).toBe('later user file\n');
    expect(loadState(ref)?.closed?.as).toBe('discarded');
  });

  it('rejects what a passed brief wrote when the process is killed in a later brief', async () => {
    fixture = createStopContinueFixture(holdingSecondBriefImplementer, { isolation: 'none' });
    planTwoBriefs(fixture);
    const holding = join(fixture.tmpDir, 'second-brief-holding');
    let groupPid: number | undefined;
    const run = cli(fixture, ['start', 'smoke'], {
      timeoutMs: 90_000,
      onSpawn: (pid) => {
        groupPid = pid;
      },
    });
    try {
      const deadline = Date.now() + 75_000;
      while (!existsSync(holding) && Date.now() < deadline) await delay(50);
      if (!existsSync(holding) || groupPid === undefined) {
        throw new Error(`T002 never started: ${(await run).stderr}`);
      }
      process.kill(-groupPid, 'SIGKILL');
      await run;
    } finally {
      writeFileSync(join(fixture.tmpDir, 'release-second-brief'), '');
    }
    const { ref, record, commands } = openRun(fixture);
    expect(record.status.kind).toBe('open');
    expect(readFileSync(fixture.greetPath, 'utf8')).toBe(GREET_SOURCE);
    writeFileSync(join(fixture.projectDir, 'user.txt'), 'later user file\n');

    expect(await commands.rejectRun()).toMatchObject({
      status: 'rejected',
      restoredPaths: [],
      deletedPaths: [GREET_FILE, MARKER_FILE],
      conflictedPaths: [],
      missingSnapshotFiles: [],
    });
    expect(existsSync(fixture.greetPath)).toBe(false);
    expect(existsSync(fixture.markerPath)).toBe(false);
    expect(readFileSync(join(fixture.projectDir, 'user.txt'), 'utf8')).toBe('later user file\n');
    expect(loadState(ref)?.closed?.as).toBe('discarded');
  });
});
