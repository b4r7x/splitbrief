import type { HookEvent, HooksConfig } from '../../core/schemas/hooks.js';
import type { EngineEvent } from '../events/types.js';
import { hookTrustRefusal, runTrustedHook } from './dispatch.js';
import type { HookContext } from './types.js';
import { activeBuiltinsFor } from './builtins/registry.js';

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
  const builtins = activeBuiltinsFor(event, hooks);
  const entries = hooks?.[event] ?? [];
  if (builtins.length === 0 && entries.length === 0) {
    return { allow: true };
  }

  if (!hooks) return { allow: true };

  const trustRefusal = hookTrustRefusal(ctx.projectDir, hooks);
  if (trustRefusal) {
    return { allow: false, reason: trustRefusal, warnings };
  }

  for (const builtin of builtins) {
    const outcome = await builtin.run(eventPayload, ctx);
    if (outcome.kind === 'deny') {
      return { allow: false, reason: outcome.message ?? `${event} builtin denied`, warnings };
    }
    if (outcome.kind === 'crash') {
      return { allow: false, reason: outcome.message, warnings };
    }
    if ((outcome.kind === 'warn' || outcome.kind === 'allow') && outcome.stderr) {
      warnings.push(`[builtin ${builtin.name}] stderr: ${outcome.stderr}`);
    }
    if (outcome.kind === 'warn' && outcome.message) {
      warnings.push(`[builtin ${builtin.name}] ${outcome.message}`);
    }
  }
  for (const entry of entries) {
    const outcome = await runTrustedHook(entry, eventPayload, ctx, hooks);
    if (outcome.kind === 'deny') {
      return { allow: false, reason: outcome.message ?? `${event} hook denied`, warnings };
    }
    if (outcome.kind === 'crash' && entry.on_failure === 'block') {
      return { allow: false, reason: outcome.message, warnings };
    }
    const label = entry.name ?? (entry.kind === 'module' ? entry.path : entry.command);
    if (outcome.stderr) {
      warnings.push(`[${label}] stderr: ${outcome.stderr}`);
    }
    if (outcome.kind === 'crash' || outcome.kind === 'warn') {
      if (outcome.message) warnings.push(`[${label}] ${outcome.message}`);
    }
  }
  return { allow: true, ...(warnings.length > 0 ? { warnings } : {}) };
}
