import type { RunRecord } from '../../core/sessions/run-record.js';
import { readRunEvents } from '../../engine/events/replay.js';
import { reapOrphanRunners } from '../../engine/orchestrator/run/orphan-reaper.js';
import { loadEvents } from '../../stores/workflow/actions/load.js';
import { resetWorkflowControls } from '../../stores/workflow/actions/reset.js';
import { hydrateFromState } from '../../stores/workflow/actions/hydrate.js';
import type { EngineEvent, EngineEventOf } from '../../engine/events/types.js';
import { extractLastJsonObject } from '../../engine/runners/typed-output.js';
import { ImplementerReportSchema } from '../../core/schemas/consult.js';
import { processWentAway } from '../../core/sessions/run-status.js';
import { interruptedCallEvents } from '../../engine/calls/interrupted.js';

/**
 * A past run, put back on the workflow screen: its session log replayed into the stores, then the
 * saved state laid over the facts the log cannot settle — the phase it stopped in, the brief list
 * and what it spent. A run whose process went away left its last calls open; they read as the
 * interruption its resume or its End run will record. Navigation and changed session files at
 * rest replay this history; the live bus appends while this process drives the run.
 */
export async function hydrateRun(record: RunRecord): Promise<void> {
  const publish = await readRunHistory(record);
  resetWorkflowControls();
  publish();
}

/**
 * The read half of `hydrateRun`: the log comes off disk and no store is touched until the returned
 * step runs, which lays the whole run on the stores in one synchronous turn. A selection that was
 * superseded while it read simply never calls it.
 */
export async function readRunHistory(record: RunRecord): Promise<() => void> {
  // A run shown at rest must not change underneath it: a tool its crashed process left running ends first.
  await reapOrphanRunners(record.ref.projectDir);
  const replay = await readRunEvents(record.ref);
  const cut = processWentAway(record.status)
    ? interruptedCallEvents(replay.events, record.ref.projectDir)
    : [];
  // The replay closes on its own marker; the cut calls belong to the history before it.
  const history = [...replay.events.slice(0, -1), ...cut, ...replay.events.slice(-1)];
  return () => {
    loadEvents(restoreCompletionFiles(history));
    if (record.hydration.kind !== 'loaded') return;
    const { state } = record.hydration;
    hydrateFromState(state);
  };
}

function restoreCompletionFiles(events: EngineEvent[]): EngineEvent[] {
  let started: EngineEventOf<'task_started'> | undefined;
  let reportedFiles: string[] | undefined;
  return events.map((event) => {
    if (event.type === 'task_started') {
      started = event;
      reportedFiles = undefined;
    } else if (event.type === 'implementer_generate_running') {
      reportedFiles = undefined;
    } else if (
      event.type === 'planner_text' &&
      event.role === 'implementer' &&
      event.content !== 'plain' &&
      started !== undefined &&
      event.phase === started.phase &&
      (event.taskId === undefined || event.taskId === started.taskId)
    ) {
      const extracted = extractLastJsonObject(event.text);
      if (extracted.kind === 'ok') {
        const report = ImplementerReportSchema.safeParse(extracted.value);
        if (report.success && report.data.status === 'done') {
          reportedFiles = [...new Set(report.data.filesChanged)];
        }
      }
    } else if (
      event.type === 'implementer_generate_done' &&
      event.files === undefined &&
      event.taskId === started?.taskId &&
      reportedFiles !== undefined &&
      reportedFiles.length > 0
    ) {
      return { ...event, files: reportedFiles };
    }
    return event;
  });
}
