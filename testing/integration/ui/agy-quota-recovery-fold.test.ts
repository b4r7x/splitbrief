import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { taskId } from '../../../src/core/schemas/task.js';
import { groupEventsIntoSections } from '../../../src/core/sections/group.js';
import type { EngineEvent } from '../../../src/engine/events/types.js';
import { publishRunnerCallEvent } from '../../../src/engine/orchestrator/publish/runner.js';
import { createCliPlanner } from '../../../src/engine/planners/cli.js';
import { buildConversationRowsProjection } from '../../../src/features/workflow/conversation-rows/build.js';
import { materializeConversationRowsWindow } from '../../../src/features/workflow/conversation-rows/materialize-window.js';
import { buildConversationRowActions } from '../../../src/features/workflow/conversation-rows/row-actions/build.js';
import { rowText } from '../../../src/features/workflow/conversation-rows/row-format/rows.js';
import { shellQuoteArg } from '../../../src/utils/shell-quote.js';
import { trustedShimGate, writeFakeCli } from '#testing/helpers/command-shim.js';
import {
  AGY_QUOTA_MODEL as MODEL,
  AGY_QUOTA_WORDS as QUOTA_WORDS,
  haltAndSwitch,
} from '#testing/helpers/events/agy-quota.js';
import { makeConfig } from '#testing/helpers/factories/config.js';
import { createTestGitRepo } from '#testing/helpers/git.js';
import { forceUnicodeGlyphs } from '#testing/helpers/glyphs.js';
import { makeBusRecorder } from '#testing/helpers/orchestrator-factories.js';
import { admittedCliSeat } from '#testing/helpers/runner-gate.js';
import { cleanupTempDir, createTempDir } from '#testing/helpers/temp-dir.js';

const CONVERSATION = '0f4ac269-acaf-439b-b86e-844d3e91e99a';

/** What agy prints on stdout when a consult turn stops on its quota, then it exits 3. */
const AGY_QUOTA_STOP = [
  { event: 'init', conversation_id: CONVERSATION, init: { cwd: '<project>' } },
  {
    event: 'step_update',
    step_update: {
      conversation_id: CONVERSATION,
      step_index: 0,
      state: 'DONE',
      step_type: 'user_input',
    },
  },
  {
    event: 'step_update',
    step_update: {
      conversation_id: CONVERSATION,
      step_index: 1,
      state: 'DONE',
      step_type: 'error_message',
      error_message: {
        error_id: 'd7bcf3b5-ecdd-44a7-a3cf-b9e4b44d835f-1',
        message: QUOTA_WORDS,
        short_error: `RESOURCE_EXHAUSTED (code 429): ${QUOTA_WORDS}`,
      },
    },
  },
  {
    event: 'result',
    result: { conversation_id: CONVERSATION, status: 'ERROR', error: QUOTA_WORDS },
  },
].map((record) => JSON.stringify(record));

function project(events: EngineEvent[], expandedDiffs = new Set<string>()) {
  const inputs = {
    sections: groupEventsIntoSections(events),
    cols: 200,
    viewportHeight: 60,
    expandedDiffs,
    expandedActivityBatches: new Set<string>(),
    streaming: { taskId: null, lines: [], active: false },
  };
  const projection = buildConversationRowsProjection(inputs);
  const rows = materializeConversationRowsWindow({
    projection,
    windowStart: 0,
    windowEnd: projection.totalRows,
  });
  return { rows, actions: buildConversationRowActions(inputs) };
}

let projectDir: string;
let shimDir: string;

beforeEach(() => {
  forceUnicodeGlyphs();
  projectDir = createTempDir('agy-quota-fold-project');
  createTestGitRepo(projectDir);
  shimDir = createTempDir('agy-quota-fold-shim');
});

afterEach(() => {
  cleanupTempDir(projectDir);
  cleanupTempDir(shimDir);
});

describe('the Recovery fold of an Antigravity quota stop on a consult', () => {
  it('lists the quota words and no parser line, folded and expanded', async () => {
    writeFakeCli(
      shimDir,
      'agy',
      [
        'cat >/dev/null',
        ...AGY_QUOTA_STOP.map((line) => `printf '%s\\n' ${shellQuoteArg(line)}`),
        'exit 3',
        '',
      ].join('\n'),
    );
    const planner = createCliPlanner({
      config: makeConfig({ planner: { kind: 'cli', tool: 'antigravity', model: MODEL } }),
      cliSeat: admittedCliSeat(trustedShimGate({ dir: shimDir, tool: 'antigravity' })),
    });
    const { bus, events } = makeBusRecorder();

    const result = await planner
      .typedCall({
        projectDir,
        seat: 'planner',
        callbacks: {
          onOutput: () => {},
          onCallEvent: (event) =>
            publishRunnerCallEvent(
              { bus, phase: 'escalating', rootDir: projectDir, taskId: taskId('T006') },
              event,
            ),
        },
      })
      .invoke({
        prompt: '# Consult on a failing task\n\nT006 failed its check.',
        schema: { json: { type: 'object' }, name: 'consult_answer' },
      });
    expect(result).toMatchObject({
      status: 'failed',
      error: { code: 'antigravity-result-failed', message: QUOTA_WORDS },
    });

    const transcript = [...events, ...haltAndSwitch(Date.now() + 1_000)];
    const { rows, actions } = project(transcript);
    const folded = rows.map(rowText).join('\n').replace(/\s+/gu, ' ');
    expect(folded).toContain('Recovery Usage limit on Google Antigravity CLI');
    expect(folded).toContain('continued on fallback');
    expect(folded).not.toContain('Unknown Antigravity step');

    const recoveryRow = rows.find((row) => rowText(row).startsWith('Recovery  '));
    const action = recoveryRow === undefined ? undefined : actions.get(recoveryRow.key);
    if (action?.type !== 'toggle-diff') throw new Error('Expected the Recovery detail toggle');
    const detail = project(transcript, new Set([action.key]))
      .rows.map(rowText)
      .join('\n')
      .replace(/\s+/gu, ' ');
    expect(detail).toContain(QUOTA_WORDS);
    expect(detail).not.toContain('Unknown Antigravity step');
  });
});
