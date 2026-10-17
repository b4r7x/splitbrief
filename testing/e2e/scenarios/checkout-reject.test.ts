import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createElement } from 'react';
import { setTimeout as delay } from 'node:timers/promises';
import { afterEach, describe, expect, it } from 'vitest';
import { buildCommandContext } from '../../../src/app/command-context.js';
import { sessionsRoot, sessionDir } from '../../../src/core/paths.js';
import { readRunRecord } from '../../../src/core/sessions/run-record-io.js';
import { listSessions, readSession } from '../../../src/core/sessions/io.js';
import { SessionRow } from '../../../src/components/session-row.js';
import { renderFeature } from '#testing/helpers/ink.js';
import { stripAnsiStyles } from '#testing/helpers/ansi.js';
import { loadState, saveState } from '../../../src/core/state/persistence.js';
import {
  formatRejectRunMessage,
  runRejectFacts,
} from '../../../src/core/runtime/commands/messages.js';
import { readRunEvents } from '../../../src/engine/events/replay.js';
import { stopByline } from '../../../src/features/workflow/stop/copy.js';
import { openRunBylineParts } from '../../../src/features/workflow/closed/byline.js';
import { outcomeLineSpans } from '../../../src/features/workflow/closed/outcome.js';
import { rowText } from '../../../src/features/workflow/conversation-rows/row-format/rows.js';
import { getSections } from '../../../src/stores/workflow/actions/sections.js';
import { resetWorkflow } from '../../../src/stores/workflow/actions/reset.js';
import { buildConversationRows } from '#testing/helpers/event-rows.js';
import type { RunRecord } from '../../../src/core/sessions/run-record.js';
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
  endImplementerHold,
  ESCAPED_BRANCH,
  GREET_FILE,
  GREET_SOURCE,
  MARKER_FILE,
  MARKER_SOURCE,
  startAndSignal,
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

/**
 * The first call writes T001's files. The second call is T002: it writes its own file, then marks
 * that it holds (under `t002-holding`, where a stop waits for it) until a stop ends it.
 */
function stoppableSecondBriefImplementer(checkoutDir: string): string {
  const tmpDir = join(checkoutDir, '..');
  const countPath = join(tmpDir, 'implementer-invocations');
  const holding = join(tmpDir, 't002-holding', MARKER_FILE);
  return `import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
for await (const chunk of process.stdin) void chunk;
mkdirSync('src', { recursive: true });
if (existsSync(${JSON.stringify(countPath)})) {
  writeFileSync(${JSON.stringify(SECOND_FILE)}, ${JSON.stringify(SECOND_SOURCE)});
  writeFileSync(${JSON.stringify(join(tmpDir, 'implementer-hold.pid'))}, String(process.pid));
  mkdirSync(dirname(${JSON.stringify(holding)}), { recursive: true });
  writeFileSync(${JSON.stringify(holding)}, '');
  const deadline = Date.now() + 60_000;
  while (!existsSync(${JSON.stringify(join(tmpDir, 'release-implementer'))}) && Date.now() < deadline) {
    await delay(50);
  }
  writeFileSync(${JSON.stringify(join(tmpDir, 'implementer-hold-exited'))}, '');
} else {
  writeFileSync(${JSON.stringify(countPath)}, '1');
  writeFileSync(${JSON.stringify(GREET_FILE)}, ${JSON.stringify(GREET_SOURCE)});
  writeFileSync(${JSON.stringify(MARKER_FILE)}, ${JSON.stringify(MARKER_SOURCE)});
}
`;
}

/** The transcript of the run on screen, one trimmed line per row. */
function transcriptText(): string {
  const { rows } = buildConversationRows({
    sections: getSections(),
    cols: 120,
    viewportHeight: 400,
    expandedDiffs: new Set(),
    expandedActivityBatches: new Set(),
    streaming: { taskId: null, lines: [], active: false },
  });
  return rows.map((row) => rowText(row).trim()).join('\n');
}

