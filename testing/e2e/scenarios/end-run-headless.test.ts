import { existsSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { createElement } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { WorkflowScreen } from '../../../src/app/screens/workflow.js';
import { loadConfig, writeConfig } from '../../../src/core/config/load/io.js';
import { sessionDir } from '../../../src/core/paths.js';
import { readSession } from '../../../src/core/sessions/io.js';
import { groupEventsIntoSections } from '../../../src/core/sections/event-sections.js';
import { readRunRecord } from '../../../src/core/sessions/run-record-io.js';
import { deriveRunStatus } from '../../../src/core/sessions/run-status.js';
import { WORKSPACE_KEPT_CODE } from '../../../src/core/sessions/workspace-notice.js';
import type { SessionRef } from '../../../src/core/types/session-ref.js';
import { readRunEvents } from '../../../src/engine/events/replay.js';
import type { EngineEvent } from '../../../src/engine/events/types.js';
import { briefRowParts, crewLine, filesRows } from '../../../src/features/workflow/closed/copy.js';
import { deriveSummaryView } from '../../../src/features/workflow/closed/view-model.js';
import { walkTranscript } from '../../../src/features/workflow/conversation-rows/transcript-walk.js';
import { rowText } from '../../../src/features/workflow/conversation-rows/row-format/rows.js';
import { hydrateRun } from '../../../src/features/workflow/run-history.js';
import { rereadRunAtRest } from '../../../src/features/workflow/handlers.js';
import { showRunDiff } from '../../../src/features/workflow/result/show-diff.js';
import type { SpawnEditor } from '../../../src/features/workflow/review-parser.js';
import { routerStore } from '../../../src/stores/navigation/router.js';
import { configStore } from '../../../src/stores/project/config.js';
import { overlayStore } from '../../../src/stores/ui/overlay.js';
import { feedbackStore } from '../../../src/stores/ui/feedback.js';
import { terminalSizeStore } from '../../../src/stores/ui/terminal-size.js';
import { stopStore } from '../../../src/stores/workflow/stop.js';
import { eventsStore } from '../../../src/stores/workflow/events.js';
import { flushEffects, renderFeature } from '#testing/helpers/ink.js';
import { stripAnsiStyles } from '#testing/helpers/ansi.js';
import { resetAllStores } from '#testing/helpers/stores.js';
import { buildConversationRows } from '#testing/helpers/event-rows.js';
import { checkoutEntries } from '#testing/helpers/checkout.js';
import { cleanupTempDir } from '#testing/helpers/temp-dir.js';
import {
  cli,
  continueRun,
  createStopContinueFixture,
  endImplementerHold,
  MARKER_FILE,
  readState,
  startAndSignal,
  type StopContinueFixture,
} from '../helpers/stop-continue-fixture.js';

let fixture: StopContinueFixture | undefined;

/** The warning codes and row-less closes of a run's log, and of the transcript it renders. */
async function workspaceNotices(ref: SessionRef) {
  const events = (await readRunEvents(ref)).events;
  const shown = [...walkTranscript(groupEventsIntoSections(events))].flatMap((step) =>
    step.kind === 'event' ? [step.event] : [],
  );
  const notices = (list: readonly EngineEvent[]) =>
    list.flatMap((event) =>
      event.type === 'warning'
        ? [event.code]
        : event.type === 'workspace_closed'
          ? [event.type]
          : [],
    );
  return { logged: notices(events), shown: notices(shown) };
}

/** Saves another BUILD model, as a Settings save while the run waits does. */
function saveAnotherBuildModel(target: StopContinueFixture): void {
  const config = loadConfig(target.projectDir).config;
  if (config.implementer.kind !== 'agent') throw new Error('the fixture BUILD seat is an agent');
  writeConfig(target.projectDir, {
    ...config,
    implementer: { ...config.implementer, model: 'swapped' },
  });
}

/** The closed record names the BUILD model the run used, not the one saved after it. */
function expectRecordedBuildSeat(ref: SessionRef): void {
  expect(readSession(ref)?.summary?.implementerModel).toBe('fixture');
  const view = deriveSummaryView({ record: readRunRecord(ref) });
  if (view === null) throw new Error('the closed run has no closed view');
  const crew = crewLine(view, 200)
    .map((span) => span.text)
    .join('');
  expect(crew).toContain('BUILD Fixture');
  expect(crew).not.toContain('Swapped');
}

/** Saves a REVIEW seat set to the PLAN seat's own tool, as a pick of that tool in the REVIEW picker does. */
function saveReviewerAsPlanner(target: StopContinueFixture): void {
  const config = loadConfig(target.projectDir).config;
  writeConfig(target.projectDir, { ...config, reviewer: config.planner });
}

/** The REVIEW span of the closed run's crew line. */
function closedReviewSpan(ref: SessionRef): string | undefined {
  const view = deriveSummaryView({ record: readRunRecord(ref) });
  if (view === null) throw new Error('the closed run has no closed view');
  return crewLine(view, 200).find((span) => span.seat === 'review')?.text;
}

afterEach(async () => {
  if (fixture !== undefined) {
    await endImplementerHold(fixture);
    cleanupTempDir(fixture.tmpDir);
  }
  fixture = undefined;
  resetAllStores();
});

describe('headless End run', { timeout: 240_000 }, () => {
  it('records the call a killed process left open, so the ended run reopens with it interrupted once', async () => {
    fixture = createStopContinueFixture();
    const target = fixture;
    const killed = await startAndSignal(target, 'SIGKILL', target.isolationTreesDir);
    expect(killed.exitCode).toBeNull();
    const ref = { projectDir: target.projectDir, sessionId: killed.sessionId };

    const ended = await cli(target, ['continue', killed.sessionId, '--action', 'end-run']);

    expect(ended.exitCode, ended.stderr).toBe(0);
    expect(readState(target, killed.sessionId).closed?.as).toBe('ended');
    const { events } = await readRunEvents(ref);
    const cut = events.filter(
      (event) => event.type === 'runner_call_error' && event.error.code === 'runner_interrupted',
    );
    expect(cut).toHaveLength(1);
    // The killed BUILD call's record says nothing saw it end: its time is only a lower bound.
    expect(cut[0]).toMatchObject({ role: 'implementer', endUnknown: true });
    const cutIndex = events.indexOf(cut[0] as (typeof events)[number]);
    expect(cutIndex).toBeLessThan(events.findIndex((event) => event.type === 'workflow_cancelled'));

    await hydrateRun(readRunRecord(ref));
    const rows = buildConversationRows({
      sections: groupEventsIntoSections(eventsStore.get().events),
      expandedDiffs: new Set(),
      expandedActivityBatches: new Set(),
      cols: 200,
      viewportHeight: 50,
      streaming: { taskId: null, lines: [], active: false },
    }).rows.map(rowText);
    expect(rows.filter((row) => row.includes('current turn interrupted'))).toHaveLength(1);
  });

  it('ends a SIGINT-parked run without pending recovery and preserves its patch', async () => {
    fixture = createStopContinueFixture();
    const target = fixture;
    const checkoutAtStart = checkoutEntries(target.projectDir);
    const parked = await startAndSignal(target, 'SIGINT', target.isolationTreesDir);
    expect(parked.exitCode).toBe(130);
    const parkedState = readState(target, parked.sessionId);
    expect(parkedState.pendingRecovery).toBeUndefined();
    const workspace = parkedState.workspace;
    if (workspace === undefined) throw new Error('the parked run has no workspace');
    expect(workspace.kind).toBe('worktree');
    expect(relative(target.isolationTreesDir, workspace.path)).not.toMatch(/^\.\./);
    expect(existsSync(workspace.path)).toBe(true);

    const ended = await cli(target, ['continue', parked.sessionId, '--action', 'end-run']);

    expect(ended.exitCode, ended.stderr).toBe(0);
    const closed = readState(target, parked.sessionId).closed;
    expect(closed?.as).toBe('ended');
    if (closed?.patch === undefined) throw new Error('the ended run has no patch');
    expect(ended.stdout).toBe(
      `Run ${parked.sessionId} closed. Run changes not applied are saved in ${closed.patch}; apply them with git apply.\n`,
    );
    expect(ended.stderr).not.toContain('run.patch');
    const patch = join(target.projectDir, closed.patch);
    expect(patch).toBe(join(sessionDir(target.projectDir, parked.sessionId), 'run.patch'));
    expect(existsSync(patch)).toBe(true);
    expect(readFileSync(patch, 'utf8')).toContain(
      "+export const RUN_MARKER = 'implementer-started';",
    );
    expect(existsSync(workspace.path)).toBe(false);
    expect(checkoutEntries(target.projectDir)).toEqual(checkoutAtStart);
  });

  // In a real run, End run during a BUILD call: the closed block listed fewer files than run.patch
  // held, showed the stopped brief again under Earlier work, and kept offering the removed
  // workspace for Continue.
  it('reads a run ended inside its brief the way run.patch and the workspace stand', async () => {
    fixture = createStopContinueFixture();
    const target = fixture;
    const parked = await startAndSignal(target, 'SIGINT', target.isolationTreesDir);
    expect(parked.exitCode).toBe(130);
    const ref = { projectDir: target.projectDir, sessionId: parked.sessionId };
    const record = readRunRecord(ref);
    await hydrateRun(record);
    routerStore.init({ screen: 'workflow', run: record, execution: { kind: 'at-rest' } });

    const ended = await cli(target, ['continue', parked.sessionId, '--action', 'end-run']);

    expect(ended.exitCode, ended.stderr).toBe(0);
    await rereadRunAtRest(ref);
    const refreshedEvents = eventsStore.get().events;
    await hydrateRun(readRunRecord(ref));
    expect(refreshedEvents).toEqual(eventsStore.get().events);
    const patch = readFileSync(
      join(sessionDir(ref.projectDir, ref.sessionId), 'run.patch'),
      'utf8',
    );
    expect(patch).toContain(`diff --git a/${MARKER_FILE} b/${MARKER_FILE}`);
    const patchFiles = [...patch.matchAll(/^diff --git a\/(\S+) b\//gm)].map((match) => match[1]);
    const view = deriveSummaryView({ record: readRunRecord(ref) });
    if (view === null) throw new Error('the ended run has no closed view');
    expect(filesRows(view).map((row) => row.path)).toEqual(patchFiles);
    expect(view.briefs.rows.map((row) => briefRowParts({ row }))).toMatchObject([
      { id: 'T001', state: { kind: 'halted', word: 'stopped' }, note: '1 partial file' },
    ]);
    expect(view.briefs.earlierRows).toEqual([]);
    const notices = await workspaceNotices(ref);
    expect(notices.logged).toContain(WORKSPACE_KEPT_CODE);
    expect(notices.shown).not.toContain(WORKSPACE_KEPT_CODE);
    expect(notices.shown).toContain('workspace_closed');
  });

  it.each([true, false])(
    'refreshes an open screen after headless End run, with changes: %s',
    async (hasChanges) => {
      fixture = createStopContinueFixture();
      const target = fixture;
      const parked = await startAndSignal(target, 'SIGINT', target.isolationTreesDir);
      expect(parked.exitCode).toBe(130);
      const ref = { projectDir: target.projectDir, sessionId: parked.sessionId };
      const record = readRunRecord(ref);
      const workspace = readState(target, parked.sessionId).workspace;
      if (workspace === undefined) throw new Error('the parked run has no workspace');
      if (!hasChanges) {
        unlinkSync(join(workspace.path, MARKER_FILE));
        const spawnEditor = vi.fn<SpawnEditor>();
        await showRunDiff(record, spawnEditor);
        expect(feedbackStore.get()).toEqual({ message: 'No run changes to show.', isError: false });
        expect(spawnEditor).not.toHaveBeenCalled();
        writeFileSync(join(sessionDir(ref.projectDir, ref.sessionId), 'run.patch'), 'old patch');
      }
      await hydrateRun(record);
      configStore.load(target.projectDir);
      routerStore.init({ screen: 'workflow', run: record, execution: { kind: 'at-rest' } });
      terminalSizeStore.__testReset({ cols: 160, rows: 60, isSmall: false });
      stopStore.park('mid-brief', null, null);
      overlayStore.open('stop-sheet');
      const ui = renderFeature(
        createElement(WorkflowScreen, { commands: [], onRuntimeCommand: () => {} }),
        { cols: 160, rows: 60 },
      );
      try {
        await flushEffects();
        expect(stripAnsiStyles(ui.lastFrame())).toContain('Resume');

        const ended = await cli(target, ['continue', parked.sessionId, '--action', 'end-run']);

        expect(ended.exitCode, ended.stderr).toBe(0);
        expect(existsSync(join(sessionDir(ref.projectDir, ref.sessionId), 'run.patch'))).toBe(
          hasChanges,
        );
        expect(ended.stdout.includes('apply them with git apply')).toBe(hasChanges);
        expect(ended.stderr).not.toContain('run.patch');
        await vi.waitFor(
          () => {
            const frame = stripAnsiStyles(ui.lastFrame());
            expect(frame).toContain('Closed');
            expect(frame).toContain('Stopped by you');
            expect(frame).not.toContain('Resume');
            expect(frame).not.toContain('to continue');
            expect(frame).not.toContain('Workspace kept');
            expect(frame).not.toContain('Partial changes kept');
            expect(frame.includes('run.patch')).toBe(hasChanges);
          },
          { timeout: 5_000 },
        );
        const refreshedEvents = eventsStore.get().events;
        const refreshedRoute = routerStore.get();
        await hydrateRun(readRunRecord(ref));
        expect(refreshedEvents).toEqual(eventsStore.get().events);
        expect(refreshedRoute.screen === 'workflow' && refreshedRoute.run.status).toEqual({
          kind: 'closed',
          as: 'ended',
        });
        expect(existsSync(workspace.path)).toBe(false);
      } finally {
        ui.unmount();
      }
    },
  );

  // Apply removes the workspace the stop kept, the same as End run and Discard do.
  it('an applied run no longer offers the workspace its stop kept for Continue', async () => {
    fixture = createStopContinueFixture();
    const target = fixture;
    const parked = await startAndSignal(target, 'SIGINT', target.isolationTreesDir);
    expect(parked.exitCode).toBe(130);
    const workspace = readState(target, parked.sessionId).workspace;
    if (workspace === undefined) throw new Error('the parked run has no workspace');
    const resumed = await continueRun(target);
    expect(resumed.exitCode, resumed.stderr).toBe(0);
    saveAnotherBuildModel(target);

    const applied = await cli(target, ['continue', parked.sessionId, '--action', 'apply']);

    expect(applied.exitCode, applied.stderr).toBe(0);
    expectRecordedBuildSeat({ projectDir: target.projectDir, sessionId: parked.sessionId });
    expect(closedReviewSpan({ projectDir: target.projectDir, sessionId: parked.sessionId })).toBe(
      'REVIEW = PLAN',
    );
    expect(
      deriveRunStatus({ state: readState(target, parked.sessionId), liveness: 'not-alive' }),
    ).toEqual({ kind: 'closed', as: 'applied' });
    expect(existsSync(workspace.path)).toBe(false);
    const notices = await workspaceNotices({
      projectDir: target.projectDir,
      sessionId: parked.sessionId,
    });
    expect(notices.logged).toContain(WORKSPACE_KEPT_CODE);
    expect(notices.shown).not.toContain(WORKSPACE_KEPT_CODE);
    expect(notices.shown).toContain('workspace_closed');
  });

  it('names a REVIEW seat set to the PLAN tool as its own seat after Apply, not = PLAN', async () => {
    fixture = createStopContinueFixture();
    const target = fixture;
    saveReviewerAsPlanner(target);
    const parked = await startAndSignal(target, 'SIGINT', target.isolationTreesDir);
    expect(parked.exitCode).toBe(130);
    const resumed = await continueRun(target);
    expect(resumed.exitCode, resumed.stderr).toBe(0);

    const applied = await cli(target, ['continue', parked.sessionId, '--action', 'apply']);

    expect(applied.exitCode, applied.stderr).toBe(0);
    const review = closedReviewSpan({ projectDir: target.projectDir, sessionId: parked.sessionId });
    expect(review).toMatch(/^REVIEW /);
    expect(review).not.toBe('REVIEW = PLAN');
  });

  it('discards a ready run through End run and keeps its files out of the checkout', async () => {
    fixture = createStopContinueFixture();
    const target = fixture;
    const checkoutAtStart = checkoutEntries(target.projectDir);
    const parked = await startAndSignal(target, 'SIGINT', target.isolationTreesDir);
    expect(parked.exitCode).toBe(130);
    expect(readState(target, parked.sessionId).pendingRecovery).toBeUndefined();

    const resumed = await continueRun(target);
    expect(resumed.exitCode, resumed.stderr).toBe(0);
    const ready = readState(target, parked.sessionId);
    expect(deriveRunStatus({ state: ready, liveness: 'not-alive' }).kind).toBe('ready-to-apply');
    saveAnotherBuildModel(target);

    const ended = await cli(target, ['continue', parked.sessionId, '--action', 'end-run']);

    expect(ended.exitCode, ended.stderr).toBe(0);
    expectRecordedBuildSeat({ projectDir: target.projectDir, sessionId: parked.sessionId });
    const closed = readState(target, parked.sessionId).closed;
    expect(closed?.as).toBe('discarded');
    if (closed?.patch === undefined) throw new Error('the discarded run has no patch');
    expect(ended.stdout).toBe(
      `Run ${parked.sessionId} closed. Run changes not applied are saved in ${closed.patch}; apply them with git apply.\n`,
    );
    expect(ended.stderr).not.toContain('run.patch');
    const patch = join(target.projectDir, closed.patch);
    expect(patch).toBe(join(sessionDir(target.projectDir, parked.sessionId), 'run.patch'));
    expect(existsSync(patch)).toBe(true);
    expect(existsSync(target.markerPath)).toBe(false);
    expect(existsSync(target.greetPath)).toBe(false);
    expect(checkoutEntries(target.projectDir)).toEqual(checkoutAtStart);

    // Nothing ran when End run discarded the ready run, so the SIGINT during BUILD is the one stop.
    const ref = { projectDir: target.projectDir, sessionId: parked.sessionId };
    const { events } = await readRunEvents(ref);
    const completedAt = events.findIndex((event) => event.type === 'workflow_complete');
    expect(completedAt).toBeGreaterThan(-1);
    expect(events.slice(completedAt).map((event) => event.type)).not.toContain(
      'workflow_cancelled',
    );
    await hydrateRun(readRunRecord(ref));
    const rows = buildConversationRows({
      sections: groupEventsIntoSections(eventsStore.get().events),
      expandedDiffs: new Set(),
      expandedActivityBatches: new Set(),
      cols: 200,
      viewportHeight: 50,
      streaming: { taskId: null, lines: [], active: false },
    }).rows.map(rowText);
    expect(rows.filter((row) => row.includes('Stopped by you'))).toHaveLength(1);
    expect(rows.some((row) => row.includes('run.patch'))).toBe(false);
  });
});
