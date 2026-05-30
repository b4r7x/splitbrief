import { pathToFileURL } from 'node:url';
import { resolve } from 'node:path';
import type { EngineEvent } from '../events/types.js';
import type { HookOutcome, HookContext } from './types.js';
import { toErrorMessage } from '../../utils/format-errors.js';
import { assertExistingPathConfined } from '../../lib/path-confinement.js';

export type HookModuleFunction = (
  event: EngineEvent,
  ctx: HookContext,
) => Promise<HookOutcome> | HookOutcome;

export type LoadResult =
  | { ok: true; fn: HookModuleFunction }
  | { ok: false; reason: string; error?: unknown };

export async function loadHookModule(modulePath: string, projectDir: string): Promise<LoadResult> {
  try {
    assertExistingPathConfined(modulePath, projectDir);
    const absPath = resolve(projectDir, modulePath);
    const url = pathToFileURL(absPath).href;
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
    return { ok: false, reason: toErrorMessage(err), error: err };
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
