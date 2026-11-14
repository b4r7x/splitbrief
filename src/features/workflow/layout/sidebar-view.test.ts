import { beforeEach, describe, expect, it } from 'vitest';
import { makeConfig } from '#testing/helpers/factories/config.js';
import { forceUnicodeGlyphs } from '#testing/helpers/glyphs.js';
import type { Config } from '../../../core/schemas/config.js';
import { CREW_LABEL_WIDTH, PLANNER_INHERITANCE } from '../../../core/crew/identity.js';
import { deriveCrewSeats } from '../../../core/crew/seats.js';
import { type WorkflowTask, selectTaskListView } from '../../../core/run-view/briefs.js';
import { arrowSep } from '../../../core/separators.js';
import type { SeatResolvedModel } from '../../../stores/workflow/tokens/state.js';
import { getTerminalCellWidth } from '../../../utils/display-text/width.js';
import type { RecordedCrew } from '../closed/view-model.js';
import { getSidebarStatusColumnCells } from './rect.js';
import { deriveSidebarView } from './sidebar-view.js';

function task(id: string, status: WorkflowTask['status']): WorkflowTask {
  return { id, title: `task ${id}`, status };
}

/** 11 done, the 12th running, the rest pending. */
function plan(length: number): WorkflowTask[] {
  return Array.from({ length }, (_value, index) =>
    task(String(index + 1), index < 11 ? 'done' : index === 11 ? 'in_progress' : 'pending'),
  );
}

function derive(input: {
  tasks: WorkflowTask[];
  totalTasks?: number;
  width?: number;
  height: number | undefined;
  config?: Config;
  resolvedModels?: Partial<Record<'plan' | 'build' | 'review', SeatResolvedModel>>;
  recordedCrew?: RecordedCrew;
}) {
  return deriveSidebarView({
    view: selectTaskListView({
      tasks: input.tasks,
      totalTasks: input.totalTasks ?? input.tasks.length,
    }),
    seats: deriveCrewSeats({ config: input.config ?? makeConfig(), displayNames: {} }),
    displayNames: {},
    running: {},
    resolvedModels: input.resolvedModels ?? {},
    recordedCrew: input.recordedCrew,
    width: input.width ?? 40,
    height: input.height,
  });
}

const ids = (tasks: readonly WorkflowTask[]) => tasks.map((item) => item.id);
const seatRowsOf = (view: ReturnType<typeof derive>) => view.seatRows.map(({ rows }) => rows);

beforeEach(forceUnicodeGlyphs);

