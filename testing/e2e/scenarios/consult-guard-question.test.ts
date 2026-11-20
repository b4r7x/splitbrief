import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { stripAnsiStyles } from '#testing/helpers/ansi.js';
import type { renderFeature } from '#testing/helpers/ink.js';
import { resetAllStores } from '#testing/helpers/stores.js';
import { cleanupTempDir } from '#testing/helpers/temp-dir.js';
import { openHaltedRun, settleOpenedRuns } from '../helpers/halted-run-screen.js';
import {
  cli,
  createStopContinueFixture,
  PLAN_ANSWER,
  type StopContinueFixture,
} from '../helpers/stop-continue-fixture.js';

const BLOCKED =
  '{"status":"blocked","question":"Which criterion covers the fallback?","filesNeeded":[]}';

function blockedImplementerScript(): string {
  return `for await (const chunk of process.stdin) void chunk;
process.stdout.write(${JSON.stringify(BLOCKED)});
`;
}

function consultAnswering(answer: unknown): string {
  return `(prompt) => {
  const heading = prompt.split('\\n').find((line) => line.startsWith('# '));
  return heading === '# Consult on a failing task' || heading === '# Consult continued'
    ? ${JSON.stringify(JSON.stringify(answer))}
    : undefined;
}`;
}

function guardAnswers(): Readonly<{ rewrite: unknown; split: unknown }> {
  const [task] = PLAN_ANSWER.result.tasks;
  if (task === undefined) throw new Error('the fixture plan has no task');
  return {
    rewrite: {
      answer: {
        diagnosis: 'The brief misses the fallback criterion.',
        action: 'rewrite-task',
        task: { ...task, criteria: ['C1', 'C4'] },
      },
    },
    split: {
      answer: {
        diagnosis: 'The brief mixes two changes.',
        action: 'split-task',
        tasks: [
          { ...task, id: 'T002', title: 'Add the marker', checks: [] },
          { ...task, id: 'T003', title: 'Add the greeting', checks: [], dependsOn: ['T002'] },
        ],
      },
    },
  };
}

let fixture: StopContinueFixture | undefined;
let ui: ReturnType<typeof renderFeature> | undefined;

beforeEach(() => resetAllStores());

afterEach(async () => {
  ui?.unmount();
  ui = undefined;
  await settleOpenedRuns();
  resetAllStores();
  vi.unstubAllEnvs();
  if (fixture !== undefined) cleanupTempDir(fixture.tmpDir);
  fixture = undefined;
});

async function startGuardedRun(answer: unknown) {
  const target = createStopContinueFixture(blockedImplementerScript, {
    consult: () => consultAnswering(answer),
  });
  fixture = target;
  return { target, run: await cli(target, ['start', 'smoke']) };
}

describe('e2e: a consult answer that the criteria guard holds', () => {
  it('shows no rewrote row and names the added criterion when the criteria guard holds a rewrite', async () => {
    const { rewrite } = guardAnswers();
    const { target, run } = await startGuardedRun(rewrite);

    expect(run.exitCode, `${run.stdout}\n${run.stderr}`).toBe(1);
    expect(run.stderr).toContain('Error: Needs you (retry-exhausted): T001 needs your answer');
    expect(run.stderr.split('\n')).toContain(
      'Question: SPLITBRIEF asked the planner to fix T001, but the rewritten brief changes its criteria: adds C4. How should T001 proceed?',
    );
    expect(run.stderr).not.toContain('Dropped criteria');

    const opened = await openHaltedRun(target, { heading: 'Needs you' });
    ui = opened.screen;
    const frame = stripAnsiStyles(opened.screen.lastFrame());

    expect(frame).not.toContain('rewrote T001');
    expect(frame).toContain('changes its criteria: adds C4.');
    expect(frame).not.toContain('Dropped');
  });

  it('shows no split row and no Dropped criteria line when the criteria guard holds a split', async () => {
    const { split } = guardAnswers();
    const { target, run } = await startGuardedRun(split);

    expect(run.exitCode, `${run.stdout}\n${run.stderr}`).toBe(1);
    expect(run.stderr).toContain('Error: Needs you (retry-exhausted): T001 needs your answer');
    expect(run.stderr.split('\n')).toContain(
      'Question: SPLITBRIEF asked the planner to fix T001, but the new briefs together drop the checks their criteria require: T001-K1 (src/greet.ts), T001-K2 (src/greet.ts). How should T001 proceed?',
    );
    expect(run.stderr).not.toContain('Dropped criteria');

    const opened = await openHaltedRun(target, { heading: 'Needs you' });
    ui = opened.screen;
    const frame = stripAnsiStyles(opened.screen.lastFrame());

    expect(frame).toContain('T001-K2 (src/greet.ts)');
    expect(frame).not.toContain('split into T002, T003');
    expect(frame).not.toContain('Dropped');
  });
});
