import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import { forceUnicodeGlyphs } from '#testing/helpers/glyphs.js';
import { renderFeature } from '#testing/helpers/ink.js';
import { stripAnsiStyles } from '#testing/helpers/ansi.js';
import { resetAllStores } from '#testing/helpers/stores.js';
import { makeConfig } from '#testing/helpers/factories/config.js';
import { makeTask } from '#testing/helpers/factories/task.js';
import { cleanupTempDir, createTempDir } from '#testing/helpers/temp-dir.js';
import { formatTasks } from '../../../engine/spec/formatter.js';
import { STATE_FILE, TASKS_FILE } from '../../../core/paths.js';
import { createInitialState } from '../../../core/state/machine.js';
import { createBriefRecoveryState } from '../../../engine/orchestrator/planning/brief-recovery.js';
import type { BriefRecoveryProjectionV1 } from '../../../core/schemas/brief-recovery/document.js';
import { getTerminalCellWidth } from '../../../utils/display-text.js';
import { glyph } from '../../../lib/glyphs.js';
import type { UseInputModeResult } from '../hooks/use-input-mode.js';
import { getWorkflowContentWidth, getWorkflowSidebarWidth } from '../layout/rect.js';
import { WorkflowBody } from './body.js';
import { reviewStore } from '../../../stores/workflow/review.js';
import { configStore } from '../../../stores/project/config.js';
import { terminalSizeStore } from '../../../stores/ui/terminal-size.js';
import { ReviewView } from './review-view.js';

type WholeScreenRecoveryStatus = Extract<
  BriefRecoveryProjectionV1['status'],
  'checking' | 'blocked' | 'retrying' | 'unresolved' | 'ready' | 'readiness-blocked'
>;

const WHOLE_SCREEN_WIDTHS = [121, 120, 119, 80, 50, 40] as const;

const wholeScreenBrief = { revision: 1, hash: 'b'.repeat(64), path: TASKS_FILE };
const wholeScreenReport = {
  revision: 1,
  hash: 'r'.repeat(64),
  path: 'brief-quality.json',
};

const WHOLE_SCREEN_OUTCOME: Record<WholeScreenRecoveryStatus, string> = {
  checking: 'CHECKING CONTRACT',
  blocked: 'CONTRACT BLOCKED',
  retrying: 'RETRYING',
  unresolved: 'RETRY UNRESOLVED',
  ready: 'CONTRACT READY',
  'readiness-blocked': 'READINESS BLOCKED',
};

const WHOLE_SCREEN_EPOCH = 'epoch-1';
const WHOLE_SCREEN_OPERATION = 'operation-1';

function wholeScreenAttempt(sessionId: string) {
  return {
    epochId: WHOLE_SCREEN_EPOCH,
    operationId: WHOLE_SCREEN_OPERATION,
    intentHash: wholeScreenBrief.hash,
    kind: 'manual-retry' as const,
    acceptedAt: '2026-01-01T00:00:00.000Z',
    baseBrief: wholeScreenBrief,
    baseReport: null,
    frozenInputIds: [],
    reservation: {
      accountingKey: {
        sessionId,
        epochId: WHOLE_SCREEN_EPOCH,
        operationId: WHOLE_SCREEN_OPERATION,
        generation: 0,
      },
      amount: 0,
      state: 'reserved' as const,
      usageApplied: false,
      appliedUsage: null,
      history: [],
    },
    status: 'accepted' as const,
    dispatchPossibility: 'none' as const,
    automaticAllowanceConsumed: false,
  };
}

function writeWholeScreenState(sessionDir: string, status: WholeScreenRecoveryStatus): void {
  const sessionId = basename(sessionDir);
  const recovery = createBriefRecoveryState(
    {
      sessionId,
      origin: { mode: 'standard', entry: 'initial' },
      continuation: { version: 1, kind: 'approval', mode: 'standard', entry: 'initial' },
      activeBrief: wholeScreenBrief,
      report: {
        briefHash: wholeScreenBrief.hash,
        report: wholeScreenReport,
        ruleVersion: 'brief-quality-v1',
        issues: [],
        errorCount: 0,
      },
      qualityPolicyVersion: 'brief-quality-v1',
    },
    { epochId: WHOLE_SCREEN_EPOCH, recoveryRevision: 1 },
  );
  const state = {
    ...createInitialState('whole-screen fixture'),
    stateRevision: 1,
    stateFence: { token: 1, ownerId: 'review-view-test' },
    phase: 'reviewing-briefs' as const,
    briefRecovery:
      status === 'retrying'
        ? {
            ...recovery,
            status,
            attempts: { [WHOLE_SCREEN_OPERATION]: wholeScreenAttempt(sessionId) },
            activeOperationId: WHOLE_SCREEN_OPERATION,
          }
        : { ...recovery, status },
  };
  writeFileSync(join(sessionDir, STATE_FILE), JSON.stringify(state), 'utf8');
}

function reviewInputMode(): UseInputModeResult {
  return {
    mode: 'review',
    hint: '',
    questionEpoch: 0,
    setReviewMode: vi.fn(),
    setQuestionMode: vi.fn(),
    resolve: vi.fn(),
    resetMode: vi.fn(),
  };
}

