import { isAbsolute, relative } from 'node:path';
import { configStore } from '../../../stores/project/config.js';
import {
  getVisibleBriefWindow,
  isBriefIndexVisible,
  reviewStore,
} from '../../../stores/workflow/review.js';
import { eventsStore } from '../../../stores/workflow/events.js';
import { focusStore, type Focus } from '../../../stores/ui/focus.js';
import { getRunnerCommand } from '../../../core/config/accessors/runner-config.js';
import type { CopyTarget } from '../../../core/runtime/commands/types.js';
import { assertNever } from '../../../utils/type-guards.js';
import { readCostText } from '../cost-text.js';

function lastAssistantMessage(): string | null {
  const { events } = eventsStore.get();
  for (let index = events.length - 1; index >= 0; index--) {
    const event = events[index];
    if (event?.type === 'planner_text' && event.text.length > 0) return event.text;
  }
  return null;
}

// The brief row a copy command targets. Requires a non-empty visible window and an index inside
// [start, start + count). A click or arrow-key selection sets brief focus; without one (e.g. a bare
// `/copy brief`) fall back to the top of the visible window — the row the user is reading. An
// explicit focus index is honored only when it is visible; stale out-of-window focus copies nothing
// rather than silently yanking the wrong brief.
function focusedBriefIndex(focus = focusStore.get()): number | null {
  const state = reviewStore.get();
  const { start, count } = getVisibleBriefWindow(state);
  if (count <= 0) return null;
  if (focus !== null && focus.region === 'brief') {
    return isBriefIndexVisible(focus.index, state) ? focus.index : null;
  }
  return start;
}

// Resolves the canonical source value for a copy target — the raw, un-sanitized, un-truncated value
// the user is reviewing (never the redacted/strip-filtered display). Returns null when the target
// has no value available; callers report "Nothing to copy".
export function resolveCopyValue(target: CopyTarget): string | null {
  switch (target) {
    case 'path': {
      // The focused brief row's own file, not the review document path — the row the user is
      // pointing at is the one they mean to copy a path for. Aligned to `briefSources` by index.
      const { briefPaths } = reviewStore.get();
      if (briefPaths.length === 0) return null;
      const index = focusedBriefIndex();
      if (index === null) return null;
      const file = briefPaths[index];
      if (file === undefined || file.length === 0) return null;
      return isAbsolute(file) ? relative(configStore.get().projectDir, file) : file;
    }
    case 'command': {
      const config = configStore.get().config;
      return config ? (getRunnerCommand(config.planner) ?? null) : null;
    }
    case 'brief': {
      const { briefSources } = reviewStore.get();
      if (briefSources.length === 0) return null;
      const index = focusedBriefIndex();
      if (index === null) return null;
      const source = briefSources[index];
      return source && source.length > 0 ? source : null;
    }
    case 'message':
      return lastAssistantMessage();
    case 'cost':
      return readCostText();
    default:
      return assertNever(target);
  }
}

export function focusHasResolvableCopy(focus: Focus | null): boolean {
  if (focus === null) return false;
  if (focus.region !== 'brief') return false;
  const state = reviewStore.get();
  if (state.briefSources.length === 0) return false;
  if (!isBriefIndexVisible(focus.index, state)) return false;
  const value = state.briefSources[focus.index];
  return value !== undefined && value !== null && value.length > 0;
}
