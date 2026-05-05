import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { renderFeature, tick } from '../../../testing/helpers/ink.js';
import { makeConfig } from '../../../testing/helpers/factories/config.js';
import { makeSummary } from '../../../testing/helpers/factories/summary.js';
import { makeTask } from '../../../testing/helpers/factories/task.js';
import { resetAllStores } from '../../../testing/helpers/stores.js';
import { createEvidenceLedger } from '../../engine/orchestrator/evidence/ledger.js';
import { writeEvidenceLedger } from '../../engine/orchestrator/evidence/persistence.js';
import { recordFinalReviewEvidence } from '../../engine/orchestrator/evidence/reporting.js';
import { recordLocalTaskEvidence } from '../../engine/orchestrator/evidence/task-evidence.js';
import { configStore } from '../../stores/project/config.js';
import { routerStore } from '../../stores/navigation/router.js';
import { terminalSizeStore } from '../../stores/ui/terminal-size.js';
import { SummaryScreen } from './screen.js';

describe('SummaryScreen', () => {
  beforeEach(() => {
    resetAllStores();
  });

  afterEach(() => {
    resetAllStores();
  });

  it('renders the persisted mode from the summary', () => {
    routerStore.init({ screen: 'summary', summary: makeSummary({ mode: 'standard' }) });

    const ui = renderFeature(<SummaryScreen commands={[]} onSlashCommand={() => {}} />);
    const frame = ui.lastFrame() ?? '';

    expect(frame).toContain('Mode');
    expect(frame).toContain('standard');

    ui.unmount();
  });

  it('does not label old summaries with the current live config mode', () => {
    configStore.__testReset({ config: makeConfig({ workflow: { mode: 'quick' } }) });
    routerStore.init({ screen: 'summary', summary: makeSummary() });

    const ui = renderFeature(<SummaryScreen commands={[]} onSlashCommand={() => {}} />);
    const frame = ui.lastFrame() ?? '';

    expect(frame).not.toContain('Mode');
    expect(frame).not.toContain('quick');

    ui.unmount();
  });

  it('uses task compiler language in the summary header', () => {
    routerStore.init({ screen: 'summary', summary: makeSummary({ totalTasks: 5, completedByLocal: 4, escalatedToPlanner: 1 }) });

    const ui = renderFeature(<SummaryScreen commands={[]} onSlashCommand={() => {}} />);
    const frame = ui.lastFrame() ?? '';

    expect(frame).toContain('Task Brief');
    expect(frame).toContain('Implementer completed');
    expect(frame).toContain('locally');

    ui.unmount();
  });

  it('labels mixed-profile implementer runs without implying one global implementer', () => {
    routerStore.init({
      screen: 'summary',
      sessionId: 'summary-session',
      summary: makeSummary({
        implementerTool: 'ollama',
        implementerModel: 'qwen-small',
        taskBreakdown: [
          {
            taskId: 'T001' as never,
            taskTitle: 'Local task',
            method: 'local',
            implementerTokens: 100,
            escalationTokens: 0,
            retryCount: 0,
            tool: 'ollama',
            model: 'qwen-small',
            implementerProfile: 'local-qwen',
          },
          {
            taskId: 'T002' as never,
            taskTitle: 'Cloud task',
            method: 'local',
            implementerTokens: 100,
            escalationTokens: 0,
            retryCount: 0,
            tool: 'openrouter',
            model: 'deepseek',
            implementerProfile: 'cheap-cloud',
          },
        ],
      }),
    });

    const ui = renderFeature(<SummaryScreen commands={[]} onSlashCommand={() => {}} />);
    const frame = ui.lastFrame() ?? '';

    expect(frame).toContain('mixed profiles');
    expect(frame).toContain('cheap-cloud');
    expect(frame).toContain('local-qwen');

    ui.unmount();
  });

  it('renders "quality n/a" when no briefQuality present', () => {
    routerStore.init({ screen: 'summary', summary: makeSummary() });

    const ui = renderFeature(<SummaryScreen commands={[]} onSlashCommand={() => {}} />);
    const frame = ui.lastFrame() ?? '';

    expect(frame).toContain('quality n/a');

    ui.unmount();
  });

  it('renders brief quality score when briefQuality is present', () => {
    routerStore.init({ screen: 'summary', summary: makeSummary({ briefQuality: { score: 0.8, passed: true, errorCount: 0, warningCount: 2 } }) });

    const ui = renderFeature(<SummaryScreen commands={[]} onSlashCommand={() => {}} />);
    const frame = ui.lastFrame() ?? '';

    expect(frame).toContain('quality 0.80');
    expect(frame).toContain('2 warnings');

    ui.unmount();
  });

  it('renders drift warning count when driftSummary is present', () => {
    routerStore.init({ screen: 'summary', summary: makeSummary({ driftSummary: { passed: false, score: 0.84, errorCount: 0, warningCount: 1 } }) });

    const ui = renderFeature(<SummaryScreen commands={[]} onSlashCommand={() => {}} />);
    const frame = ui.lastFrame() ?? '';

    expect(frame).toContain('Drift');
    expect(frame).toContain('1 warning');

    ui.unmount();
  });

  it('renders checkpoint and review packet rollups from the summary', () => {
    terminalSizeStore.__testReset({ cols: 160, rows: 60, isSmall: false });
    routerStore.init({
      screen: 'summary',
      sessionId: 'summary-session',
      summary: makeSummary({
        checkpointSummary: {
          count: 2,
          latestId: 'snap-post-1',
          latestName: 'post-task-1',
          latestKind: 'post-task',
          latestRunCheckpointId: 'snap-post-1',
          preFinalReviewId: 'snap-pre-final',
          accepted: true,
          rejected: false,
          diffCommand: 'diptych snapshot diff snap-post-1',
          restoreCommand: 'diptych snapshot restore snap-post-1',
        },
        reviewPacket: {
          markdownPath: 'review-packet.md',
          jsonPath: 'review-packet.json',
          generatedAt: '2026-04-28T10:00:00.000Z',
          finalReviewStatus: 'written',
          driftPassed: true,
          evidenceValidatedTasks: 2,
          evidenceTotalTasks: 2,
          missingArtifactCount: 0,
        },
      }),
    });

    const ui = renderFeature(<SummaryScreen commands={[]} onSlashCommand={() => {}} />);
    const frame = ui.lastFrame() ?? '';

    expect(frame).toContain('Checkpoints');
    expect(frame).toContain('2 checkpoints');
    expect(frame).toContain('snap-pre-final');
    expect(frame).toContain('diptych snapshot diff snap-post-1');
    expect(frame).toContain('Review packet');
    expect(frame).toContain('.diptych/sessions/summary-session/review-packet.md');
    expect(frame).toContain('final review: written');
    expect(frame).toContain('evidence: 2/2');

    ui.unmount();
  });

  it('loads the evidence ledger at the screen boundary and renders task evidence', async () => {
    const projectDir = mkdtempSync(join(tmpdir(), 'summary-screen-evidence-'));
    const sessionId = 'summary-evidence-session';
    try {
      const task = makeTask({ id: 'T001', title: 'Evidence detail', file: 'src/evidence.ts' });
      let ledger = createEvidenceLedger({ sessionId, feature: 'demo', mode: 'standard', tasks: [task] });
      ledger = recordLocalTaskEvidence({
        ledger,
        task,
        status: 'done',
        method: 'local',
        validation: [{ passed: true, stage: 'test' }],
      });
      ledger = recordFinalReviewEvidence({ ledger, status: 'written' });
      writeEvidenceLedger(projectDir, sessionId, ledger);

      terminalSizeStore.__testReset({ cols: 160, rows: 80, isSmall: false });
      configStore.__testReset({ projectDir });
      routerStore.init({
        screen: 'summary',
        sessionId,
        summary: makeSummary({
          evidenceSummary: {
            path: 'evidence.json',
            totalTasks: 1,
            tasksWithValidationEvidence: 1,
            escalatedTasks: 0,
            failedTasks: 0,
          },
        }),
      });

      const ui = renderFeature(<SummaryScreen commands={[]} onSlashCommand={() => {}} />);
      await tick();
      const frame = ui.lastFrame() ?? '';

      expect(frame).toContain('Evidence');
      expect(frame).toContain('1/1 validated');
      expect(frame).toContain('T001');
      expect(frame).toContain('Evidence detail');
      expect(frame).toContain('passed: test');
      expect(frame).toContain('task reached done');
      expect(frame).toContain('final review: written');

      ui.unmount();
    } finally {
      rmSync(projectDir, { recursive: true, force: true });
    }
  });

  it('keeps checkpoint and packet details readable on narrow terminals', () => {
    terminalSizeStore.__testReset({ cols: 48, rows: 60, isSmall: true });
    const longName = `post-task-${'very-long-name-'.repeat(8)}`;
    routerStore.init({
      screen: 'summary',
      sessionId: 'small-summary-session',
      summary: makeSummary({
        checkpointSummary: {
          count: 12,
          latestId: 'snap-post-very-long-id',
          latestName: longName,
          latestKind: 'post-task',
          latestRunCheckpointId: 'snap-post-very-long-id',
          preFinalReviewId: 'snap-pre-final',
          accepted: null,
          rejected: null,
          diffCommand: 'diptych snapshot diff snap-post-very-long-id',
          restoreCommand: 'diptych snapshot restore snap-post-very-long-id',
        },
        reviewPacket: {
          markdownPath: 'review-packet.md',
          jsonPath: 'review-packet.json',
          generatedAt: '2026-04-28T10:00:00.000Z',
          finalReviewStatus: 'failed',
          driftPassed: false,
          evidenceValidatedTasks: 1,
          evidenceTotalTasks: 3,
          missingArtifactCount: 2,
        },
      }),
    });

    const ui = renderFeature(<SummaryScreen commands={[]} onSlashCommand={() => {}} />);
    const frame = ui.lastFrame() ?? '';

    expect(frame).toContain('12 ckpts');
    expect(frame).toContain('latest: snap-post-very-long-id');
    expect(frame).toContain('pre: snap-pre-final');
    expect(frame).not.toContain(longName);
    expect(frame).toContain('review-packet.md');
    expect(frame).toContain('review-packet.json');
    expect(frame).toContain('final review: failed');
    expect(frame).toContain('missing: 2');

    ui.unmount();
  });

  it('does not render "full" mode label anywhere', () => {
    routerStore.init({ screen: 'summary', summary: makeSummary({ mode: 'standard' }) });

    const ui = renderFeature(<SummaryScreen commands={[]} onSlashCommand={() => {}} />);
    const frame = ui.lastFrame() ?? '';

    expect(frame).not.toContain('full');

    ui.unmount();
  });
});
