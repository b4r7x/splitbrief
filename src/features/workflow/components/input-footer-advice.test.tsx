import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { renderFeature } from '#testing/helpers/ink.js';
import { stripAnsiStyles } from '#testing/helpers/ansi.js';
import { makeConfig } from '#testing/helpers/factories/config.js';
import { makePreparedExecution } from '#testing/helpers/factories/prepared-execution.js';
import { makeRunRecord } from '#testing/helpers/factories/run-record.js';
import { makeTask } from '#testing/helpers/factories/task.js';
import { makeWorkflowState } from '#testing/helpers/factories/workflow-state.js';
import { resetAllStores } from '#testing/helpers/stores.js';
import { cleanupTempDir, createTempDir } from '#testing/helpers/temp-dir.js';
import { SESSION_LOG_FILE, sessionDir } from '../../../core/paths.js';
import type { WorkflowMode } from '../../../core/schemas/enums.js';
import { toEngineEventEntry } from '../../../core/sessions/log-writer.js';
import type { EngineEvent } from '../../../engine/events/types.js';
import { adviseMode } from '../../../engine/orchestrator/planning/mode-advisor.js';
import { configStore } from '../../../stores/project/config.js';
import { routerStore } from '../../../stores/navigation/router.js';
import { terminalSizeStore } from '../../../stores/ui/terminal-size.js';
import { addEvent } from '../../../stores/workflow/actions/event.js';
import { loadEvents } from '../../../stores/workflow/actions/load.js';
import { MAX_EVENTS } from '../../../stores/workflow/events.js';
import { hydrateRun } from '../run-history.js';
import { InputFooter } from './input-footer.js';

const SESSION_ID = 'advice-session';
let projectDir = '';

function adviceEvent(prompt: string, mode: WorkflowMode): EngineEvent {
  return { type: 'mode_advice', ts: 1_000, phase: 'researching', ...adviseMode(prompt, mode) };
}

// Enough later entries to push the advice past the log's cap.
function laterEvents(): EngineEvent[] {
  return Array.from({ length: MAX_EVENTS }, (_, index) => ({
    type: 'warning' as const,
    ts: 2_000 + index,
    phase: 'implementing' as const,
    message: `step ${index}`,
  }));
}

function byline(): string {
  const ui = renderFeature(<InputFooter />);
  const frame = stripAnsiStyles(ui.lastFrame() ?? '');
  ui.unmount();
  return frame;
}

function writeLog(events: readonly EngineEvent[]): void {
  const dir = sessionDir(projectDir, SESSION_ID);
  mkdirSync(dir, { recursive: true });
  const lines = events.map((event) => `${JSON.stringify(toEngineEventEntry(event))}\n`).join('');
  writeFileSync(join(dir, SESSION_LOG_FILE), lines);
}

beforeEach(() => {
  resetAllStores();
  projectDir = createTempDir('input-footer-advice');
  configStore.__testReset({ config: makeConfig(), projectDir });
  terminalSizeStore.__testReset({ cols: 160, rows: 24, isSmall: false });
  routerStore.init({
    screen: 'workflow',
    run: makeRunRecord(),
    execution: {
      kind: 'local',
      prepared: makePreparedExecution({
        projectDir,
        sessionId: SESSION_ID,
        feature: 'demo',
        config: makeConfig(),
        gates: () => [],
      }),
    },
  });
});

afterEach(() => {
  resetAllStores();
  cleanupTempDir(projectDir);
});

describe('InputFooter — the advice a run shows', () => {
  it('keeps the advice after the event log has dropped the event that carried it', () => {
    addEvent(adviceEvent('fix typo in footer', 'standard'));
    for (const event of laterEvents()) addEvent(event);

    expect(byline()).toContain('advisor: likely quick');
  });

  it('keeps the advice of a replayed log longer than the cap', () => {
    loadEvents([adviceEvent('fix typo in footer', 'standard'), ...laterEvents()]);

    expect(byline()).toContain('advisor: likely quick');
  });

  it('shows a replayed run the advice its saved inputs earn, not the verdict its log kept', async () => {
    // What an older advisor logged for a context that only names a gallery scenario.
    writeLog([
      { type: 'workflow_started', ts: 1_000, phase: 'researching', feature: 'Trim the fixture' },
      {
        type: 'mode_advice',
        ts: 1_001,
        phase: 'researching',
        kind: 'upgrade',
        risk: 'high',
        currentMode: 'quick',
        suggestedMode: 'speckit',
        confidence: 0.85,
        factors: ['matched: \\bauth(?:n|z|entication|enticate|orize|orization)?\\b'],
        missing: [],
      },
    ]);
    const state = makeWorkflowState({
      phase: 'implementing',
      feature: 'Trim the 140 KB opencode catalog fixture below 50 KB',
      plannerContext: '- render `overlay-picker-auth-config-owned`\n- `npm test` passes',
      mode: 'quick',
      tasks: [makeTask({ files: ['a.json', 'b.ts', 'c.test.ts'] })],
    });

    await hydrateRun(
      makeRunRecord({
        ref: { projectDir, sessionId: SESSION_ID },
        hydration: { kind: 'loaded', state },
      }),
    );

    expect(byline()).not.toContain('advisor:');
  });

  it('advises a replayed run with no saved mode in the mode it continues in', async () => {
    const feature = 'add auth middleware to protect admin routes';
    writeLog([{ type: 'workflow_started', ts: 1_000, phase: 'researching', feature }]);

    await hydrateRun(
      makeRunRecord({
        ref: { projectDir, sessionId: SESSION_ID },
        hydration: { kind: 'loaded', state: makeWorkflowState({ phase: 'planning', feature }) },
      }),
    );

    expect(byline()).toContain('advisor: consider speckit');
  });
});
