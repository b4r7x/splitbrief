import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { renderFeature, tick } from '#testing/helpers/ink.js';
import { makeConfig } from '#testing/helpers/factories/config.js';
import { makeSummary } from '#testing/helpers/factories/summary.js';
import { makeTask } from '#testing/helpers/factories/task.js';
import type { Session } from '../../core/schemas/session.js';
import type { CostBreakdown, Summary } from '../../core/schemas/summary.js';
import { taskId } from '../../core/schemas/task.js';
import { resetAllStores } from '#testing/helpers/stores.js';
import { createEvidenceLedger } from '../../core/evidence/ledger.js';
import { writeEvidenceLedger } from '../../core/evidence/ledger.js';
import { recordFinalReviewEvidence } from '../../engine/orchestrator/evidence/reporting.js';
import { recordLocalTaskEvidence } from '../../engine/orchestrator/evidence/task.js';
import { configStore } from '../../stores/project/config.js';
import { routerStore } from '../../stores/navigation/router.js';
import { terminalSizeStore } from '../../stores/ui/terminal-size.js';
import { overlayStore } from '../../stores/ui/overlay.js';
import { SummaryScreen } from './screen.js';

function showSummaryRoute(opts: {
  summary: Summary;
  sessionId?: string | undefined;
  status?: Session['status'] | undefined;
}) {
  routerStore.init({
    screen: 'summary',
    summary: opts.summary,
    sessionId: opts.sessionId,
    status: opts.status ?? 'complete',
  });
}

function maxLineLength(frame: string): number {
  return frame.split('\n').reduce((max, line) => Math.max(max, line.length), 0);
}

