import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createElement } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import YAML from 'yaml';
import { wireAppMouse } from '../../../src/app/mouse.js';
import { App, type AppProps } from '../../../src/app/root.js';
import { canonicalizeProjectDir } from '../../../src/cli/setup.js';
import { SPLITBRIEF_DIR } from '../../../src/core/paths.js';
import { taskId } from '../../../src/core/schemas/task.js';
import { readActive } from '../../../src/core/sessions/active-pointer.js';
import { readRunRecord } from '../../../src/core/sessions/run/record-io.js';
import { saveState } from '../../../src/core/state/persistence.js';
import { buildApplyConflictRecoveryIssue } from '../../../src/engine/orchestrator/recovery/builders/apply.js';
import { saveFinalSession } from '../../../src/engine/orchestrator/session-lifecycle/finalize.js';
import { readConversationScrollSnapshot } from '../../../src/features/workflow/layout/snapshot.js';
import {
  RAIL_SHORT_LABEL,
  railConnectorString,
} from '../../../src/features/workflow/layout/chrome-rows.js';
import { hydrateRun } from '../../../src/features/workflow/run-history.js';
import { glyph } from '../../../src/lib/glyphs.js';
import { routerStore } from '../../../src/stores/navigation/router.js';
import { configStore } from '../../../src/stores/project/config.js';
import { terminalSizeStore } from '../../../src/stores/ui/terminal-size.js';
import { conversationScrollStore } from '../../../src/stores/workflow/conversation-scroll.js';
import { stripAnsiStyles } from '#testing/helpers/ansi.js';
import { makeConfig } from '#testing/helpers/factories/config.js';
import { makeSummary } from '#testing/helpers/factories/summary.js';
import { flushEffects, renderFeature } from '#testing/helpers/ink.js';
import { createMockFilteredStdin, pointerEvent } from '#testing/helpers/mouse-zones.js';
import { resetAllStores } from '#testing/helpers/stores.js';
import { cleanupTempDir } from '#testing/helpers/temp-dir.js';
import { openHaltedRun, settleOpenedRuns } from '../helpers/halted-run-screen.js';
import {
  cli,
  createStopContinueFixture,
  escapingImplementerScript,
  GREET_FILE,
  GREET_SOURCE,
  MARKER_FILE,
  MARKER_SOURCE,
  readState,
  type StopContinueFixture,
} from '../helpers/stop-continue-fixture.js';

let fixture: StopContinueFixture | undefined;

afterEach(() => {
  vi.unstubAllEnvs();
  resetAllStores();
  if (fixture !== undefined) cleanupTempDir(fixture.tmpDir);
  fixture = undefined;
});

const finishingImplementerScript = () => `import { mkdirSync, writeFileSync } from 'node:fs';

for await (const chunk of process.stdin) void chunk;

mkdirSync('src', { recursive: true });
writeFileSync(${JSON.stringify(MARKER_FILE)}, ${JSON.stringify(MARKER_SOURCE)});
writeFileSync(${JSON.stringify(GREET_FILE)}, ${JSON.stringify(GREET_SOURCE)});
`;

const TODAYS_CREW = makeConfig({
  planner: { kind: 'cli', tool: 'cursor' },
  implementer: { kind: 'cli', tool: 'antigravity' },
  reviewer: { kind: 'cli', tool: 'codex' },
});

/** The short-label rail of a run that passed its review and stopped on Apply. */
const SHORT_FAILED_APPLY_RAIL = [
  `${glyph('stageDone')} ${RAIL_SHORT_LABEL.plan}`,
  `${glyph('stageDone')} ${RAIL_SHORT_LABEL.build}`,
  `${glyph('stageDone')} ${RAIL_SHORT_LABEL.review}`,
  `${glyph('statusFailed')} ${RAIL_SHORT_LABEL.apply}`,
].join(railConnectorString());

/** The short-label rail of a finished run whose Apply is the stage it is on. */
const SHORT_PENDING_APPLY_RAIL = [
  `${glyph('stageDone')} ${RAIL_SHORT_LABEL.plan}`,
  `${glyph('stageDone')} ${RAIL_SHORT_LABEL.build}`,
  `${glyph('stageDone')} ${RAIL_SHORT_LABEL.review}`,
  `${glyph('stagePending')} ${RAIL_SHORT_LABEL.apply}`,
].join(railConnectorString());

