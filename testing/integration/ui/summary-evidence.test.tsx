import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { renderFeature, tick } from '#testing/helpers/ink.js';
import { makeConfig } from '#testing/helpers/factories/config.js';
import { makeSummary } from '#testing/helpers/factories/summary.js';
import { makeTask } from '#testing/helpers/factories/task.js';
import { createTempDir, cleanupTempDir } from '#testing/helpers/temp-dir.js';
import { resetAllStores } from '#testing/helpers/stores.js';
import { createEvidenceLedger } from '../../../src/core/evidence/ledger-state.js';
import { writeEvidenceLedger } from '../../../src/core/evidence/ledger-storage.js';
import { recordFinalReviewEvidence } from '../../../src/engine/orchestrator/evidence/reporting.js';
import { recordLocalTaskEvidence } from '../../../src/engine/orchestrator/evidence/task.js';
import { glyph } from '../../../src/lib/glyphs.js';
import { configStore } from '../../../src/stores/project/config.js';
import { routerStore } from '../../../src/stores/navigation/router.js';
import { terminalSizeStore } from '../../../src/stores/ui/terminal-size.js';
import { SummaryScreen } from '../../../src/app/screens/summary.js';

function showSummaryRoute(opts: {
  summary: ReturnType<typeof makeSummary>;
  sessionId?: string | undefined;
}) {
  routerStore.init({
    screen: 'summary',
    summary: opts.summary,
    sessionId: opts.sessionId,
    status: 'complete',
  });
}

describe('SummaryScreen evidence ledger (integration)', () => {
  let projectDir = '';

  beforeEach(() => {
    resetAllStores();
    projectDir = createTempDir('summary-evidence');
    configStore.__testReset({ config: makeConfig(), projectDir });
  });

  afterEach(() => {
    resetAllStores();
    cleanupTempDir(projectDir);
    projectDir = '';
  });

  it('loads the evidence ledger at the screen boundary and renders task evidence', async () => {
    const sessionId = 'summary-evidence-session';
    const task = makeTask({
      id: 'T001',
      title: 'Evidence \u001b]52;c;clipboard-title\u0007detail',
      file: 'src/evidence.ts',
      tests: ['visible expected \u001b]52;c;clipboard-expected\u0007'],
    });
    let ledger = createEvidenceLedger({
      sessionId,
      feature: 'demo',
      mode: 'standard',
      tasks: [task],
    });
    ledger = recordLocalTaskEvidence({
      ledger,
      task,
      status: 'done',
      method: 'local',
      validation: [{ passed: true, stage: 'test' }],
    });
    ledger = {
      ...ledger,
      tasks: ledger.tasks.map((entry) =>
        entry.id === task.id
          ? {
              ...entry,
              observedEvidence: [
                'observed visible \u001b]52;c;clipboard-observed\u0007',
                ...entry.observedEvidence,
              ],
            }
          : entry,
      ),
    };
    ledger = recordFinalReviewEvidence({
      ledger,
      status: 'written',
      path: 'review\u001b]52;c;clipboard-path\u0007.md',
    });
    writeEvidenceLedger({ projectDir, sessionId }, ledger);

    terminalSizeStore.__testReset({ cols: 160, rows: 80, isSmall: false });
    showSummaryRoute({
      sessionId,
      summary: makeSummary({
        evidenceSummary: {
          path: 'evidence\u001b]52;c;clipboard-ledger\u0007.json',
          totalTasks: 1,
          tasksWithValidationEvidence: 1,
          escalatedTasks: 0,
          failedTasks: 0,
        },
      }),
    });

    const ui = renderFeature(<SummaryScreen commands={[]} onRuntimeCommand={() => {}} />);
    await tick();
    const frame = ui.lastFrame() ?? '';

    expect(frame).toContain('evidence');
    expect(frame).toContain('1/1 validated');
    expect(frame).toContain('T001');
    expect(frame).toContain('Evidence detail');
    expect(frame).toContain(glyph('check'));
    expect(frame).toContain(glyph('treeLast'));
    expect(frame).toContain('visible expected');
    expect(frame).toContain('observed visible');
    expect(frame).toContain('review.md');
    expect(frame).toContain('passed test');
    expect(frame).toContain('final review: written');
    expect(frame).not.toContain('clipboard-title');
    expect(frame).not.toContain('clipboard-expected');
    expect(frame).not.toContain('clipboard-observed');
    expect(frame).not.toContain('clipboard-path');
    expect(frame).not.toContain('clipboard-ledger');

    ui.unmount();
  });

  it('renders the evidence rollup when the routed session id cannot read a ledger', async () => {
    terminalSizeStore.__testReset({ cols: 160, rows: 80, isSmall: false });
    showSummaryRoute({
      sessionId: '../outside',
      summary: makeSummary({
        evidenceSummary: {
          path: 'evidence.json',
          totalTasks: 1,
          tasksWithValidationEvidence: 0,
          escalatedTasks: 0,
          failedTasks: 0,
        },
      }),
    });

    const ui = renderFeature(<SummaryScreen commands={[]} onRuntimeCommand={() => {}} />);
    await tick();
    const frame = ui.lastFrame() ?? '';

    expect(frame).toContain('evidence');
    expect(frame).toContain('0/1 validated');

    ui.unmount();
  });
});
