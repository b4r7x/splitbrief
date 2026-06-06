import type { HookEvent, HooksConfig } from '../../core/schemas/hooks.js';
import type { EngineEvent } from '../events/types.js';
import { runHook } from './dispatch.js';
import type { HookContext } from './types.js';
import { activeBuiltinsFor } from './builtins/registry.js';

export interface PreHookResult {
  allow: boolean;
  reason?: string;
}

export async function runPreHooks(
  hooks: HooksConfig | undefined,
  event: HookEvent,
  eventPayload: EngineEvent,
  ctx: HookContext,
): Promise<PreHookResult> {
  for (const builtin of activeBuiltinsFor(event, hooks)) {
    const outcome = await builtin.run(eventPayload, ctx);
    if (outcome.kind === 'deny') {
      return { allow: false, reason: outcome.message ?? `${event} builtin denied` };
    }
    if (outcome.kind === 'crash') {
      return { allow: false, reason: outcome.message };
    }
  }
  const entries = hooks?.[event] ?? [];
  for (const entry of entries) {
    const outcome = await runHook(entry, eventPayload, ctx);
    if (outcome.kind === 'deny') {
      return { allow: false, reason: outcome.message ?? `${event} hook denied` };
    }
    if (outcome.kind === 'crash' && entry.on_failure === 'block') {
      return { allow: false, reason: outcome.message };
    }
  }
  return { allow: true };
}
