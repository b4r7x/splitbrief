import { existsSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { sessionDir } from '../../../src/core/paths.js';
import { groupEventsIntoSections } from '../../../src/core/sections/event-sections.js';
import { readRunRecord } from '../../../src/core/sessions/run-record-io.js';
import { deriveRunStatus } from '../../../src/core/sessions/run-status.js';
import { WORKSPACE_KEPT_CODE } from '../../../src/core/sessions/workspace-notice.js';
import type { SessionRef } from '../../../src/core/types/session-ref.js';
import { readRunEvents } from '../../../src/engine/events/replay.js';
import type { EngineEvent } from '../../../src/engine/events/types.js';
import { briefRowParts, filesRows } from '../../../src/features/workflow/closed/copy.js';
import { deriveSummaryView } from '../../../src/features/workflow/closed/view-model.js';
import { walkTranscript } from '../../../src/features/workflow/conversation-rows/transcript-walk.js';
import { rowText } from '../../../src/features/workflow/conversation-rows/row-format/rows.js';
import { hydrateRun } from '../../../src/features/workflow/run-history.js';
import { eventsStore } from '../../../src/stores/workflow/events.js';
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

afterEach(async () => {
  if (fixture !== undefined) {
    await endImplementerHold(fixture);
    cleanupTempDir(fixture.tmpDir);
  }
  fixture = undefined;
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
    expect(parked.exitCode).toBe(0);
    const parkedState = readState(target, parked.sessionId);
    expect(parkedState.pendingRecovery).toBeUndefined();
    const workspace = parkedState.workspace;
    if (workspace === undefined) throw new Error('the parked run has no workspace');
    expect(workspace.kind).toBe('worktree');
    expect(relative(target.isolationTreesDir, workspace.path)).not.toMatch(/^\.\./);
    expect(existsSync(workspace.path)).toBe(true);

    const ended = await cli(target, ['continue', parked.sessionId, '--action', 'end-run']);

    expect(ended.exitCode, ended.stderr).toBe(0);
    expect(ended.stdout).toBe(`Run ${parked.sessionId} closed.\n`);
    const closed = readState(target, parked.sessionId).closed;
    expect(closed?.as).toBe('ended');
    if (closed?.patch === undefined) throw new Error('the ended run has no patch');
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
    expect(parked.exitCode).toBe(0);

    const ended = await cli(target, ['continue', parked.sessionId, '--action', 'end-run']);

    expect(ended.exitCode, ended.stderr).toBe(0);
    const ref = { projectDir: target.projectDir, sessionId: parked.sessionId };
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

  // Apply removes the workspace the stop kept, the same as End run and Discard do.
  it('an applied run no longer offers the workspace its stop kept for Continue', async () => {
    fixture = createStopContinueFixture();
    const target = fixture;
    const parked = await startAndSignal(target, 'SIGINT', target.isolationTreesDir);
    expect(parked.exitCode).toBe(0);
    const workspace = readState(target, parked.sessionId).workspace;
    if (workspace === undefined) throw new Error('the parked run has no workspace');
    const resumed = await continueRun(target);
    expect(resumed.exitCode, resumed.stderr).toBe(0);

    const applied = await cli(target, ['continue', parked.sessionId, '--action', 'apply']);

    expect(applied.exitCode, applied.stderr).toBe(0);
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

  it('discards a ready run through End run and keeps its files out of the checkout', async () => {
    fixture = createStopContinueFixture();
    const target = fixture;
    const checkoutAtStart = checkoutEntries(target.projectDir);
    const parked = await startAndSignal(target, 'SIGINT', target.isolationTreesDir);
    expect(parked.exitCode).toBe(0);
    expect(readState(target, parked.sessionId).pendingRecovery).toBeUndefined();

    const resumed = await continueRun(target);
    expect(resumed.exitCode, resumed.stderr).toBe(0);
    const ready = readState(target, parked.sessionId);
    expect(deriveRunStatus({ state: ready, liveness: 'not-alive' }).kind).toBe('ready-to-apply');

    const ended = await cli(target, ['continue', parked.sessionId, '--action', 'end-run']);

    expect(ended.exitCode, ended.stderr).toBe(0);
    expect(ended.stdout).toBe(`Run ${parked.sessionId} closed.\n`);
    const closed = readState(target, parked.sessionId).closed;
    expect(closed?.as).toBe('discarded');
    if (closed?.patch === undefined) throw new Error('the discarded run has no patch');
    const patch = join(target.projectDir, closed.patch);
    expect(patch).toBe(join(sessionDir(target.projectDir, parked.sessionId), 'run.patch'));
    expect(existsSync(patch)).toBe(true);
    expect(ended.stderr).toContain('run.patch; apply them with git apply.');
    expect(existsSync(target.markerPath)).toBe(false);
    expect(existsSync(target.greetPath)).toBe(false);
    expect(checkoutEntries(target.projectDir)).toEqual(checkoutAtStart);
  });
});
