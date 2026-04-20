import { resolve, isAbsolute } from 'node:path';
import { pathToFileURL } from 'node:url';
import type { EngineEvent } from '../events/types.js';
import type { HookOutcome, HookContext } from './types.js';

export type HookModuleFunction = (event: EngineEvent, ctx: HookContext) => Promise<HookOutcome> | HookOutcome;

export type LoadResult =
  | { ok: true; fn: HookModuleFunction }
  | { ok: false; reason: string };

/**
 * Dynamically import a hook module by relative or absolute path.
 * ESM import() is cached by URL — the module is loaded once per process lifetime.
 * Returns the default export (must be a function) or an error reason.
 */
export async function loadHookModule(modulePath: string, projectDir: string): Promise<LoadResult> {
  const absPath = isAbsolute(modulePath) ? modulePath : resolve(projectDir, modulePath);
  const url = pathToFileURL(absPath).href;
  try {
    const mod: unknown = await import(url);
    if (mod === null || typeof mod !== 'object') {
      return { ok: false, reason: 'module did not export an object' };
    }
    const fn = (mod as { default?: unknown }).default;
    if (typeof fn !== 'function') {
      return { ok: false, reason: 'module default export is not a function' };
    }
    return { ok: true, fn: fn as HookModuleFunction };
  } catch (err) {
    return { ok: false, reason: err instanceof Error ? err.message : String(err) };
  }
}
