import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterEach, expect, it } from 'vitest';
import { eventRows } from '#testing/helpers/event-rows.js';
import { makeConfig } from '#testing/helpers/factories/config.js';
import { makePlanProposal, makeTaskSpec } from '#testing/helpers/factories/plan.js';
import { makeWorkflowState } from '#testing/helpers/factories/workflow-state.js';
import {
  makeBusRecorder,
  makeCallbacks,
  TEST_METADATA,
  TEST_SINKS,
} from '#testing/helpers/orchestrator-factories.js';
import { createTempDir } from '#testing/helpers/temp-dir.js';
import { sessionDir } from '../../../../core/paths.js';
import { compilePlan } from '../../../../engine/orchestrator/planning/compile.js';
import { configStore } from '../../../../stores/project/config.js';
import { getTerminalCellWidth } from '../../../../utils/display-text/width.js';
import { rowLeadingCells } from '../row-format/markers.js';
import { rowText } from '../row-format/rows.js';

const first = makePlanProposal({
  summary:
    'Add a greeting module and expose it from the command line for every supported language.',
  tasks: [makeTaskSpec(), makeTaskSpec({ id: 'T002', title: 'Expose the greeting' })],
});
const revision = makePlanProposal({
  summary: 'Keep the greeting in the library.',
  criteria: [...first.criteria, { id: 'C2', text: 'The library exports greet.', checkIds: ['K1'] }],
});

afterEach(() => configStore.__testReset());

function compileHistory(width: number) {
  const projectDir = createTempDir('plan-block');
  configStore.__testReset({ projectDir });
  const sessionId = 'greeting';
  const { bus, events } = makeBusRecorder();
  const context = {
    projectDir,
    sessionId,
    bus,
    config: makeConfig(),
    ...makeCallbacks(),
    metadata: TEST_METADATA,
    sinks: TEST_SINKS,
  };
  const initial = compilePlan(context, makeWorkflowState({ phase: 'planning' }), first);
  compilePlan(context, initial.state, revision);
  const ctx = { width, viewportRows: 40, streaming: { taskId: null, lines: [], active: false } };
  const rows = events.flatMap((event, globalIndex) =>
    eventRows({ event, globalIndex, ctx, expanded: false }),
  );
  return { rows, directory: sessionDir(projectDir, sessionId) };
}

it('shows one tree per compile and keeps the goal, counts and file links of each revision', () => {
  const { rows, directory } = compileHistory(120);
  expect(rows.map(rowText)).toEqual([
    'Plan ready  2 briefs · 1 criterion',
    `Goal     ${first.summary}`,
    'Files    plan.md · tasks.md',
    'Plan changed  1 brief · 2 criteria',
    `Goal     ${revision.summary}`,
    'Files    plan.md · tasks.md',
  ]);
  for (const files of [rows[2], rows[5]]) {
    expect(files?.segments.filter((span) => span.href !== undefined)).toMatchObject(
      ['plan.md', 'tasks.md'].map((text) => ({
        text,
        href: pathToFileURL(join(directory, text)).href,
      })),
    );
  }
});

it('wraps a narrow goal at words and keeps the files on the last branch', () => {
  const { rows } = compileHistory(60);
  const firstTree = rows.slice(
    0,
    rows.findIndex((row) => rowText(row).startsWith('Plan changed')),
  );
  const goalRows = firstTree.slice(1, -1);
  expect(goalRows.length).toBeGreaterThan(1);
  expect(
    goalRows
      .map(rowText)
      .map((text) => text.slice('Goal     '.length))
      .join(' '),
  ).toBe(first.summary);
  expect(goalRows.slice(1).every((row) => rowText(row).startsWith('         '))).toBe(true);
  expect(firstTree.at(-1)).toMatchObject({ kind: 'activity-child-last' });
  for (const row of firstTree) {
    expect(rowLeadingCells(row.kind) + getTerminalCellWidth(rowText(row))).toBeLessThanOrEqual(60);
  }
});
