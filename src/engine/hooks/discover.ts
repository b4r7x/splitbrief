import { readdir } from 'node:fs/promises';
import { basename, extname, join } from 'node:path';
import { HookModuleEntrySchema, type HookEvent, type HookModuleEntry, type HooksConfig } from '../../core/schemas/hooks.js';

const HOOK_EVENT_BY_FILE_NAME: Record<string, HookEvent> = {
  'pre-planning': 'pre_planning',
  'pre-task': 'pre_task',
  'post-task': 'post_task',
  'pre-validation': 'pre_validation',
  'post-validation': 'post_validation',
  'pre-commit': 'pre_commit',
  'post-commit': 'post_commit',
  'pre-escalation': 'pre_escalation',
  'pre-compact': 'pre_compact',
  'on-error': 'on_error',
  'on-complete': 'on_complete',
};

export interface DiscoveredHook {
  event: HookEvent;
  path: string;
}

export async function discoverHookModules(projectDir: string): Promise<DiscoveredHook[]> {
  const hooksDir = join(projectDir, '.diptych', 'hooks');
  let entries: string[];
  try {
    entries = await readdir(hooksDir);
  } catch {
    return [];
  }

  const hooks: DiscoveredHook[] = [];
  for (const entry of entries.toSorted()) {
    const ext = extname(entry);
    if (ext !== '.js' && ext !== '.ts') continue;

    const event = HOOK_EVENT_BY_FILE_NAME[basename(entry, ext)];
    if (!event) continue;

    hooks.push({ event, path: join(hooksDir, entry) });
  }
  return hooks;
}

export async function resolveHooksConfig(projectDir: string, hooks: HooksConfig | undefined): Promise<HooksConfig | undefined> {
  return mergeDiscoveredHooks(hooks, await discoverHookModules(projectDir));
}

export function mergeDiscoveredHooks(
  hooks: HooksConfig | undefined,
  discovered: readonly DiscoveredHook[],
): HooksConfig | undefined {
  if (discovered.length === 0) return hooks;

  const merged: HooksConfig = hooks ? { ...hooks } : {};
  for (const hook of discovered) {
    merged[hook.event] = [
      ...(merged[hook.event] ?? []),
      discoveredModuleEntry(hook.path),
    ];
  }
  return merged;
}

function discoveredModuleEntry(path: string): HookModuleEntry {
  return HookModuleEntrySchema.parse({ kind: 'module', path, on_failure: 'warn' });
}
