import { resolve, isAbsolute } from 'node:path';
import { pathToFileURL } from 'node:url';
import type { EngineEvent } from '../events/types.js';
import type { HookOutcome, HookContext } from './types.js';

export type HookModuleFunction = (event: EngineEvent, ctx: HookContext) => Promise<HookOutcome> | HookOutcome;

export type LoadResult =
  | { ok: true; fn: HookModuleFunction }
  | { ok: false; reason: string; error?: unknown };

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
      return { ok: false, reason: invalidDefaultExportReason(absPath, undefined) };
    }
    const fn = 'default' in mod ? mod.default : undefined;
    if (!isHookModuleFunction(fn)) {
      return { ok: false, reason: invalidDefaultExportReason(absPath, fn) };
    }
    return { ok: true, fn };
  } catch (err) {
    return { ok: false, reason: err instanceof Error ? err.message : String(err), error: err };
  }
}

function isHookModuleFunction(value: unknown): value is HookModuleFunction {
  return typeof value === 'function';
}

function invalidDefaultExportReason(absPath: string, value: unknown): string {
  return `Hook module ${absPath} must export a default function; expected default function, got ${describeValue(value)}`;
}

function describeValue(value: unknown): string {
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'array';
  return typeof value;
}
