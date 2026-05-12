import type { HookEvent, HookEntry, HooksConfig } from '../../core/schemas/hooks.js';
import type { Phase } from '../../core/schemas/enums.js';
import type { EngineEvent, EventBus, EventSink } from '../events/types.js';
import { runHook } from './dispatch.js';
import type { HookContext, HookOutcome } from './types.js';
import { activeBuiltinsFor } from './builtins/registry.js';
import { toErrorMessage } from '../../utils/format-errors.js';

export function createHookSink(hooks: HooksConfig, ctx: HookContext, bus: EventBus): EventSink {
  return (event) => {
    const hookEvent = eventToHookKey(event);
    if (!hookEvent) return;
    const builtins = activeBuiltinsFor(hookEvent, hooks);
    const entries = hooks[hookEvent] ?? [];
    if (builtins.length === 0 && entries.length === 0) return;
    void runBuiltinsAndEntriesAndReport(builtins, entries, hookEvent, event, ctx, bus);
  };
}

async function runAndReport(
  label: string,
  phase: Phase,
  bus: EventBus,
  fn: () => Promise<HookOutcome>,
): Promise<void> {
  try {
    const outcome = await fn();
    if (outcome.kind === 'crash') {
      bus.publish({ type: 'warning', ts: Date.now(), phase, message: `${label} crashed: ${outcome.message}` });
    } else if (outcome.kind === 'warn' && outcome.message) {
      bus.publish({ type: 'warning', ts: Date.now(), phase, message: `${label} ${outcome.message}` });
    } else if (outcome.kind === 'deny') {
      bus.publish({ type: 'warning', ts: Date.now(), phase, message: `${label} denied (post-hook deny is informational only): ${outcome.message ?? ''}` });
    }
  } catch (err) {
    bus.publish({ type: 'warning', ts: Date.now(), phase, message: `${label} crashed: ${toErrorMessage(err)}` });
  }
}

async function runBuiltinsAndEntriesAndReport(
  builtins: ReturnType<typeof activeBuiltinsFor>,
  entries: HookEntry[],
  hookEvent: HookEvent,
  event: EngineEvent,
  ctx: HookContext,
  bus: EventBus,
): Promise<void> {
  const phase = getEventPhase(event);
  for (const builtin of builtins) {
    await runAndReport(`[builtin ${builtin.name}]`, phase, bus, () => builtin.run(event, ctx));
  }
  for (const entry of entries) {
    const label = entry.name ?? (entry.kind === 'module' ? entry.path : entry.command);
    await runAndReport(`[hook ${hookEvent} ${label}]`, phase, bus, () => runHook(entry, event, ctx));
  }
}

function getEventPhase(event: EngineEvent): Phase {
  return 'phase' in event ? event.phase : 'implementing';
}

function eventToHookKey(e: EngineEvent): HookEvent | null {
  switch (e.type) {
    case 'task_completed': return 'post_task';
    case 'validate':
      return e.status === 'done' ? 'post_validation' : null;
    case 'git_commit': return 'post_commit';
    case 'plan_done': return 'post_planning';
    case 'workflow_complete': return 'on_complete';
    case 'error': return 'on_error';
    default: return null;
  }
}
