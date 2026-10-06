import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { renderFeature, tick } from '#testing/helpers/ink.js';
import { stripAnsiStyles } from '#testing/helpers/ansi.js';
import { makeConfig } from '#testing/helpers/factories/config.js';
import { makeSummary } from '#testing/helpers/factories/summary.js';
import { makeTask } from '#testing/helpers/factories/task.js';
import { createTempDir, cleanupTempDir } from '#testing/helpers/temp-dir.js';
import { resetAllStores } from '#testing/helpers/stores.js';
import type { EvidenceLedger } from '../../../src/core/schemas/evidence.js';
import type { Task } from '../../../src/core/schemas/task.js';
import { createEvidenceLedger } from '../../../src/core/evidence/ledger-state.js';
import { recordFinalReviewEvidence } from '../../../src/engine/orchestrator/evidence/reporting.js';
import { recordLocalTaskEvidence } from '../../../src/engine/orchestrator/evidence/task.js';
import { glyph } from '../../../src/lib/glyphs.js';
import { makeRunRecord } from '#testing/helpers/factories/run-record.js';
import { makeWorkflowState } from '#testing/helpers/factories/workflow-state.js';
import { configStore } from '../../../src/stores/project/config.js';
import { routerStore } from '../../../src/stores/navigation/router.js';
import { terminalSizeStore } from '../../../src/stores/ui/terminal-size.js';
import { WorkflowScreen } from '../../../src/app/screens/workflow.js';

const SESSION_ID = 'summary-evidence-session';

function showClosedRun(opts: {
  summary: ReturnType<typeof makeSummary>;
  ledger: EvidenceLedger | null;
  tasks?: Task[];
}) {
  routerStore.init({
    screen: 'workflow',
    run: makeRunRecord({
      ref: { projectDir: '/tmp/closed-evidence', sessionId: SESSION_ID },
      status: { kind: 'closed', as: 'complete' },
      hydration: {
        kind: 'loaded',
        state: makeWorkflowState({ phase: 'complete', tasks: opts.tasks ?? [] }),
      },
      summary: opts.summary,
      ledger: opts.ledger,
    }),
    execution: { kind: 'at-rest' },
  });
}

describe('closed-run evidence ledger (integration)', () => {
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

  it('turns the ledger carried on the route into brief rows', async () => {
    const task = makeTask({
      id: 'T001',
      title: 'Evidence \u001b]52;c;clipboard-title\u0007detail',
      suggestedFiles: ['src/evidence.ts'],
      tests: ['visible expected \u001b]52;c;clipboard-expected\u0007'],
    });
    let ledger = createEvidenceLedger({
      sessionId: SESSION_ID,
      feature: 'demo',
      tasks: [task],
    });
    ledger = recordLocalTaskEvidence({
      ledger,
      task,
      status: 'done',
      method: 'local',
      validation: [{ passed: true, stage: 'test' }],
    });
    ledger = recordFinalReviewEvidence({
      ledger,
      status: 'written',
      path: 'review\u001b]52;c;clipboard-path\u0007.md',
    });

    terminalSizeStore.__testReset({ cols: 160, rows: 60, isSmall: false });
    showClosedRun({
      ledger,
      tasks: [{ ...task, status: 'done' }],
      summary: makeSummary({
        totalTasks: 1,
        completedByLocal: 1,
        changedFiles: ['src/evidence.ts'],
        evidenceSummary: {
          path: 'evidence\u001b]52;c;clipboard-ledger\u0007.json',
          totalTasks: 1,
          tasksWithValidationEvidence: 1,
          escalatedTasks: 0,
          failedTasks: 0,
        },
      }),
    });

    const ui = renderFeature(<WorkflowScreen commands={[]} onRuntimeCommand={() => {}} />, {
      cols: 160,
      rows: 60,
    });
    await tick();
    const frame = stripAnsiStyles(ui.lastFrame() ?? '');

    expect(frame).toMatch(/^\s*Briefs [─-]/m);
    expect(frame).toContain('T001 Evidence detail');
    expect(frame).toContain('src/evidence.ts');
    expect(frame).toContain(glyph('check'));
    expect(frame).not.toContain('clipboard-title');
    expect(frame).not.toContain('clipboard-ledger');

    ui.unmount();
  });

  it('still names the run when navigation carried no ledger', async () => {
    terminalSizeStore.__testReset({ cols: 160, rows: 60, isSmall: false });
    showClosedRun({
      ledger: null,
      summary: makeSummary({ totalTasks: 1, completedByLocal: 1, feature: 'ledgerless run' }),
    });

    const ui = renderFeature(<WorkflowScreen commands={[]} onRuntimeCommand={() => {}} />, {
      cols: 160,
      rows: 60,
    });
    await tick();
    const frame = stripAnsiStyles(ui.lastFrame() ?? '');

    expect(frame).toContain('ledgerless run');
    expect(frame).toContain(SESSION_ID);

    ui.unmount();
  });
});
