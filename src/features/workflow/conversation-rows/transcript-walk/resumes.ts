import type { Section } from '../../../../core/sections/types.js';
import { WORKSPACE_KEPT_CODE } from '../../../../core/sessions/workspace-notice.js';
import type { EngineEventOf, EngineEvent } from '../../../../engine/events/types.js';

/**
 * The kept-workspace notice that still shows: the last one, until the run continues or a close (End
 * run, Discard or Apply) lets the workspace go.
 */
export function keptWorkspaceNotice(
  sections: readonly Section<EngineEvent>[],
): EngineEventOf<'warning'> | undefined {
  let notice: EngineEventOf<'warning'> | undefined;
  for (const section of sections) {
    for (const event of section.items) {
      if (event.type === 'warning' && event.code === WORKSPACE_KEPT_CODE) notice = event;
      if (event.type === 'workflow_resumed' || event.type === 'workspace_closed')
        notice = undefined;
    }
  }
  return notice;
}

/**
 * Each resume that a recovery answer started. A stop, a cancel or a refused answer between the
 * answer and the resume leaves that resume its own row.
 */
export function answeredResumes(sections: readonly Section<EngineEvent>[]): Set<EngineEvent> {
  const answered = new Set<EngineEvent>();
  let answer = false;
  for (const section of sections) {
    for (const event of section.items) {
      if (event.type === 'recovery_action_selected') answer = true;
      if (
        event.type === 'workflow_cancelled' ||
        event.type === 'turn_interrupted' ||
        event.type === 'recovery_action_failed'
      )
        answer = false;
      if (event.type === 'workflow_resumed' && answer) {
        answered.add(event);
        answer = false;
      }
    }
  }
  return answered;
}

/**
 * The resume of each crew change at a boundary that carried the run on by itself, and the park
 * just before it. A park that a later resume did not carry on stays a stop.
 */
export function carriedOnSeatChanges(sections: readonly Section<EngineEvent>[]): Set<EngineEvent> {
  const carried = new Set<EngineEvent>();
  let park: EngineEventOf<'turn_interrupted'> | undefined;
  for (const section of sections) {
    for (const event of section.items) {
      if (event.type === 'turn_interrupted' || event.type === 'workflow_cancelled')
        park =
          event.type === 'turn_interrupted' && event.cause === 'seat-change' ? event : undefined;
      if (event.type !== 'workflow_resumed') continue;
      if (event.cause === 'seat-change') {
        carried.add(event);
        if (park !== undefined) carried.add(park);
      }
      park = undefined;
    }
  }
  return carried;
}
