import type { HookEvent, HookEntry, HooksConfig } from '../../core/schemas/hooks.js';
import type { Phase } from '../../core/schemas/enums.js';
import type { EngineEvent, EventBus, EventSink } from '../events/types.js';
import { runHook } from './dispatch.js';
import type { HookContext } from './types.js';
import { activeBuiltinsFor } from './builtins/registry.js';

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

async function runBuiltinsAndEntriesAndReport(
  builtins: ReturnType<typeof activeBuiltinsFor>,
  entries: HookEntry[],
  hookEvent: HookEvent,
  event: EngineEvent,
  ctx: HookContext,
  bus: EventBus,
): Promise<void> {
  const phase = ('phase' in event ? (event as { phase: unknown }).phase : 'implementing') as Phase;
  for (const builtin of builtins) {
    try {
      const outcome = await builtin.run(event, ctx);
      if (outcome.kind === 'crash') {
        bus.publish({ type: 'warning', ts: Date.now(), phase, message: `[builtin ${builtin.name}] crashed: ${outcome.message}` });
      } else if (outcome.kind === 'warn' && outcome.message) {
        bus.publish({ type: 'warning', ts: Date.now(), phase, message: `[builtin ${builtin.name}] ${outcome.message}` });
      } else if (outcome.kind === 'deny') {
        bus.publish({ type: 'warning', ts: Date.now(), phase, message: `[builtin ${builtin.name}] denied (post-hook deny is informational only): ${outcome.message ?? ''}` });
      }
    } catch (err) {
      bus.publish({ type: 'warning', ts: Date.now(), phase, message: `[builtin ${builtin.name}] crashed: ${err instanceof Error ? err.message : String(err)}` });
    }
  }
  for (const entry of entries) {
    try {
      const outcome = await runHook(entry, event, ctx);
      const label = entry.name ?? (entry.kind === 'module' ? entry.path : entry.command);
      if (outcome.kind === 'crash') {
        bus.publish({ type: 'warning', ts: Date.now(), phase, message: `[hook ${hookEvent} ${label}] crashed: ${outcome.message}` });
      } else if (outcome.kind === 'warn' && outcome.message) {
        bus.publish({ type: 'warning', ts: Date.now(), phase, message: `[hook ${hookEvent} ${label}] ${outcome.message}` });
      } else if (outcome.kind === 'deny') {
        bus.publish({ type: 'warning', ts: Date.now(), phase, message: `[hook ${hookEvent} ${label}] denied (post-hook deny is informational only): ${outcome.message ?? ''}` });
      }
    } catch (err) {
      bus.publish({ type: 'warning', ts: Date.now(), phase, message: `[hook ${hookEvent}] crashed: ${err instanceof Error ? err.message : String(err)}` });
    }
  }
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