describe('deriveSidebarView — the task list window', () => {
  // At 40 columns the default crew takes three footer rows, so a 20-row panel lists 14 rows.
  it('windows a long plan around the running task and names each hidden slice', () => {
    const view = derive({ tasks: plan(24), height: 20 });

    expect(ids(view.visible)).toEqual([
      '7',
      '8',
      '9',
      '10',
      '11',
      '12',
      '13',
      '14',
      '15',
      '16',
      '17',
      '18',
    ]);
    expect(view.aboveLabel).toBe('6 done above');
    expect(view.tailLabel).toBe('6 queued below');
  });

  it('anchors a settled plan on its last task', () => {
    const tasks = Array.from({ length: 24 }, (_value, index) => task(String(index + 1), 'done'));
    const view = derive({ tasks, height: 20 });

    expect(view.visible.at(-1)?.id).toBe('24');
    expect(view.aboveLabel).toBe('11 done above');
    expect(view.tailLabel).toBeUndefined();

    // A panel of 8 rows lists 2: the last task and the row that names the rest.
    const tight = derive({ tasks, height: 8 });

    expect(ids(tight.visible)).toEqual(['24']);
    expect(tight.aboveLabel).toBe('23 done above');
    expect(tight.tailLabel).toBeUndefined();
  });

  it('falls back to a plain count when the hidden slice is not all one status', () => {
    const tasks = plan(24).map((item) => (item.id === '1' ? task('1', 'escalated') : item));
    // The escalated count takes a footer row of its own, so the list holds 13 rows.
    const view = derive({ tasks, height: 20 });

    expect(view.aboveLabel).toBe('6 above');
    expect(view.tailLabel).toBe('7 queued below');
  });

  it('carries both edges on one row when the list has one row to spare for them', () => {
    const tasks = Array.from({ length: 10 }, (_value, index) =>
      task(String(index + 1), index < 4 ? 'done' : index === 4 ? 'in_progress' : 'pending'),
    );
    const view = derive({ tasks, height: 8 });

    expect(ids(view.visible)).toEqual(['5']);
    expect(view.aboveLabel).toBeUndefined();
    expect(view.tailLabel).toBe('4 done above · 5 queued below');
  });

  it('drops the direction words from both edges when the combined row runs out of cells', () => {
    const tasks = Array.from({ length: 10 }, (_value, index) =>
      task(String(index + 1), index < 4 ? 'done' : index === 4 ? 'in_progress' : 'pending'),
    );
    // At 34 columns the BUILD identity wraps onto a second row, so a 9-row panel lists 2 rows.
    const view = derive({ tasks, width: 34, height: 9 });

    expect(ids(view.visible)).toEqual(['5']);
    expect(view.tailLabel).toBe('4 done · 5 queued');
  });

  it('lists every task when the caller passes no height', () => {
    const view = derive({ tasks: plan(30), height: undefined });

    expect(view.visible).toHaveLength(30);
    expect(view.aboveLabel).toBeUndefined();
    expect(view.tailLabel).toBeUndefined();
  });

  it('adds the unannounced count to the row of the below marker', () => {
    const view = derive({ tasks: plan(24), totalTasks: 30, height: 20 });

    expect(ids(view.visible)).toEqual([
      '7',
      '8',
      '9',
      '10',
      '11',
      '12',
      '13',
      '14',
      '15',
      '16',
      '17',
      '18',
    ]);
    expect(view.tailLabel).toBe('6 queued below · +6 more');
  });

  it('gives the unannounced count a row of its own when nothing is hidden below', () => {
    const tasks = [task('1', 'done'), task('2', 'in_progress'), task('3', 'pending')];
    // Three list rows hold the three tasks; the count takes one of them.
    const view = derive({ tasks, totalTasks: 5, height: 9 });

    expect(ids(view.visible)).toEqual(['2']);
    expect(view.tailLabel).toBe('1 done above · 1 queued below · +2 more');
  });

  it('reserves the status column only when a task carries a status word', () => {
    expect(derive({ tasks: plan(3), height: undefined }).statusCells).toBe(0);
    expect(
      derive({ tasks: [task('1', 'failed'), task('2', 'pending')], height: undefined }).statusCells,
    ).toBe(getSidebarStatusColumnCells({ hasStatusTail: true }));
  });
});

describe('deriveSidebarView — the title and the outcome rows', () => {
  it('counts the passed briefs against the plan size in the title', () => {
    expect(derive({ tasks: [], height: undefined }).title).toBe('Tasks');
    expect(derive({ tasks: plan(24), height: undefined }).title).toBe('Tasks 11/24');
  });

  it('adds outcome rows only when a brief escalated or failed', () => {
    expect(derive({ tasks: plan(3), height: undefined }).outcomeRows).toEqual([]);

    const view = derive({ tasks: [task('1', 'done'), task('2', 'failed')], height: undefined });

    expect(view.outcomeRows.map((spans) => spans.map((span) => span.text).join(''))).toEqual([
      '1 passed · 1 failed',
    ]);
  });
});

