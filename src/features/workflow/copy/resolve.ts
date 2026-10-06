import { isAbsolute, relative } from 'node:path';
import { configStore } from '../../../stores/project/config.js';
import { getVisibleBriefWindow, reviewStore } from '../../../stores/workflow/review.js';
import { eventsStore } from '../../../stores/workflow/events.js';
import { getRunnerCommand } from '../../../core/config/accessors/runner-config.js';
import type { CopyTarget } from '../../../core/runtime/commands/types.js';
import { assertNever } from '../../../utils/type-guards.js';
import { readCostText } from '../spend-text.js';

function lastAssistantMessage(): string | null {
  const { events } = eventsStore.get();
  for (let index = events.length - 1; index >= 0; index--) {
    const event = events[index];
    if (event?.type === 'planner_text' && event.text.length > 0) return event.text;
  }
  return null;
}

// The brief row a copy command targets: the top of the visible window, the row the user is reading.
function visibleBriefIndex(): number | null {
  const { start, count } = getVisibleBriefWindow();
  return count > 0 ? start : null;
}

// Resolves the canonical source value for a copy target — the raw, un-sanitized, un-truncated value
// the user is reviewing (never the redacted/strip-filtered display). Returns null when the target
// has no value available; callers report "Nothing to copy".
export function resolveCopyValue(target: CopyTarget): string | null {
  switch (target) {
    case 'path': {
      // The visible brief row's own file, not the review document path. Aligned to `briefSources`
      // by index.
      const { briefPaths } = reviewStore.get();
      if (briefPaths.length === 0) return null;
      const index = visibleBriefIndex();
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
      const index = visibleBriefIndex();
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
