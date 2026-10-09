import { phaseStage } from '../rail-stages.js';
import type { Phase, TaskCompletionMethod } from '../schemas/enums.js';

export interface SectionableEvent {
  type: string;
  ts?: number;
  phase?: Phase;
}

type TaskStartedEvent = {
  type: 'task_started';
  taskId: string;
  title: string;
  file: string;
};
type TaskCompletedEvent = {
  type: 'task_completed';
  taskId: string;
  method: TaskCompletionMethod;
  retries: number;
  duration: number;
};
type TaskSkippedEvent = { type: 'task_skipped'; taskId: string; reason: string };
type TaskFullFailEvent = { type: 'task_full_fail'; taskId: string };
type TaskResetEvent = { type: 'task_reset'; taskId: string };
type DiffEvent = { type: 'implementer_generate_done'; diff?: string | undefined };
type TaskEndEvent = TaskCompletedEvent | TaskSkippedEvent | TaskFullFailEvent;
type WorkflowStartedEvent = { type: 'workflow_started'; feature: string };
type FullSuiteEvent = {
  type: 'full_suite';
  status: 'running' | 'done' | 'not-run' | 'refused';
  id?: string;
  command: string;
  moment: 'pre-review' | 'base' | 'brief';
  passed?: boolean;
  newFailures?: number;
};
type ChecksRunEvent = { type: 'checks_run'; results: { passed: boolean }[] };
type ReviewFixStartedEvent = { type: 'review_fix_started'; taskIds: string[] };

interface TaskRange<TEvent extends SectionableEvent> {
  taskId: string;
  startIdx: number;
  endIdx: number;
  startEvent: TEvent & TaskStartedEvent;
  endEvent?: (TEvent & TaskEndEvent) | undefined;
  abandoned: boolean;
}

function isTaskStartedEvent<TEvent extends SectionableEvent>(
  event: TEvent,
): event is TEvent & TaskStartedEvent {
  return event.type === 'task_started';
}

function isTaskEndEvent<TEvent extends SectionableEvent>(
  event: TEvent,
): event is TEvent & TaskEndEvent {
  return (
    event.type === 'task_completed' ||
    event.type === 'task_skipped' ||
    event.type === 'task_full_fail'
  );
}

function isTaskResetEvent<TEvent extends SectionableEvent>(
  event: TEvent,
): event is TEvent & TaskResetEvent {
  return event.type === 'task_reset';
}

function isDiffEvent<TEvent extends SectionableEvent>(event: TEvent): event is TEvent & DiffEvent {
  return event.type === 'implementer_generate_done';
}

function isWorkflowStartedEvent<TEvent extends SectionableEvent>(
  event: TEvent,
): event is TEvent & WorkflowStartedEvent {
  return event.type === 'workflow_started';
}

function isFullSuiteEvent<TEvent extends SectionableEvent>(
  event: TEvent,
): event is TEvent & FullSuiteEvent {
  return event.type === 'full_suite';
}

function isChecksRunEvent<TEvent extends SectionableEvent>(
  event: TEvent,
): event is TEvent & ChecksRunEvent {
  return event.type === 'checks_run';
}

function isReviewFixStartedEvent<TEvent extends SectionableEvent>(
  event: TEvent,
): event is TEvent & ReviewFixStartedEvent {
  return event.type === 'review_fix_started';
}

// The diff's stable identity is its global render index, not its timestamp: publishers stamp events
// with `Date.now()`, so two diffs produced in the same millisecond would collide on a type+ts key and
// expand/collapse together. The global index is unique per rendered event and survives appends.
export function diffEventKey(event: SectionableEvent, globalIndex: number): string {
  return `${event.type}:${globalIndex}`;
}

export function findLatestRenderableDiffKey<TEvent extends SectionableEvent>(
  sections: Section<TEvent>[],
): string | null {
  for (let sectionIndex = sections.length - 1; sectionIndex >= 0; sectionIndex--) {
    const section = sections[sectionIndex];
    if (!section || isSettledSection(section)) continue;
    for (let index = section.items.length - 1; index >= 0; index--) {
      const event = section.items[index];
      if (!event) continue;
      if (isDiffEvent(event) && event.diff) {
        return diffEventKey(event, section.startIndex + index);
      }
    }
  }
  return null;
}