describe('deriveSidebarView — the crew rows', () => {
  const openCodeBuild = makeConfig({
    implementer: { kind: 'cli', tool: 'opencode', model: 'ollama-cloud/deepseek-v4.1-flash' },
  });

  it('wraps an identity wider than the seat column when the footer has the rows', () => {
    const view = derive({ tasks: plan(2), width: 34, height: undefined, config: openCodeBuild });

    expect(seatRowsOf(view)).toEqual([
      ['Claude Code CLI · auto'],
      ['OpenCode CLI', 'DeepSeek V4.1 Flash', 'via ollama-cloud'],
      [PLANNER_INHERITANCE.mark],
    ]);
  });

  it('gives each seat one row when the wrapped crew does not fit above the bottom border', () => {
    const view = derive({ tasks: plan(2), width: 34, height: 7, config: openCodeBuild });
    const rows = seatRowsOf(view);

    expect(rows.map((seat) => seat.length)).toEqual([1, 1, 1]);
    expect(rows[1]?.[0]).toBe('DeepSeek V4.1 Flash');
    for (const [row] of rows) {
      expect(getTerminalCellWidth(row ?? '')).toBeLessThanOrEqual(34 - 4 - CREW_LABEL_WIDTH);
    }
  });

  it('names the crew the run recorded and packs the pieces of a seat that moved', () => {
    const recordedCrew: RecordedCrew = {
      plan: {
        kind: 'named',
        short: 'Sonnet 4',
        full: 'Claude Code CLI · Sonnet 4',
        tool: 'claude-code',
      },
      build: {
        kind: 'moved',
        seats: [
          { short: 'Qwen2.5 Coder 7B', briefs: 2 },
          { short: 'Sonnet 4', briefs: 1 },
        ],
        contiguous: true,
      },
      review: { kind: 'none' },
    };
    const moved = `Qwen2.5 Coder 7B${arrowSep().trimEnd()}`;

    const wide = seatRowsOf(derive({ tasks: plan(2), height: undefined, recordedCrew }));
    const narrow = seatRowsOf(
      derive({ tasks: plan(2), width: 34, height: undefined, recordedCrew }),
    );

    expect(wide.slice(0, 2)).toEqual([['Claude Code CLI · Sonnet 4'], [`${moved} Sonnet 4`]]);
    expect(narrow[1]).toEqual([moved, 'Sonnet 4']);
  });

  describe('a model id a call resolved', () => {
    const aliasCrew = makeConfig({
      planner: { kind: 'cli', tool: 'claude-code', model: 'opus', effort: 'high' },
      implementer: { kind: 'cli', tool: 'claude-code', model: 'sonnet' },
      reviewer: { kind: 'cli', tool: 'codex', model: 'gpt-6.1-sol', effort: 'high' },
    });
    const resolvedModels = {
      plan: {
        runnerName: 'claude-code',
        model: 'opus',
        resolvedModel: 'claude-opus-5-5',
        backendKind: 'cli',
      },
      build: {
        runnerName: 'claude-code',
        model: 'sonnet',
        resolvedModel: 'claude-sonnet-5-5',
        backendKind: 'cli',
      },
    } satisfies Partial<Record<'plan' | 'build', SeatResolvedModel>>;

    it('adds the resolved id as a row under the seat identity', () => {
      const bare = derive({ tasks: plan(1), height: undefined, config: aliasCrew });
      const resolved = derive({
        tasks: plan(1),
        height: undefined,
        config: aliasCrew,
        resolvedModels,
      });

      expect(seatRowsOf(resolved)).toEqual([
        [...(seatRowsOf(bare)[0] ?? []), 'claude-opus-5-5'],
        [...(seatRowsOf(bare)[1] ?? []), 'claude-sonnet-5-5'],
        seatRowsOf(bare)[2],
      ]);
    });

    it('drops the resolved rows before it cuts the identities when the crew runs short of rows', () => {
      const bare = derive({ tasks: plan(1), height: 8, config: aliasCrew });
      const resolved = derive({ tasks: plan(1), height: 8, config: aliasCrew, resolvedModels });

      expect(seatRowsOf(bare).map((seat) => seat.length)).toEqual([2, 1, 2]);
      expect(seatRowsOf(resolved)).toEqual(seatRowsOf(bare));
    });
  });
});