describe('SummaryScreen', () => {
  beforeEach(() => {
    resetAllStores();
  });

  afterEach(() => {
    resetAllStores();
  });

  it('renders the persisted mode from the summary', () => {
    showSummaryRoute({ summary: makeSummary({ mode: 'standard' }) });

    const ui = renderFeature(<SummaryScreen commands={[]} onRuntimeCommand={() => {}} />);
    const frame = ui.lastFrame() ?? '';

    expect(frame).toContain('Mode');
    expect(frame).toContain('standard');

    ui.unmount();
  });

  it('does not label old summaries with the current live config mode', () => {
    configStore.__testReset({ config: makeConfig({ workflow: { mode: 'quick' } }) });
    showSummaryRoute({ summary: makeSummary() });

    const ui = renderFeature(<SummaryScreen commands={[]} onRuntimeCommand={() => {}} />);
    const frame = ui.lastFrame() ?? '';

    expect(frame).not.toContain('Mode');
    expect(frame).not.toContain('quick');

    ui.unmount();
  });

  it('uses task compiler language in the summary header', () => {
    showSummaryRoute({
      summary: makeSummary({ totalTasks: 5, completedByLocal: 4, escalatedToPlanner: 1 }),
    });

    const ui = renderFeature(<SummaryScreen commands={[]} onRuntimeCommand={() => {}} />);
    const frame = ui.lastFrame() ?? '';

    expect(frame).toContain('Task Brief');
    expect(frame).toContain('Implementer completed');
    expect(frame).toContain('locally');

    ui.unmount();
  });

  it('labels complete summaries as complete', () => {
    showSummaryRoute({ summary: makeSummary(), status: 'complete' });

    const ui = renderFeature(<SummaryScreen commands={[]} onRuntimeCommand={() => {}} />);
    const frame = ui.lastFrame() ?? '';

    expect(frame).toContain('diptych complete');

    ui.unmount();
  });

  it('does not label failed summaries as complete', () => {
    showSummaryRoute({ summary: makeSummary(), status: 'failed' });

    const ui = renderFeature(<SummaryScreen commands={[]} onRuntimeCommand={() => {}} />);
    const frame = ui.lastFrame() ?? '';

    expect(frame).toContain('diptych failed with summary');
    expect(frame).not.toContain('diptych complete');

    ui.unmount();
  });

  it('does not label interrupted summaries as complete', () => {
    showSummaryRoute({ summary: makeSummary(), status: 'interrupted' });

    const ui = renderFeature(<SummaryScreen commands={[]} onRuntimeCommand={() => {}} />);
    const frame = ui.lastFrame() ?? '';

    expect(frame).toContain('diptych interrupted with summary');
    expect(frame).not.toContain('diptych complete');

    ui.unmount();
  });

  it('labels mixed-profile implementer runs without implying one global implementer', () => {
    showSummaryRoute({
      sessionId: 'summary-session',
      summary: makeSummary({
        implementerTool: 'ollama',
        implementerModel: 'qwen-small',
        taskBreakdown: [
          {
            taskId: taskId('T001'),
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
            taskId: taskId('T002'),
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

    const ui = renderFeature(<SummaryScreen commands={[]} onRuntimeCommand={() => {}} />);
    const frame = ui.lastFrame() ?? '';

    expect(frame).toContain('mixed profiles');
    expect(frame).toContain('cheap-cloud');
    expect(frame).toContain('local-qwen');

    ui.unmount();
  });

  it('renders "quality n/a" when no briefQuality present', () => {
    showSummaryRoute({ summary: makeSummary() });

    const ui = renderFeature(<SummaryScreen commands={[]} onRuntimeCommand={() => {}} />);
    const frame = ui.lastFrame() ?? '';

    expect(frame).toContain('quality n/a');

    ui.unmount();
  });

  it('renders brief quality score when briefQuality is present', () => {
    showSummaryRoute({
      summary: makeSummary({
        briefQuality: { score: 0.8, passed: true, errorCount: 0, warningCount: 2 },
      }),
    });

    const ui = renderFeature(<SummaryScreen commands={[]} onRuntimeCommand={() => {}} />);
    const frame = ui.lastFrame() ?? '';

    expect(frame).toContain('quality 0.80');
    expect(frame).toContain('2 warnings');

    ui.unmount();
  });

  it('renders drift warning count when driftSummary is present', () => {
    showSummaryRoute({
      summary: makeSummary({
        driftSummary: { passed: false, score: 0.84, errorCount: 0, warningCount: 1 },
      }),
    });

    const ui = renderFeature(<SummaryScreen commands={[]} onRuntimeCommand={() => {}} />);
    const frame = ui.lastFrame() ?? '';

    expect(frame).toContain('Drift');
    expect(frame).toContain('1 warning');

    ui.unmount();
  });

  it('renders checkpoint and review packet rollups from the summary', () => {
    terminalSizeStore.__testReset({ cols: 160, rows: 60, isSmall: false });
    showSummaryRoute({
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

    const ui = renderFeature(<SummaryScreen commands={[]} onRuntimeCommand={() => {}} />);
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
      ledger = recordFinalReviewEvidence({ ledger, status: 'written' });
      writeEvidenceLedger(projectDir, sessionId, ledger);

      terminalSizeStore.__testReset({ cols: 160, rows: 80, isSmall: false });
      configStore.__testReset({ projectDir });
      showSummaryRoute({
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

      const ui = renderFeature(<SummaryScreen commands={[]} onRuntimeCommand={() => {}} />);
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

  it('renders the evidence rollup when the routed session id cannot read a ledger', async () => {
    const projectDir = mkdtempSync(join(tmpdir(), 'summary-screen-invalid-ledger-'));
    try {
      terminalSizeStore.__testReset({ cols: 160, rows: 80, isSmall: false });
      configStore.__testReset({ projectDir });
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

      expect(frame).toContain('Evidence');
      expect(frame).toContain('0/1 validated');

      ui.unmount();
    } finally {
      rmSync(projectDir, { recursive: true, force: true });
    }
  });

  it('keeps checkpoint and packet details readable on narrow terminals', () => {
    terminalSizeStore.__testReset({ cols: 48, rows: 60, isSmall: true });
    const longName = `post-task-${'very-long-name-'.repeat(8)}`;
    showSummaryRoute({
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

    const ui = renderFeature(<SummaryScreen commands={[]} onRuntimeCommand={() => {}} />);
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

  it('keeps lower summary sections visible on a short narrow terminal', () => {
    terminalSizeStore.__testReset({ cols: 48, rows: 28, isSmall: true });
    showSummaryRoute({
      sessionId: 'short-summary-session',
      summary: makeSummary({
        feature: 'short terminal lower sections must stay visible',
        plannerTool: 'codex',
        implementerTool: 'codex',
        mode: 'standard',
        evidenceSummary: {
          path: 'evidence.json',
          totalTasks: 3,
          tasksWithValidationEvidence: 2,
          escalatedTasks: 1,
          failedTasks: 0,
        },
        checkpointSummary: {
          count: 4,
          latestId: 'snap-post-final',
          latestName: 'post-final',
          latestKind: 'post-task',
          latestRunCheckpointId: 'snap-post-final',
          preFinalReviewId: 'snap-pre-final',
          accepted: true,
          rejected: false,
          diffCommand: 'diptych snapshot diff snap-post-final',
          restoreCommand: 'diptych snapshot restore snap-post-final',
        },
        reviewPacket: {
          markdownPath: 'review-packet.md',
          jsonPath: 'review-packet.json',
          generatedAt: '2026-04-28T10:00:00.000Z',
          finalReviewStatus: 'written',
          driftPassed: true,
          evidenceValidatedTasks: 2,
          evidenceTotalTasks: 3,
          missingArtifactCount: 0,
        },
      }),
    });

    const ui = renderFeature(<SummaryScreen commands={[]} onRuntimeCommand={() => {}} />);
    const frame = ui.lastFrame() ?? '';
    const lines = frame.split('\n');

    expect(frame).toContain('Evidence:');
    expect(frame).toContain('Checkpoints:');
    expect(frame).toContain('Review packet:');
    expect(frame).toContain('md: review-packet.md');
    expect(frame).toContain('json: review-packet.json');
    expect(frame).toContain('final review: written');
    const mdLine = lines.find((line) => line.includes('md:')) ?? '';
    expect(mdLine).not.toContain('json:');
    expect(maxLineLength(frame)).toBeLessThanOrEqual(48);

    ui.unmount();
  });

  it('does not render "full" mode label anywhere', () => {
    showSummaryRoute({ summary: makeSummary({ mode: 'standard' }) });

    const ui = renderFeature(<SummaryScreen commands={[]} onRuntimeCommand={() => {}} />);
    const frame = ui.lastFrame() ?? '';

    expect(frame).not.toContain('full');

    ui.unmount();
  });

  it('exits to home when Enter is pressed on the empty composer', async () => {
    showSummaryRoute({ summary: makeSummary() });

    const ui = renderFeature(<SummaryScreen commands={[]} onRuntimeCommand={() => {}} />);
    ui.stdin.write('\r');
    await tick(20);

    expect(routerStore.get().screen).toBe('home');

    ui.unmount();
  });

  it('ignores Enter on the composer while an overlay is open', async () => {
    showSummaryRoute({ summary: makeSummary() });
    overlayStore.open('command-palette');

    const ui = renderFeature(<SummaryScreen commands={[]} onRuntimeCommand={() => {}} />);
    ui.stdin.write('\r');
    await tick(20);

    expect(routerStore.get().screen).toBe('summary');

    ui.unmount();
  });

  it('keeps a compact branded summary readable on a narrow terminal', () => {
    terminalSizeStore.__testReset({ cols: 48, rows: 28, isSmall: true });
    const costBreakdown: CostBreakdown = {
      hypotheticalCost: 5,
      actualPlannerCost: 1,
      actualImplementerCost: 0.5,
      totalActualCost: 1.5,
      savingsAmount: 3.5,
      savingsPercentage: 70,
      localCompletionRate: 0.75,
      hasPricedUsage: true,
      hasSavingsEstimate: true,
      isActualPlannerCostKnown: true,
      isActualImplementerCostKnown: true,
      isTotalActualCostKnown: true,
      isAllPlannerBaselineKnown: true,
    };
    showSummaryRoute({
      summary: makeSummary({
        feature: 'a narrow summary with enough text to overflow if the screen is not bounded',
        plannerTool: 'codex',
        implementerTool: 'codex',
        mode: 'instant',
        totalTasks: 2,
        completedByLocal: 1,
        escalatedToPlanner: 1,
        costBreakdown,
        taskBreakdown: [
          {
            taskId: taskId('T001'),
            taskTitle: 'long task title that must not break the frame',
            method: 'local',
            implementerTokens: 10,
            escalationTokens: 0,
            retryCount: 0,
          },
          {
            taskId: taskId('T002'),
            taskTitle: 'another long task title that must stay bounded',
            method: 'escalated-full',
            implementerTokens: 10,
            escalationTokens: 20,
            retryCount: 1,
          },
        ],
      }),
      status: 'failed',
    });

    const ui = renderFeature(<SummaryScreen commands={[]} onRuntimeCommand={() => {}} />);
    const frame = ui.lastFrame() ?? '';

    expect(frame).toContain('diptych');
    expect(frame).toContain('failed');
    expect(frame).toContain('Codex -> Codex');
    const continueCount = frame.split('press enter to continue').length - 1;
    expect(continueCount).toBe(1);
    expect(maxLineLength(frame)).toBeLessThanOrEqual(48);

    ui.unmount();
  });
});