export type StageSummary =
  | { stage: 'plan'; feature: string; duration: number }
  | {
      stage: 'review';
      ordinal: number;
      failedCommands: string[];
      failedChecks: number;
      fixes: string[];
      duration: number;
    };

export type Section<TEvent extends SectionableEvent = SectionableEvent> =
  | { type: 'events'; items: TEvent[]; startIndex: number }
  | { type: 'settled-stage'; items: TEvent[]; startIndex: number; summary: StageSummary }
  | {
      type: 'completed-task';
      items: TEvent[];
      startIndex: number;
      summary: {
        /** The brief's own id, which every other surface names it by. */
        id: string;
        title: string;
        method: TaskCompletionMethod;
        retries: number;
        duration: number;
        file?: string;
        reason?: string;
      };
    }
  | { type: 'active-task'; items: TEvent[]; startIndex: number };

export function isSettledSection<TEvent extends SectionableEvent>(
  section: Section<TEvent>,
): section is Extract<Section<TEvent>, { type: 'completed-task' | 'settled-stage' }> {
  return section.type === 'completed-task' || section.type === 'settled-stage';
}

export function groupEventsIntoSections<TEvent extends SectionableEvent>(
  events: TEvent[],
): Section<TEvent>[] {
  const taskRanges: TaskRange<TEvent>[] = [];
  const openTasks = new Map<string, number>();

  for (let i = 0; i < events.length; i++) {
    const ev = events[i];
    if (ev === undefined) continue;
    if (isTaskStartedEvent(ev)) {
      abandonOpenTask(taskRanges, openTasks, ev.taskId, i - 1);
      const latest = taskRanges.at(-1);
      if (latest?.abandoned && latest.taskId === ev.taskId) {
        latest.abandoned = false;
        latest.endIdx = -1;
        latest.startEvent = ev;
        openTasks.set(ev.taskId, taskRanges.length - 1);
        continue;
      }
      const idx = taskRanges.length;
      taskRanges.push({
        taskId: ev.taskId,
        startIdx: i,
        endIdx: -1,
        startEvent: ev,
        abandoned: false,
      });
      openTasks.set(ev.taskId, idx);
    } else if (isTaskResetEvent(ev)) {
      abandonOpenTask(taskRanges, openTasks, ev.taskId, i);
    } else if (isTaskEndEvent(ev)) {
      const rangeIdx = openTasks.get(ev.taskId);
      if (rangeIdx != null) {
        const range = taskRanges[rangeIdx];
        if (!range) continue;
        range.endIdx = i;
        range.endEvent = ev;
        range.abandoned = false;
        openTasks.delete(ev.taskId);
      }
    }
  }

  joinBuildRowsToBriefs(events, taskRanges);

  const sections: Section<TEvent>[] = [];
  let cursor = 0;
  let reviewStages = 0;

  for (const range of taskRanges) {
    if (cursor < range.startIdx) {
      const items = events.slice(cursor, range.startIdx);
      const summary = settledStageSummary(items, reviewStages + 1);
      if (summary === null) {
        sections.push({ type: 'events', items, startIndex: cursor });
      } else {
        sections.push({ type: 'settled-stage', items, startIndex: cursor, summary });
        if (summary.stage === 'review') reviewStages++;
      }
    }

    if (range.abandoned && range.endIdx >= range.startIdx) {
      sections.push({
        type: 'events',
        items: events.slice(range.startIdx, range.endIdx + 1),
        startIndex: range.startIdx,
      });
      cursor = range.endIdx + 1;
    } else if (range.endIdx >= 0 && range.endEvent) {
      const endEvent = range.endEvent;
      if (endEvent.type === 'task_completed') {
        sections.push({
          type: 'completed-task',
          items: events.slice(range.startIdx, range.endIdx + 1),
          startIndex: range.startIdx,
          summary: {
            id: range.taskId,
            title: range.startEvent.title,
            method: endEvent.method,
            retries: endEvent.retries,
            duration: endEvent.duration,
            file: range.startEvent.file,
          },
        });
      } else if (endEvent.type === 'task_skipped') {
        sections.push({
          type: 'completed-task',
          items: events.slice(range.startIdx, range.endIdx + 1),
          startIndex: range.startIdx,
          summary: {
            id: range.taskId,
            title: range.startEvent.title,
            method: 'skipped',
            retries: 0,
            duration: 0,
            reason: endEvent.reason,
          },
        });
      } else if (endEvent.type === 'task_full_fail') {
        sections.push({
          type: 'completed-task',
          items: events.slice(range.startIdx, range.endIdx + 1),
          startIndex: range.startIdx,
          summary: {
            id: range.taskId,
            title: range.startEvent.title,
            method: 'failed',
            retries: 0,
            duration: 0,
            file: range.startEvent.file,
          },
        });
      }
      cursor = range.endIdx + 1;
    } else {
      sections.push({
        type: 'active-task',
        items: events.slice(range.startIdx),
        startIndex: range.startIdx,
      });
      cursor = events.length;
      break;
    }
  }

  if (cursor < events.length) {
    sections.push({ type: 'events', items: events.slice(cursor), startIndex: cursor });
  }

  return sections;
}

