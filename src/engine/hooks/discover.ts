import { readdir } from 'node:fs/promises';
import { basename, extname, join } from 'node:path';
import {
  HOOK_EVENTS,
  HookModuleEntrySchema,
  type HookEvent,
  type HookModuleEntry,
  type HooksConfig,
} from '../../core/schemas/hooks.js';
import { SPLITBRIEF_DIR } from '../../core/paths.js';

const HOOK_EVENT_BY_FILE_NAME = new Map<string, HookEvent>(
  HOOK_EVENTS.map((event) => [event.replaceAll('_', '-'), event]),
);

export interface DiscoveredHook {
  event: HookEvent;
  path: string;
}

export async function discoverHookModules(projectDir: string): Promise<DiscoveredHook[]> {
  const hooksDir = join(projectDir, SPLITBRIEF_DIR, 'hooks');
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

    const event = HOOK_EVENT_BY_FILE_NAME.get(basename(entry, ext));
    if (!event) continue;

    hooks.push({ event, path: join(SPLITBRIEF_DIR, 'hooks', entry) });
  }
  return hooks;
}

export async function resolveHooksConfig(
  projectDir: string,
  hooks: HooksConfig | undefined,
): Promise<HooksConfig | undefined> {
  return mergeDiscoveredHooks(hooks, await discoverHookModules(projectDir));
}

export function mergeDiscoveredHooks(
  hooks: HooksConfig | undefined,
  discovered: readonly DiscoveredHook[],
): HooksConfig | undefined {
  if (discovered.length === 0) return hooks;

  const merged: HooksConfig = hooks ? { ...hooks } : {};
  for (const hook of discovered) {
    merged[hook.event] = [...(merged[hook.event] ?? []), discoveredModuleEntry(hook.path)];
  }
  return merged;
}

function discoveredModuleEntry(path: string): HookModuleEntry {
  return HookModuleEntrySchema.parse({ kind: 'module', path, on_failure: 'warn' });
}