function rightPaneBottomRow(frame: string, startColumn: number): number {
  const rows = stripAnsiStyles(frame)
    .split('\n')
    .flatMap((line, row) => {
      const corner = line[startColumn];
      return (corner === '+' || corner === '└') && /[-─]{2,}/u.test(line.slice(startColumn))
        ? [row]
        : [];
    });
  return rows.length > 0 ? (rows[rows.length - 1] ?? -1) : -1;
}

describe('ReviewView', () => {
  let tmp: string;
  let ui: ReturnType<typeof renderFeature> | null;

  beforeEach(() => {
    forceUnicodeGlyphs();
    resetAllStores();
    tmp = createTempDir('review-view');
    ui = null;
  });

  afterEach(() => {
    ui?.unmount();
    cleanupTempDir(tmp);
  });

  function openReviewFile(name: string, content: string) {
    const file = join(tmp, name);
    writeFileSync(file, content);
    reviewStore.setReviewFile(file);
    return file;
  }

  function codeBlock(lines: readonly string[]): string {
    return ['```txt', ...lines, '```'].join('\n');
  }

  it('renders the shared ↓ N more indicator', async () => {
    const file = join(tmp, 'very-long-directory-name', 'nested-specification-file.md');
    mkdirSync(join(tmp, 'very-long-directory-name'));
    writeFileSync(
      file,
      [
        'This paragraph mentions src/features/workflow/components/review-view.tsx and keeps going long enough to wrap across several terminal rows and then continues with many more words so the rendered output clearly overflows the available content height and forces a scroll footer to appear.',
      ].join('\n'),
    );
    reviewStore.setReviewFile(file);

    ui = renderFeature(<ReviewView height={8} width={24} />);

    await vi.waitFor(() => {
      expect(reviewStore.get().renderedLineCount).toBeGreaterThan(1);
      expect(ui?.lastFrame()).toContain('↓');
      expect(ui?.lastFrame()).toContain('more');
    });

    const frame = ui.lastFrame() ?? '';
    expect(frame.split('\n').length).toBeLessThanOrEqual(8);
  });

  it('clamps an oversized review offset to the rendered document window', async () => {
    openReviewFile(
      'clamp.md',
      codeBlock(['line-0', 'line-1', 'line-2', 'line-3', 'line-4', 'line-5', 'line-6']),
    );

    ui = renderFeature(<ReviewView height={10} width={40} />);

    await vi.waitFor(() => {
      expect(reviewStore.get().renderedLineCount).toBe(9);
    });
    reviewStore.setScrollOffset(999);

    await vi.waitFor(() => {
      expect(reviewStore.get().scrollOffset).toBe(5);
      const frame = ui?.lastFrame() ?? '';
      expect(frame).toContain('line-4');
      expect(frame).toContain('line-6');
      expect(frame).toContain('End of file');
      expect(frame).not.toContain('more');
    });
  });

  it('clips a multi-line row at the review offset and folds scroll affordance into one footer', async () => {
    openReviewFile('partial-row.md', codeBlock(['line-0', 'line-1', 'line-2', 'line-3', 'line-4']));

    ui = renderFeature(<ReviewView height={8} width={36} />);

    await vi.waitFor(() => {
      expect(reviewStore.get().renderedLineCount).toBe(7);
    });
    reviewStore.setScrollOffset(2);

    await vi.waitFor(() => {
      const frame = ui?.lastFrame() ?? '';
      expect(frame).not.toContain('↑ 1 more');
      expect(frame).not.toContain('↓ 1 more');
      expect(frame).toContain('more');
      expect(frame).not.toContain('line-0');
      expect(frame).toContain('line-1');
      expect(frame).toContain('line-2');
      expect(frame).not.toContain('line-3');
    });
  });

  it('spans the full content width as a bordered card', async () => {
    openReviewFile(
      'wide.md',
      [
        '# Wide Review',
        'This line should render across the full review column instead of a narrow capped column.',
      ].join('\n'),
    );

    ui = renderFeature(<ReviewView height={10} width={180} />);

    await vi.waitFor(() => {
      const frame = ui?.lastFrame() ?? '';
      expect(frame).toContain('Wide Review');
      const rule = glyph('divider', 'unicode');
      const interiorRuleLine =
        frame
          .split('\n')
          .find(
            (line) => (stripAnsiStyles(line).match(new RegExp(rule, 'g')) ?? []).length === 176,
          ) ?? '';
      expect(interiorRuleLine).not.toBe('');
      expect(stripAnsiStyles(interiorRuleLine)).toContain(rule.repeat(176));
      expect(stripAnsiStyles(interiorRuleLine)).not.toContain(rule.repeat(177));
    });
  });

  it('renders a custom planner artifact from its in-memory text without a path title', async () => {
    const reviewedText = '# Finalized artifact\n\nThis exact text was approved.';
    reviewStore.setReviewArtifact(reviewedText);

    ui = renderFeature(<ReviewView height={10} width={80} />);

    await vi.waitFor(() => {
      const frame = stripAnsiStyles(ui?.lastFrame() ?? '');
      expect(frame).toContain('Custom planner artifact');
      expect(frame).toContain('Finalized artifact');
      expect(frame).toContain('This exact text was approved.');
    });

    const frame = stripAnsiStyles(ui.lastFrame() ?? '');
    expect(frame).not.toContain('.custom-runner-review');
    expect(reviewStore.get()).toMatchObject({
      source: { kind: 'artifact', text: reviewedText },
      filePath: null,
    });
  });

  it('redacts review markdown display without changing the raw file', async () => {
    const rawToken = 'abcdefghijklmnopqrstuvwxyz1234567890abcdef';
    const file = openReviewFile(
      'secret-plan.md',
      [
        '# Plan\u001b[31m Review\u001b[0m',
        `Use TOKEN=${rawToken}`,
        '```sh',
        `curl -H "Authorization: Bearer ${rawToken}"`,
        '```',
      ].join('\n'),
    );

    ui = renderFeature(<ReviewView height={10} width={80} />);

    await vi.waitFor(() => {
      const frame = stripAnsiStyles(ui?.lastFrame() ?? '');
      expect(frame).toContain('Plan Review');
      expect(frame).toContain('TOKEN=REDACTED');
      expect(frame).toContain('Authorization: Bearer ***REDACTED***');
    });

    const frame = stripAnsiStyles(ui.lastFrame() ?? '');
    expect(frame).not.toContain(rawToken);
    expect(frame).not.toContain('\u001b');
    expect(readFileSync(file, 'utf-8')).toContain(rawToken);
  });

  it('fits wide-character file paths and strips controls from review markdown', async () => {
    const dir = join(tmp, '界語', 'deep');
    mkdirSync(dir, { recursive: true });
    const file = join(dir, 'emoji-👩‍💻-e\u0301.md');
    writeFileSync(
      file,
      [
        '# Safe\u001b[31m heading\u001b[0m',
        'visible \u001b]52;c;clipboard\u0007done \u009b2Ktail',
      ].join('\n'),
    );
    reviewStore.setReviewFile(file);

    ui = renderFeature(<ReviewView height={8} width={24} />);

    await vi.waitFor(() => {
      const frame = stripAnsiStyles(ui?.lastFrame() ?? '');
      expect(frame).toContain('👩‍💻-e\u0301.md');
      expect(frame).toContain('Safe heading');
      expect(frame).toContain('visible done tail');
    });

    const frame = stripAnsiStyles(ui.lastFrame() ?? '');
    expect(frame).not.toContain('clipboard');
    expect(frame).not.toContain('\u001b');
    expect(frame).not.toContain('\u009b');
    expect(frame).not.toContain('\u0007');
    expect(frame.split('\n').every((line) => getTerminalCellWidth(line) <= 24)).toBe(true);
  });

  it.each(['checking', 'blocked', 'retrying', 'unresolved', 'ready', 'readiness-blocked'] as const)(
    'keeps the whole workflow body bounded for %s at every recovery width',
    async (status) => {
      const file = join(tmp, TASKS_FILE);
      configStore.__testReset({ config: makeConfig(), projectDir: tmp });
      writeFileSync(
        file,
        formatTasks([makeTask({ id: 'T001', title: 'whole-screen task' })]),
        'utf8',
      );

      writeWholeScreenState(tmp, status);

      try {
        for (const cols of WHOLE_SCREEN_WIDTHS) {
          const contentHeight = 16;
          terminalSizeStore.__testReset({ cols, rows: 24 });
          const sidebarWidth = getWorkflowSidebarWidth({ cols, sidebarVisible: true });
          const showSidebar = sidebarWidth > 0;
          const contentWidth = getWorkflowContentWidth({ cols, sidebarVisible: true });
          const rendered = renderFeature(
            <WorkflowBody
              showSidebar={showSidebar}
              sidebarWidth={sidebarWidth}
              inputMode={reviewInputMode()}
              reviewFilePath={file}
              phase="reviewing-briefs"
              contentHeight={contentHeight}
              contentWidth={contentWidth}
            />,
            { cols, rows: 24 },
          );

          await vi.waitFor(() => {
            expect(stripAnsiStyles(rendered.lastFrame() ?? '')).toContain(
              WHOLE_SCREEN_OUTCOME[status],
            );
          });

          const frame = stripAnsiStyles(rendered.lastFrame() ?? '');
          const lines = frame.split('\n');
          expect(lines.length).toBeLessThanOrEqual(contentHeight);
          expect(lines.every((line) => getTerminalCellWidth(line) <= cols)).toBe(true);
          if (showSidebar) {
            expect(frame).toContain('No tasks yet');
            expect(rightPaneBottomRow(frame, sidebarWidth + 2)).toBe(contentHeight - 1);
          } else {
            expect(frame).not.toContain('No tasks yet');
            expect(rightPaneBottomRow(frame, 0)).toBe(contentHeight - 1);
          }
          rendered.unmount();
        }
      } finally {
        configStore.__testReset();
      }
    },
  );
});