function isBuildRow(event: SectionableEvent | undefined, hasReviewStage: boolean): boolean {
  return (
    event?.phase !== undefined &&
    phaseStage(event.phase) === 'build' &&
    !(hasReviewStage && event.type === 'review_fix_started')
  );
}

function settledStageSummary<TEvent extends SectionableEvent>(
  items: TEvent[],
  ordinal: number,
): StageSummary | null {
  const stages = items.map((event) => (event.phase === undefined ? null : phaseStage(event.phase)));
  const stage = stages.includes('review') ? 'review' : stages.includes('plan') ? 'plan' : null;
  if (stage === null) return null;

  let firstTs: number | undefined;
  let lastTs: number | undefined;
  for (const event of items) {
    if (event.ts === undefined) continue;
    firstTs ??= event.ts;
    lastTs = event.ts;
  }
  const duration = firstTs === undefined || lastTs === undefined ? 0 : lastTs - firstTs;
  if (stage === 'plan') {
    return { stage, feature: items.find(isWorkflowStartedEvent)?.feature ?? '', duration };
  }

  const failedCommands = new Set<string>();
  let failedChecks = 0;
  let fixes: string[] = [];
  // A red pre-review command counts as failed. A red base re-run with zero new failures removes
  // it because every failure is pre-existing and the run continued. Older base rows keep the count.
  for (const event of items) {
    if (isFullSuiteEvent(event) && event.status === 'done' && event.passed === false) {
      if (event.moment === 'pre-review') failedCommands.add(event.command);
      if (event.moment === 'base' && event.newFailures === 0) failedCommands.delete(event.command);
    }
    if (isChecksRunEvent(event)) {
      failedChecks += event.results.filter((result) => result.passed === false).length;
    }
    if (isReviewFixStartedEvent(event)) fixes = event.taskIds;
  }
  return { stage, ordinal, failedCommands: [...failedCommands], failedChecks, fixes, duration };
}

// A build row between two briefs joins the brief that closed before it; the build rows left before a
// brief (the run start, a fix cycle's re-entry) join that brief. The tail after the last brief stays.
function joinBuildRowsToBriefs<TEvent extends SectionableEvent>(
  events: TEvent[],
  taskRanges: TaskRange<TEvent>[],
): void {
  for (let r = 0; r < taskRanges.length; r++) {
    const range = taskRanges[r];
    const previous = taskRanges[r - 1];
    if (!range || (previous && previous.endIdx < 0)) return;
    let gapStart = previous ? previous.endIdx + 1 : 0;
    const hasReviewStage = events
      .slice(gapStart, range.startIdx)
      .some((event) => event.phase !== undefined && phaseStage(event.phase) === 'review');
    if (previous?.endEvent) {
      while (
        gapStart < range.startIdx &&
        events[gapStart]?.type !== 'review_fix_started' &&
        isBuildRow(events[gapStart], hasReviewStage)
      ) {
        gapStart++;
      }
      previous.endIdx = gapStart - 1;
    }
    while (range.startIdx > gapStart && isBuildRow(events[range.startIdx - 1], hasReviewStage)) {
      range.startIdx--;
    }
  }
}

function abandonOpenTask<TEvent extends SectionableEvent>(
  taskRanges: TaskRange<TEvent>[],
  openTasks: Map<string, number>,
  taskId: string,
  endIdx: number,
): void {
  const rangeIdx = openTasks.get(taskId);
  if (rangeIdx === undefined) return;
  const range = taskRanges[rangeIdx];
  if (!range) return;
  range.endIdx = Math.max(range.startIdx, endIdx);
  range.endEvent = undefined;
  range.abandoned = true;
  openTasks.delete(taskId);
}
