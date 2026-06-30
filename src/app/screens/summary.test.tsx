import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { renderFeature, tick } from '#testing/helpers/ink.js';
import { stripAnsiStyles } from '#testing/helpers/ansi.js';
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
import { glyph } from '../../lib/glyphs.js';
import { configStore } from '../../stores/project/config.js';
import { routerStore } from '../../stores/navigation/router.js';
import { terminalSizeStore } from '../../stores/ui/terminal-size.js';
import { overlayStore } from '../../stores/ui/overlay.js';
import { SummaryScreen } from './summary.js';

const ESC = String.fromCharCode(27);
const BEL = String.fromCharCode(7);

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

function visibleTaskIds(frame: string): string[] {
  return frame.split('\n').flatMap((line) => line.match(/\bT\d{3}\b/g) ?? []);
}

function maxLineLength(frame: string): number {
  return stripAnsiStyles(frame)
    .split('\n')
    .reduce((max, line) => Math.max(max, line.length), 0);
}

describe('SummaryScreen', () => {
  beforeEach(() => {
    resetAllStores();
  });

  afterEach(() => {
    resetAllStores();
  });

  it('renders the persisted mode from the summary in the route byline', () => {
    terminalSizeStore.__testReset({ cols: 160, rows: 40, isSmall: false });
    showSummaryRoute({ summary: makeSummary({ mode: 'standard' }) });

    const ui = renderFeature(<SummaryScreen commands={[]} onRuntimeCommand={() => {}} />);
    const frame = ui.lastFrame() ?? '';

    expect(frame).toContain('standard');
    expect(frame).not.toContain('Mode');

    ui.unmount();
  });

  it('does not label old summaries with the current live config mode', () => {
    terminalSizeStore.__testReset({ cols: 160, rows: 40, isSmall: false });
    configStore.__testReset({ config: makeConfig({ workflow: { mode: 'quick' } }) });
    showSummaryRoute({ summary: makeSummary() });

    const ui = renderFeature(<SummaryScreen commands={[]} onRuntimeCommand={() => {}} />);
    const frame = ui.lastFrame() ?? '';

    expect(frame).not.toContain('Mode');
    expect(frame).not.toContain('quick');

    ui.unmount();
  });

  it('folds the brief and task counts into a single progress fraction', () => {
    terminalSizeStore.__testReset({ cols: 160, rows: 40, isSmall: false });
    showSummaryRoute({
      summary: makeSummary({ totalTasks: 5, completedByLocal: 4, escalatedToPlanner: 1 }),
    });

    const ui = renderFeature(<SummaryScreen commands={[]} onRuntimeCommand={() => {}} />);
    const frame = ui.lastFrame() ?? '';

    expect(frame).toContain('5/5 tasks');
    expect(frame).toContain('4 local');
    expect(frame).not.toContain('Planner compiled');
    expect(frame).not.toContain('Implementer completed');
    expect(frame).not.toMatch(/[█░]/);

    ui.unmount();
  });

  it('labels complete summaries as complete', () => {
    showSummaryRoute({ summary: makeSummary(), status: 'complete' });

    const ui = renderFeature(<SummaryScreen commands={[]} onRuntimeCommand={() => {}} />);
    const frame = stripAnsiStyles(ui.lastFrame() ?? '');

    expect(frame).toContain('diptych complete');

    ui.unmount();
  });

  it('does not label failed summaries as complete', () => {
    showSummaryRoute({ summary: makeSummary(), status: 'failed' });

    const ui = renderFeature(<SummaryScreen commands={[]} onRuntimeCommand={() => {}} />);
    const frame = stripAnsiStyles(ui.lastFrame() ?? '');

    expect(frame).toContain('diptych failed');
    expect(frame).not.toContain('with summary');
    expect(frame).not.toContain('diptych complete');

    ui.unmount();
  });

  it('does not label interrupted summaries as complete', () => {
    showSummaryRoute({ summary: makeSummary(), status: 'interrupted' });

    const ui = renderFeature(<SummaryScreen commands={[]} onRuntimeCommand={() => {}} />);
    const frame = stripAnsiStyles(ui.lastFrame() ?? '');

    expect(frame).toContain('diptych interrupted');
    expect(frame).not.toContain('with summary');
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

    expect(frame).toContain('drift');
    expect(frame).toContain('1 warning');

    ui.unmount();
  });

  it('renders a quiet zero-task summary instead of a fake progress and no-savings banner', () => {
    showSummaryRoute({
      summary: makeSummary({
        totalTasks: 0,
        completedByLocal: 0,
        escalatedToPlanner: 0,
        costBreakdown: {
          hypotheticalCost: 0,
          actualPlannerCost: 0,
          actualImplementerCost: 0,
          totalActualCost: 0,
          savingsAmount: 0,
          savingsPercentage: 0,
          localCompletionRate: 0,
          hasPricedUsage: true,
          hasSavingsEstimate: true,
          isActualPlannerCostKnown: true,
          isActualImplementerCostKnown: true,
          isTotalActualCostKnown: true,
          isAllPlannerBaselineKnown: true,
        },
      }),
      status: 'failed',
    });

    const ui = renderFeature(<SummaryScreen commands={[]} onRuntimeCommand={() => {}} />);
    const frame = ui.lastFrame() ?? '';

    expect(frame).toContain('no task briefs compiled');
    expect(frame).not.toContain('0/0');
    expect(frame).not.toContain('No savings this run');

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

    expect(frame).toContain('checkpoints');
    expect(frame).toContain('2 checkpoints');
    expect(frame).toContain('snap-pre-final');
    expect(frame).toContain('diptych snapshot diff snap-post-1');
    expect(frame).toContain('review packet');
    expect(frame).toContain('.diptych/sessions/summary-session/review-packet.md');
    expect(frame).toContain('final review: written');
    expect(frame).toContain('evidence: 2/2');

    ui.unmount();
  });

  it('loads the evidence ledger at the screen boundary and renders task evidence', async () => {
    const projectDir = mkdtempSync(join(tmpdir(), 'summary-screen-evidence-'));
    const sessionId = 'summary-evidence-session';
    try {
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
      writeEvidenceLedger(projectDir, sessionId, ledger);

      terminalSizeStore.__testReset({ cols: 160, rows: 80, isSmall: false });
      configStore.__testReset({ projectDir });
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

      expect(frame).toContain('evidence');
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
          path: 'evidence\u001b]52;c;clipboard-compact-ledger\u0007.json',
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
    expect(frame).toContain('evidence.json');
    expect(frame).not.toContain('clipboard-compact-ledger');
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
    expect(frame).toContain(`Codex ${glyph('connectorHandoff')} Codex`);
    const continueCount = frame.split('press enter to continue').length - 1;
    expect(continueCount).toBe(1);
    expect(maxLineLength(frame)).toBeLessThanOrEqual(48);

    ui.unmount();
  });

  it('reveals review packet content with paging at 160x24', async () => {
    terminalSizeStore.__testReset({ cols: 160, rows: 24, isSmall: false });
    const PAGE_DOWN = '\u001b[6~';
    const END = '\u001b[F';
    showSummaryRoute({
      sessionId: 'scroll-summary',
      summary: makeSummary({
        costBreakdown: {
          hypotheticalCost: 1,
          actualPlannerCost: 0.2,
          actualImplementerCost: 0.3,
          totalActualCost: 0.5,
          savingsAmount: 0.5,
          savingsPercentage: 50,
          localCompletionRate: 1,
          hasPricedUsage: true,
          hasSavingsEstimate: true,
          isActualPlannerCostKnown: true,
          isActualImplementerCostKnown: true,
          isTotalActualCostKnown: true,
          isAllPlannerBaselineKnown: true,
        },
        checkpointSummary: {
          count: 1,
          latestId: 'snap-1',
          latestName: 'post-task',
          latestKind: 'post-task',
          latestRunCheckpointId: 'snap-1',
          preFinalReviewId: null,
          accepted: null,
          rejected: null,
          diffCommand: null,
          restoreCommand: null,
        },
        reviewPacket: {
          markdownPath: 'review-packet.md',
          jsonPath: 'review-packet.json',
          generatedAt: '2026-04-28T10:00:00.000Z',
          finalReviewStatus: 'written',
          driftPassed: true,
          evidenceValidatedTasks: 1,
          evidenceTotalTasks: 1,
          missingArtifactCount: 0,
        },
      }),
    });

    const ui = renderFeature(<SummaryScreen commands={[]} onRuntimeCommand={() => {}} />);
    await tick(20);

    const frames: string[] = [];
    for (let page = 0; page < 20; page++) {
      frames.push(ui.lastFrame() ?? '');
      ui.stdin.write(PAGE_DOWN);
      await tick(20);
    }
    ui.stdin.write(END);
    await tick(20);
    frames.push(ui.lastFrame() ?? '');

    expect(frames.some((frame) => frame.includes('review packet'))).toBe(true);
    expect(frames.some((frame) => frame.includes('review-packet.md'))).toBe(true);

    ui.unmount();
  });

  it('pages through single-line task rows without skipping task ids at 160x24', async () => {
    terminalSizeStore.__testReset({ cols: 160, rows: 24, isSmall: false });
    const PAGE_DOWN = '\u001b[6~';
    const HOME = '\u001b[H';
    const END = '\u001b[F';
    const taskBreakdown = Array.from({ length: 20 }, (_, i) => {
      const id = `T${String(i + 1).padStart(3, '0')}`;
      return {
        taskId: taskId(id),
        taskTitle: `Task ${id}`,
        method: 'local' as const,
        implementerTokens: 10,
        escalationTokens: 0,
        retryCount: 0,
      };
    });
    showSummaryRoute({
      summary: makeSummary({
        estimatedCostSavings: 'unavailable',
        taskBreakdown,
      }),
    });

    const ui = renderFeature(<SummaryScreen commands={[]} onRuntimeCommand={() => {}} />);
    await tick(20);

    ui.stdin.write(HOME);
    await tick(20);
    expect(visibleTaskIds(ui.lastFrame() ?? '')).toContain('T001');

    const seen = new Set<string>();
    for (let page = 0; page < 25; page++) {
      for (const id of visibleTaskIds(ui.lastFrame() ?? '')) {
        seen.add(id);
      }
      ui.stdin.write(PAGE_DOWN);
      await tick(20);
    }

    ui.stdin.write(END);
    await tick(20);
    for (const id of visibleTaskIds(ui.lastFrame() ?? '')) {
      seen.add(id);
    }
    expect(seen).toEqual(
      new Set(Array.from({ length: 20 }, (_, i) => `T${String(i + 1).padStart(3, '0')}`)),
    );

    ui.unmount();
  });

  it('renders negative persisted savings without success-colored zero savings copy', () => {
    terminalSizeStore.__testReset({ cols: 160, rows: 40, isSmall: false });
    showSummaryRoute({
      summary: makeSummary({
        costBreakdown: {
          hypotheticalCost: 0.1,
          actualPlannerCost: 0.05,
          actualImplementerCost: 0.1,
          totalActualCost: 0.15,
          savingsAmount: -0.05,
          savingsPercentage: -50,
          localCompletionRate: 0.5,
          hasPricedUsage: true,
          hasSavingsEstimate: true,
          isActualPlannerCostKnown: true,
          isActualImplementerCostKnown: true,
          isTotalActualCostKnown: true,
          isAllPlannerBaselineKnown: true,
        },
      }),
    });

    const ui = renderFeature(<SummaryScreen commands={[]} onRuntimeCommand={() => {}} />);
    const frame = ui.lastFrame() ?? '';

    expect(frame).toContain('extra cost');
    expect(frame).not.toContain('saved $0.00 (-50%)');
    expect((frame.match(/◆/g) ?? []).length).toBe(1);

    ui.unmount();
  });

  it('strips terminal-control bytes from persisted feature and model fields before render', () => {
    terminalSizeStore.__testReset({ cols: 160, rows: 40, isSmall: false });
    showSummaryRoute({
      summary: makeSummary({
        feature: `Ship ${ESC}]52;c;clip-feature${BEL}dashboard${ESC}[31m`,
        plannerTool: 'codex',
        plannerModel: `gpt${ESC}]52;c;clip-planner${BEL}-5`,
        implementerTool: 'ollama',
        implementerModel: `qwen${ESC}]52;c;clip-impl${BEL}-small`,
      }),
    });

    const ui = renderFeature(<SummaryScreen commands={[]} onRuntimeCommand={() => {}} />);
    const frame = ui.lastFrame() ?? '';

    expect(frame).toContain('Ship');
    expect(frame).toContain('dashboard');
    expect(frame).not.toContain('clip-feature');
    expect(frame).not.toContain('clip-planner');
    expect(frame).not.toContain('clip-impl');
    expect(frame).not.toContain('52;c');

    ui.unmount();
  });
});