describe('e2e: the crew strip at a narrow width', () => {
  it('names every seat by its tool on one row at 80 and 60 columns', async () => {
    const created = createStopContinueFixture(escapingImplementerScript, { isolation: 'none' });
    fixture = created;
    const halted = await cli(created, ['start', 'smoke']);
    expect(halted.exitCode, halted.stderr).toBe(1);
    writeFileSync(
      join(created.projectDir, SPLITBRIEF_DIR, 'config.yaml'),
      YAML.stringify(TODAYS_CREW),
      'utf-8',
    );

    const opened = await openHaltedRun(created, { heading: 'Needs you' });
    try {
      for (const { cols, rows } of [
        { cols: 80, rows: 24 },
        { cols: 60, rows: 18 },
      ]) {
        terminalSizeStore.__testReset({ cols, rows, isSmall: true });
        await flushEffects();
        const firstRow = stripAnsiStyles(opened.screen.lastFrame() ?? '').split('\n')[0] ?? '';
        expect(firstRow).toContain('PLAN cursor · BUILD agy · REVIEW codex');
      }
    } finally {
      opened.screen.unmount();
      await settleOpenedRuns();
    }
  }, 150_000);

  it('names every seat of the crew the run saved at 80 and 60 columns', async () => {
    const created = createStopContinueFixture(escapingImplementerScript);
    fixture = created;
    const halted = await cli(created, ['start', 'smoke']);
    expect(halted.exitCode, halted.stderr).toBe(1);
    const sessionId = readActive(created.projectDir);
    if (sessionId === null) throw new Error('The halted run saved no session');
    const ref = { projectDir: created.projectDir, sessionId };
    const saved = readState(created, sessionId);
    const issue = buildApplyConflictRecoveryIssue({
      conflicts: [{ path: 'src/greet.ts', kind: 'text' }],
      workspacePath: saved.workspace?.path ?? created.projectDir,
      createdAt: '2026-10-11T00:00:00.000Z',
    });
    const awaitingApply = {
      ...saved,
      phase: 'complete' as const,
      reviewStatus: 'passed' as const,
      tasks: saved.tasks.map((task) => ({ ...task, status: 'done' as const })),
      pendingRecovery: issue,
    };
    saveState(ref, awaitingApply);
    saveFinalSession({
      projectDir: ref.projectDir,
      sessionId: ref.sessionId,
      feature: awaitingApply.feature,
      startTime: Date.parse(awaitingApply.startedAt) || Date.now(),
      summary: makeSummary({
        feature: awaitingApply.feature,
        plannerTool: 'claude-code',
        plannerModel: 'opus',
        implementerTool: 'claude-code',
        implementerModel: 'haiku',
      }),
      state: awaitingApply,
    });
    writeFileSync(
      join(created.projectDir, SPLITBRIEF_DIR, 'config.yaml'),
      YAML.stringify(TODAYS_CREW),
      'utf-8',
    );

    const opened = await openHaltedRun(created, { heading: 'Needs you' });
    try {
      // The old assertion pinned the long `Apply` label at 80 columns, where the rail now keeps its
      // short labels beside the crew line. At 60 columns the one-stage Form C rail wins and paints
      // the whole word, so the Form B abbreviation `Apl` is not what that width shows.
      for (const { cols, rows, rail } of [
        { cols: 80, rows: 24, rail: SHORT_FAILED_APPLY_RAIL },
        { cols: 60, rows: 18, rail: `${glyph('statusFailed')} Apply` },
      ]) {
        terminalSizeStore.__testReset({ cols, rows, isSmall: true });
        await flushEffects();
        const firstRow = stripAnsiStyles(opened.screen.lastFrame() ?? '').split('\n')[0] ?? '';
        expect(firstRow, `at ${cols}`).toContain(rail);
        expect(firstRow, `at ${cols}`).toContain('PLAN claude · BUILD claude · REVIEW = PLAN');
        expect(firstRow, `at ${cols}`).not.toContain('Plan');
        expect(firstRow, `at ${cols}`).not.toContain('Build');
      }
    } finally {
      opened.screen.unmount();
      await settleOpenedRuns();
    }
  }, 150_000);

  it('keeps the model names beside the one-stage rail at 100 columns when the tool line is longer', async () => {
    const created = createStopContinueFixture(escapingImplementerScript);
    fixture = created;
    const halted = await cli(created, ['start', 'smoke']);
    expect(halted.exitCode, halted.stderr).toBe(1);
    const sessionId = readActive(created.projectDir);
    if (sessionId === null) throw new Error('The halted run saved no session');
    const ref = { projectDir: created.projectDir, sessionId };
    const saved = readState(created, sessionId);
    const issue = buildApplyConflictRecoveryIssue({
      conflicts: [{ path: 'src/greet.ts', kind: 'text' }],
      workspacePath: saved.workspace?.path ?? created.projectDir,
      createdAt: '2026-10-11T00:00:00.000Z',
    });
    const awaitingApply = {
      ...saved,
      phase: 'complete' as const,
      reviewStatus: 'passed' as const,
      tasks: saved.tasks.map((task) => ({ ...task, status: 'done' as const })),
      pendingRecovery: issue,
    };
    saveState(ref, awaitingApply);
    saveFinalSession({
      projectDir: ref.projectDir,
      sessionId: ref.sessionId,
      feature: awaitingApply.feature,
      startTime: Date.parse(awaitingApply.startedAt) || Date.now(),
      summary: makeSummary({
        feature: awaitingApply.feature,
        plannerTool: 'custom-endpoint',
        plannerModel: 'gpt-5.1',
        implementerTool: 'antigravity',
        implementerModel: 'auto',
        reviewerTool: 'custom-endpoint',
        reviewerModel: 'gpt-5-codex',
        taskBreakdown: [
          ...saved.tasks.map((task, index) => ({
            taskId: task.id,
            taskTitle: task.title,
            method: 'local' as const,
            retryCount: 0,
            tool: 'antigravity',
            model: index === 0 ? 'gemini-3.8-flash-high' : 'auto',
          })),
          {
            taskId: taskId('T002'),
            taskTitle: 'Keep the greeting exported',
            method: 'local' as const,
            retryCount: 0,
            tool: 'antigravity',
            model: 'auto',
          },
        ],
      }),
      state: awaitingApply,
    });
    writeFileSync(
      join(created.projectDir, SPLITBRIEF_DIR, 'config.yaml'),
      YAML.stringify(TODAYS_CREW),
      'utf-8',
    );

    const opened = await openHaltedRun(created, { heading: 'Needs you' });
    try {
      terminalSizeStore.__testReset({ cols: 100, rows: 30, isSmall: true });
      await flushEffects();
      const firstRow = stripAnsiStyles(opened.screen.lastFrame() ?? '').split('\n')[0] ?? '';
      expect(firstRow).toContain(`${glyph('statusFailed')} Apply`);
      expect(firstRow).not.toContain('Plan');
      expect(firstRow).not.toContain('Build');
      expect(firstRow).not.toContain('Review');
      expect(firstRow).toContain(
        `PLAN GPT-5.1 · BUILD Gemini 3.8 Flash ${glyph('connectorHandoff')} Google Antigravity CLI · REVIEW GPT-5 Codex`,
      );
    } finally {
      opened.screen.unmount();
      await settleOpenedRuns();
    }
  }, 150_000);

  it('keeps the transcript at its end when the Apply stage of a ready run is clicked at 80 columns', async () => {
    const created = createStopContinueFixture(finishingImplementerScript, {
      isolation: 'worktree',
    });
    fixture = created;
    const finished = await cli(created, ['start', 'smoke']);
    expect(finished.exitCode, finished.stderr).toBe(0);

    vi.stubEnv('XDG_STATE_HOME', created.stateHome);
    const projectDir = await canonicalizeProjectDir({ project: created.projectDir });
    const sessionId = readActive(projectDir);
    if (sessionId === null) throw new Error('The finished run saved no session');
    const ref = { projectDir, sessionId };
    const state = readState(created, sessionId);
    saveFinalSession({
      projectDir,
      sessionId,
      feature: state.feature,
      startTime: Date.parse(state.startedAt) || Date.now(),
      summary: makeSummary({
        feature: state.feature,
        plannerTool: 'claude-code',
        plannerModel: 'opus',
        implementerTool: 'claude-code',
        implementerModel: 'haiku',
      }),
      state,
    });

    const record = readRunRecord(ref, false);
    expect(record.status.kind).toBe('ready-to-apply');
    configStore.load(projectDir);
    terminalSizeStore.__testReset({ cols: 80, rows: 24, isSmall: true });
    await hydrateRun(record);
    routerStore.init({ screen: 'workflow', run: record, execution: { kind: 'at-rest' } });
    const mouse = createMockFilteredStdin();
    const disposeMouse = wireAppMouse(mouse.filtered);
    const screen = renderFeature(createElement<AppProps>(App, {}), { cols: 80, rows: 24 });
    try {
      await vi.waitFor(() => expect(stripAnsiStyles(screen.lastFrame())).toContain('Show diff'));
      await flushEffects();

      const before = stripAnsiStyles(screen.lastFrame());
      const firstRow = before.split('\n')[0] ?? '';
      expect(firstRow).toContain(SHORT_PENDING_APPLY_RAIL);
      expect(firstRow).toContain('PLAN claude · BUILD claude · REVIEW = PLAN');
      expect(readConversationScrollSnapshot().maxOffset).toBeGreaterThan(0);

      // The click goes to the short label the rail paints; the old assertion read the long `Apply`.
      mouse.emit(pointerEvent('press', firstRow.indexOf(RAIL_SHORT_LABEL.apply) + 1, 1));
      await flushEffects();

      expect(conversationScrollStore.get().scrollOffset).toBe(0);
      expect(stripAnsiStyles(screen.lastFrame())).toBe(before);
    } finally {
      disposeMouse();
      screen.unmount();
    }
  }, 150_000);
});