/** The stop byline of a run parked mid-brief, read from the record the stop settled at rest. */
function parkedBylineText(record: RunRecord, kept: readonly string[]): string {
  return (
    stopByline({
      intent: 'stop-now',
      phase: 'parked',
      workflowPhase: 'implementing',
      parked: { kind: 'mid-brief', taskId: 'T002', kept },
      currentTaskId: 'T002',
      nextTaskId: null,
      passed: 1,
      total: 2,
      elapsedMs: 0,
      questionPending: false,
      suite: null,
      record,
    })
      ?.parts.map((part) => part.text)
      .join('') ?? ''
  );
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
        removed: [MARKER_FILE],
        unchanged: [],
        conflicts: [GREET_FILE],
      });
      expect(readFileSync(fixture.greetPath, 'utf8')).toBe('later user edit\n');
      expect(existsSync(fixture.markerPath)).toBe(false);
      expect(loadState(ref)?.applied?.undone?.conflicts).toEqual([GREET_FILE]);
      expect(loadState(ref)?.closed?.as).toBe('applied');
    },
  );

  it('lists a run whose Apply was undone as apply undone in Sessions', async () => {
    fixture = createStopContinueFixture(implementer, { isolation: 'staged-copy' });
    const started = await cli(fixture, ['start', 'smoke']);
    expect(started.exitCode, started.stderr).toBe(0);
    const opened = openRun(fixture);
    const applied = await cli(fixture, ['continue', opened.ref.sessionId, '--action', 'apply']);
    expect(applied.exitCode, applied.stderr).toBe(0);
    const { commands } = openRun(fixture);

    expect(await commands.rejectRun()).toMatchObject({ status: 'undone' });

    expect(readSession(opened.ref)?.apply).toBe('undone');
    expect(await commands.acceptRun(false)).toEqual({
      status: 'unavailable',
      message: 'Apply already undone; the run is closed.',
    });
    const [session] = listSessions(fixture.projectDir);
    if (session === undefined) throw new Error('undone run left no session row');
    const ui = renderFeature(createElement(SessionRow, { session }));
    const row = stripAnsiStyles(ui.lastFrame() ?? '');
    ui.unmount();
    expect(row).toContain('apply undone');
    expect(row).not.toContain('applied');
  });

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
    expect(formatRejectRunMessage(runRejectFacts(result))).toContain(
      `1 file left as you changed it: ${GREET_FILE}.`,
    );
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

  // RC6 run A: a stop cut T002, the user edited T001's file and wrote a file of their own, and two
  // rejects followed. The first left the run open still claiming T002's partial changes, with no
  // record of the reject and a feedback line cut at the pane width. The second closed it claiming a
  // run.patch, saying the changes were "already there", with the user's file in the Files list.
  it('records a partial reject, drops what it put back from the stop, and closes the second time without false claims', {
    timeout: 180_000,
  }, async () => {
    fixture = createStopContinueFixture(stoppableSecondBriefImplementer, { isolation: 'none' });
    planTwoBriefs(fixture);
    const target = fixture;
    try {
      const parked = await startAndSignal(target, 'SIGINT', join(target.tmpDir, 't002-holding'));
      expect(parked.exitCode).toBe(0);
    } finally {
      await endImplementerHold(target);
    }
    const parkedRun = openRun(target);
    const { ref, commands } = parkedRun;
    expect(loadState(ref)?.interruptedStep).toMatchObject({ cut: 'mid-step', kept: [SECOND_FILE] });
    expect(parkedBylineText(parkedRun.record, [SECOND_FILE])).toBe(
      'Stopped at T002 · Partial changes kept',
    );
    writeFileSync(target.greetPath, 'later user edit\n');
    writeFileSync(join(target.projectDir, 'later-user.txt'), 'later user file\n');
    resetWorkflow();

    const first = await commands.rejectRun();

    expect(first).toMatchObject({
      status: 'rejected',
      deletedPaths: [MARKER_FILE, SECOND_FILE],
      conflictedPaths: [GREET_FILE],
      missingSnapshotFiles: [],
    });
    if (first.status !== 'rejected' || first.savedTo === undefined) {
      throw new Error('the partial reject saved no replaced files');
    }
    expect(existsSync(join(target.projectDir, SECOND_FILE))).toBe(false);
    const open = readRunRecord(ref);
    expect(open.status.kind).toBe('open');
    expect(loadState(ref)?.interruptedStep).not.toHaveProperty('kept');
    expect(parkedBylineText(open, [SECOND_FILE])).toBe('Stopped at T002');
    const whole = `Rejected Removed 2 created files. 1 file left as you changed it: ${GREET_FILE}. The replaced files are saved in ${first.savedTo}. The run stays open, so you can reject it again.`;
    expect(formatRejectRunMessage(runRejectFacts(first))).toBe(whole.slice('Rejected '.length));
    expect(transcriptText().replace(/\s+/g, ' ')).toContain(whole);
    expect((await readRunEvents(ref)).events.filter((e) => e.type === 'run_rejected')).toEqual([
      expect.objectContaining({
        restored: [MARKER_FILE, SECOND_FILE],
        removed: [MARKER_FILE, SECOND_FILE],
        conflicted: [GREET_FILE],
        missing: 0,
        savedTo: first.savedTo,
      }),
    ]);

    resetWorkflow();
    const reopened = readRunRecord(ref);
    await hydrateRun(reopened);
    expect(transcriptText().replace(/\s+/g, ' ')).toContain(whole);
    if (reopened.status.kind !== 'open') throw new Error('the partial reject closed the run');
    expect(
      openRunBylineParts({ status: reopened.status, continuable: true, width: 120 })
        .map((part) => part.text)
        .join(''),
    ).not.toContain('kept');

    writeFileSync(target.greetPath, GREET_SOURCE);
    const second = await commands.rejectRun();

    expect(second).toMatchObject({
      status: 'rejected',
      deletedPaths: [GREET_FILE],
      conflictedPaths: [],
    });
    expect(loadState(ref)?.closed?.as).toBe('discarded');
    expect(existsSync(join(sessionDir(ref.projectDir, ref.sessionId), 'run.patch'))).toBe(false);
    const { events } = await readRunEvents(ref);
    expect(
      events.filter((e) => e.type === 'warning' && e.message.includes('already there')),
    ).toEqual([]);
    const view = deriveSummaryView({ record: readRunRecord(ref) });
    if (view === null) throw new Error('the discarded run left no closed view');
    expect(
      outcomeLineSpans(view, 120)
        .map((span) => span.text)
        .join(''),
    ).toBe('Discarded · 1/2 briefs passed · removed 3 created files');
    expect(view.files.changed).toEqual([GREET_FILE, MARKER_FILE, SECOND_FILE]);
    expect([...view.files.partial]).toEqual([SECOND_FILE]);
    expect(readFileSync(join(target.projectDir, 'later-user.txt'), 'utf8')).toBe(
      'later user file\n',
    );
  });
});
