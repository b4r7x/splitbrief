import type { HookEvent, HooksConfig } from '../../core/schemas/hooks.js';
import type { EngineEvent } from '../events/types.js';
import { hookTrustRefusal, runTrustedHook } from './dispatch.js';
import type { HookContext } from './types.js';

export interface PreHookResult {
  allow: boolean;
  reason?: string;
  warnings?: string[];
}

export async function runPreHooks(
  hooks: HooksConfig | undefined,
  event: HookEvent,
  eventPayload: EngineEvent,
  ctx: HookContext,
): Promise<PreHookResult> {
  const warnings: string[] = [];
  const entries = hooks?.[event] ?? [];
  if (entries.length === 0) {
    return { allow: true };
  }

  if (!hooks) return { allow: true };

  const trustRefusal = hookTrustRefusal(ctx.projectDir, hooks);
  if (trustRefusal) {
    return { allow: false, reason: trustRefusal, warnings };
  }

  for (const entry of entries) {
    const outcome = await runTrustedHook(entry, eventPayload, ctx, hooks);
    if (outcome.kind === 'deny') {
      return { allow: false, reason: outcome.message ?? `${event} hook denied`, warnings };
    }
    if (outcome.kind === 'crash' && entry.on_failure === 'block') {
      return { allow: false, reason: outcome.message, warnings };
    }
    const label = entry.name ?? entry.command;
    if (outcome.stderr) {
      warnings.push(`[${label}] stderr: ${outcome.stderr}`);
    }
    if (outcome.kind === 'crash' || outcome.kind === 'warn') {
      if (outcome.message) warnings.push(`[${label}] ${outcome.message}`);
    }
  }
  return { allow: true, ...(warnings.length > 0 ? { warnings } : {}) };
}
