import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { ensureSessionDir } from '../../../src/core/paths-io.js';
import { groupEventsIntoSections } from '../../../src/core/sections/event-sections.js';
import { createInitialState } from '../../../src/core/state/machine.js';
import { readRunEvents } from '../../../src/engine/events/replay.js';
import { createJsonlSink } from '../../../src/engine/events/sinks/jsonl.js';
import { createApiPlanner } from '../../../src/engine/planners/api.js';
import { runPlanningPhase } from '../../../src/engine/orchestrator/planning/run.js';
import { rowText } from '../../../src/features/workflow/conversation-rows/row-format/rows.js';
import { createCassetteReplayer, loadCassette } from '#testing/helpers/cassette/replayer.js';
import { buildConversationRows } from '#testing/helpers/event-rows.js';
import { resetAllStores } from '#testing/helpers/stores.js';
import {
  makeBusRecorder,
  makeCallbacks,
  TEST_METADATA,
  TEST_SINKS,
} from '#testing/helpers/orchestrator-factories.js';
import { withTempDir } from '#testing/helpers/temp-dir.js';
import { makeE2eScenarioConfig } from '../helpers/config.js';

it('shows a repaired plan passing its checks after one send-back, including after replay', async () => {
  const config = makeE2eScenarioConfig({
    codebase: { enabled: false, tokenBudget: 4000 },
    workflow: { approve: 'none' },
  });
  const replayer = createCassetteReplayer(
    loadCassette(join(import.meta.dirname, '../cassettes/plan-send-back.json')),
  );
  resetAllStores();
  replayer.install();
  try {
    await withTempDir('e2e-plan-send-back', async (projectDir) => {
      const sessionId = 'plan-send-back';
      const ref = { projectDir, sessionId };
      ensureSessionDir(projectDir, sessionId);
      writeFileSync(join(projectDir, 'README'), '# SPLITBRIEF\n\nA small fixture project.\n');
      const { bus, events: liveEvents } = makeBusRecorder();
      bus.subscribe(createJsonlSink(ref));
      const feature = 'fix typo in README';
      const result = await runPlanningPhase({
        wctx: {
          ...ref,
          config,
          bus,
          callbacks: makeCallbacks().callbacks,
          metadata: TEST_METADATA,
          sinks: TEST_SINKS,
        },
        state: createInitialState(feature),
        feature,
        planner: createApiPlanner(config),
      });
      replayer.assertReplayComplete();
      expect(
        result.disposition,
        JSON.stringify(
          liveEvents.filter((event) => event.type === 'error' || event.type === 'warning'),
        ),
      ).toBe('ready-for-tasks');
      expect(result.state.tasks[0]?.checks).toHaveLength(1);
      expect(
        liveEvents.filter(
          (event) => event.type === 'runner_call_started' && event.phase === 'planning',
        ),
      ).toHaveLength(2);
      expect(
        liveEvents.filter((event) => event.type === 'warning' && event.planCheck !== undefined),
      ).toEqual([
        expect.objectContaining({
          planCheck: expect.objectContaining({ code: 'task-without-check' }),
        }),
      ]);

      const { events } = await readRunEvents(ref);
      for (const transcriptEvents of [liveEvents, events]) {
        expect(transcriptEvents.filter((event) => event.type === 'info')).toEqual([
          expect.objectContaining({ message: 'The revised plan passes its checks.' }),
        ]);
        const { rows } = buildConversationRows({
          sections: groupEventsIntoSections(transcriptEvents),
          expandedDiffs: new Set(),
          expandedActivityBatches: new Set(),
          cols: 120,
          viewportHeight: 100,
          streaming: { taskId: null, lines: [], active: false },
        });
        const text = rows.map(rowText).join('\n');
        const pass = 'The revised plan passes its checks.';
        expect(text.split(pass)).toHaveLength(2);
        expect(text).toContain(`SPLITBRIEF  ${pass}`);
        expect(text.indexOf('goes back to the planner once.')).toBeGreaterThanOrEqual(0);
        expect(text.indexOf(pass)).toBeGreaterThan(text.indexOf('goes back to the planner once.'));
      }
    });
  } finally {
    replayer.uninstall();
    resetAllStores();
  }
});
